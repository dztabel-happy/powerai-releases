#!/usr/bin/env python3
"""Mirror the newest PowerAI builds into /var/www/powerai-releases.

Two channels, each a self-contained directory the client can point at:

  latest/  the newest STABLE release
  dev/     the newest build of all — a dev prerelease, or the stable release
           when that is newer, so a client on the dev channel always moves
           forward and never gets stranded behind a stable it cannot see.

Pull-based (no CI secrets on this box). Downloads into a staging dir, verifies
every asset against release-provenance.json sha256 hashes, then swaps the
channel directory. Each channel also keeps a bounded set of verified historical
Windows blockmaps; historical installers are never retained.
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request

REPO_API = "https://api.github.com/repos/dztabel-happy/powerai-releases/releases?per_page=100"
DEST = "/var/www/powerai-releases"
CHANNELS = ("latest", "dev")
HISTORY_RELEASES = 2
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


def windows_blockmaps(release):
    version = release["tag_name"].removeprefix("v")
    names = {"PowerAI-%s-win-%s.exe.blockmap" % (version, arch) for arch in ("x64", "arm64")}
    return [asset for asset in release["assets"] if asset["name"] in names]


def history_releases(releases, release, channel, stable):
    older = sorted(
        (r for r in releases if version_key(r["tag_name"]) < version_key(release["tag_name"])
         and (channel == "dev" or not r.get("prerelease")) and windows_blockmaps(r)),
        key=lambda r: version_key(r["tag_name"]), reverse=True,
    )[:HISTORY_RELEASES]
    # A stable client opting into dev needs its old blockmap in the dev URL,
    # even after enough prereleases have displaced stable from the recent two.
    if channel == "dev" and stable and stable["tag_name"] != release["tag_name"] and stable not in older:
        older.append(stable)
    return older


def read_provenance(release, cache):
    tag = release["tag_name"]
    if tag not in cache:
        asset = next((a for a in release["assets"] if a["name"] == "release-provenance.json"), None)
        if asset is None:
            raise ValueError("no provenance in " + tag + "; refusing to mirror")
        body = fetch(asset["browser_download_url"])
        checksums = json.loads(body)["assets"]
        if not isinstance(checksums, dict) or any(
            os.path.basename(name) != name or name in (".", "..")
            or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
            for name, digest in checksums.items()
        ):
            raise ValueError("invalid provenance in " + tag)
        cache[tag] = (body, checksums)
    return cache[tag]


def file_digest(file):
    digest = hashlib.sha256()
    with open(file, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_asset(asset, staging, expected=None):
    name = asset["name"]
    if os.path.basename(name) != name or name in (".", ".."):
        raise ValueError("invalid asset name: " + name)
    target = os.path.join(staging, name)
    # Rehash before linking: adding history or notarized macOS assets should not
    # download/copy hundreds of MB of unchanged installers on this small VPS.
    for channel in CHANNELS:
        existing = os.path.join(DEST, channel, name)
        if expected and os.path.isfile(existing) and file_digest(existing) == expected:
            os.link(existing, target)
            return
    print("downloading " + name, flush=True)
    fetch(asset["browser_download_url"], target)
    if expected and file_digest(target) != expected:
        raise ValueError("HASH MISMATCH for " + name + "; aborting mirror")


def mirror(release, channel, provenance, blockmaps, fingerprint):
    """Verify a complete staging directory before replacing a channel."""
    tag = release["tag_name"]
    staging = os.path.join(DEST, ".staging-" + channel)
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)
    if set(provenance[1]) - {asset["name"] for asset in release["assets"]}:
        raise ValueError("provenance references missing release assets in " + tag)
    with open(os.path.join(staging, "release-provenance.json"), "wb") as handle:
        handle.write(provenance[0])
    for asset in release["assets"]:
        if asset["name"] != "release-provenance.json":
            stage_asset(asset, staging, provenance[1].get(asset["name"]))
    for asset, expected in blockmaps:
        stage_asset(asset, staging, expected)
    with open(os.path.join(staging, ".tag"), "w") as handle:
        handle.write(tag)
    # Written last, and only after every digest matched: a fingerprint present
    # in a channel directory means that exact asset set is installed there.
    with open(os.path.join(staging, ".fingerprint"), "w") as handle:
        handle.write(fingerprint)
    target = os.path.join(DEST, channel)
    backup = os.path.join(DEST, ".previous-" + channel)
    shutil.rmtree(backup, ignore_errors=True)
    if os.path.exists(target):
        os.rename(target, backup)
    try:
        os.rename(staging, target)
    except OSError:
        if os.path.exists(backup):
            os.rename(backup, target)
        raise
    shutil.rmtree(backup, ignore_errors=True)
    print("mirrored %s into %s" % (tag, channel))
    return 0


def prune():
    """Keep channels, pinned builds and any backup still needed for recovery."""
    for entry in os.listdir(DEST):
        if entry in CHANNELS or entry == HOLD_DIR:
            continue
        if entry in {".previous-" + channel for channel in CHANNELS}:
            if not os.path.exists(os.path.join(DEST, entry.removeprefix(".previous-"))):
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

    # Recover if a prior process stopped between the two directory renames.
    # Do this before any HTTP requests, and before prune can remove the backup.
    for channel in CHANNELS:
        target = os.path.join(DEST, channel)
        backup = os.path.join(DEST, ".previous-" + channel)
        if not os.path.exists(target) and os.path.exists(backup):
            os.rename(backup, target)

    releases = [r for r in json.loads(fetch(REPO_API)) if not r.get("draft")]
    if not releases:
        return 0
    stable = max((r for r in releases if not r.get("prerelease")), key=lambda r: version_key(r["tag_name"]), default=None)
    newest = max(releases, key=lambda r: version_key(r["tag_name"]))

    status = 0
    provenance_cache = {}
    for channel, release in (("latest", stable), ("dev", newest)):
        if release is None:
            continue
        try:
            provenance = read_provenance(release, provenance_cache)
            blockmaps = [
                (asset, read_provenance(old, provenance_cache)[1][asset["name"]])
                for old in history_releases(releases, release, channel, stable)
                for asset in windows_blockmaps(old)
            ]
            fingerprint = "\n".join([
                release_fingerprint(release),
                "provenance-sha256:" + hashlib.sha256(provenance[0]).hexdigest(),
                "retained-blockmaps-v1",
                *sorted(asset["name"] + ":" + expected for asset, expected in blockmaps),
            ])
            if current_fingerprint(channel) == fingerprint:
                continue
            status |= mirror(release, channel, provenance, blockmaps, fingerprint)
        except (OSError, ValueError, KeyError) as error:
            print("cannot mirror %s: %s" % (channel, error), file=sys.stderr)
            shutil.rmtree(os.path.join(DEST, ".staging-" + channel), ignore_errors=True)
            status = 1
    prune()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
