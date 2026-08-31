#!/usr/bin/env python3
"""Mirror the newest PowerAI builds into /var/www/powerai-releases.

Two channels, each a self-contained directory the client can point at:

  latest/  the newest STABLE release
  dev/     the newest build of all — a dev prerelease, or the stable release
           when that is newer, so a client on the dev channel always moves
           forward and never gets stranded behind a stable it cannot see.

Pull-based (no CI secrets on this box). Downloads into a staging dir, verifies
every asset against release-provenance.json sha256 hashes, then swaps the
channel directory atomically. Only these two directories are kept: this box has
single-digit GB free, so every other release is pruned.
"""
import fcntl
import hashlib
import json
import os
import shutil
import sys
import urllib.request

REPO_API = "https://api.github.com/repos/dztabel-happy/powerai-releases/releases?per_page=20"
DEST = "/var/www/powerai-releases"
CHANNELS = ("latest", "dev")
# A build someone was asked to install by hand, kept out of the channel
# churn: the dev channel only ever holds the newest build, so handing
# anyone a link to a specific one needs somewhere prune() will not sweep.
HOLD_DIR = "hold"
LOCK_PATH = "/run/powerai-release-mirror.lock"


def fetch(url, dest=None):
    req = urllib.request.Request(url, headers={"User-Agent": "powerai-mirror"})
    with urllib.request.urlopen(req, timeout=300) as response:
        if dest is None:
            return response.read()
        with open(dest, "wb") as handle:
            shutil.copyfileobj(response, handle)


def version_key(tag):
    """Sort key with correct semver ordering: 0.1.34-dev.1 < 0.1.34."""
    core, _, pre = tag.lstrip("v").partition("-")
    parts = [int(part) if part.isdigit() else 0 for part in core.split(".")]
    while len(parts) < 3:
        parts.append(0)
    if not pre:
        # A release outranks any prerelease of the same version.
        return (parts, 1, [])
    pre_parts = [(0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")]
    return (parts, 0, pre_parts)


def release_fingerprint(release):
    """What a channel directory would contain for this release.

    The tag alone is not enough: macOS assets are appended to a release the
    Windows lane already published, so the same tag legitimately gains files
    minutes to hours later. Keying only on the tag meant those never mirrored.
    """
    assets = sorted((asset["name"], asset["size"]) for asset in release["assets"])
    return release["tag_name"] + "\n" + "\n".join("%s:%d" % pair for pair in assets)


def current_fingerprint(channel):
    marker = os.path.join(DEST, channel, ".fingerprint")
    if not os.path.exists(marker):
        return None
    with open(marker) as handle:
        return handle.read().strip()


def current_tag(channel):
    tag_file = os.path.join(DEST, channel, ".tag")
    if not os.path.exists(tag_file):
        return None
    with open(tag_file) as handle:
        return handle.read().strip()


def mirror(release, channel):
    """Download, verify and atomically install one release into one channel."""
    tag = release["tag_name"]
    staging = os.path.join(DEST, ".staging-" + channel)
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)
    for asset in release["assets"]:
        print("downloading %s -> %s" % (asset["name"], channel), flush=True)
        fetch(asset["browser_download_url"], os.path.join(staging, asset["name"]))
    provenance_path = os.path.join(staging, "release-provenance.json")
    if not os.path.exists(provenance_path):
        print("no provenance in " + tag + "; refusing to mirror", file=sys.stderr)
        shutil.rmtree(staging, ignore_errors=True)
        return 1
    with open(provenance_path) as handle:
        provenance = json.load(handle)
    for name, expected in provenance["assets"].items():
        with open(os.path.join(staging, name), "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        if digest != expected:
            print("HASH MISMATCH for " + name + "; aborting mirror", file=sys.stderr)
            shutil.rmtree(staging, ignore_errors=True)
            return 1
    with open(os.path.join(staging, ".tag"), "w") as handle:
        handle.write(tag)
    # Written last, and only after every digest matched: a fingerprint present
    # in a channel directory means that exact asset set is installed there.
    with open(os.path.join(staging, ".fingerprint"), "w") as handle:
        handle.write(release_fingerprint(release))
    target = os.path.join(DEST, channel)
    backup = os.path.join(DEST, ".previous-" + channel)
    shutil.rmtree(backup, ignore_errors=True)
    if os.path.exists(target):
        os.rename(target, backup)
    os.rename(staging, target)
    shutil.rmtree(backup, ignore_errors=True)
    print("mirrored %s into %s" % (tag, channel))
    return 0


def prune():
    """Keep the two channel directories and nothing else."""
    for entry in os.listdir(DEST):
        if entry in CHANNELS or entry == HOLD_DIR:
            continue
        path = os.path.join(DEST, entry)
        print("pruning " + path, flush=True)
        shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)


def main():
    # One run at a time. The release flow refreshes the mirror by hand right
    # after a build, which is exactly when the ten-minute cron may also fire —
    # and the loser used to die halfway through a download, because prune()
    # deletes every directory that is not a channel, staging included.
    # Outside DEST on purpose: prune() removes everything in there that is
    # not a channel, and a lock file it deleted would let the next two runs
    # take different inodes and overlap anyway.
    lock = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another mirror run is in progress; leaving it to finish")
        return 0

    releases = [r for r in json.loads(fetch(REPO_API)) if not r.get("draft")]
    if not releases:
        return 0
    stable = max((r for r in releases if not r.get("prerelease")), key=lambda r: version_key(r["tag_name"]), default=None)
    newest = max(releases, key=lambda r: version_key(r["tag_name"]))

    status = 0
    for channel, release in (("latest", stable), ("dev", newest)):
        if release is None:
            continue
        if current_fingerprint(channel) == release_fingerprint(release).strip():
            continue
        status |= mirror(release, channel)
    prune()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
