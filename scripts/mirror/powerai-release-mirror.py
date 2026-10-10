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
Windows blockmaps and the last complete Windows ARM64 feed when a release
omits that architecture. Original release provenance is retained unchanged.
"""
import base64
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
ARM64_PROVENANCE = "release-provenance-win-arm64.json"
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


def parse_provenance(body, tag):
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("invalid provenance in " + tag)
    checksums = value.get("assets")
    if value.get("version") != tag.removeprefix("v") or not isinstance(checksums, dict) or any(
        os.path.basename(name) != name or name in (".", "..")
        or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
        for name, digest in checksums.items()
    ):
        raise ValueError("invalid provenance in " + tag)
    return body, checksums


def read_provenance(release, cache):
    tag = release["tag_name"]
    if tag not in cache:
        asset = next((a for a in release["assets"] if a["name"] == "release-provenance.json"), None)
        if asset is None:
            raise ValueError("no provenance in " + tag + "; refusing to mirror")
        cache[tag] = parse_provenance(fetch(asset["browser_download_url"]), tag)
    return cache[tag]


def file_digest(file, algorithm="sha256"):
    digest = hashlib.new(algorithm)
    with open(file, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def arm64_names(tag):
    stem = "PowerAI-%s-win-arm64" % tag.removeprefix("v")
    return ["latest-win-arm64.yml", "powerai-staged-update-arm64.json",
            stem + ".exe", stem + ".zip", stem + ".exe.blockmap"]


def advertises_arm64(release):
    return any(asset["name"] in ("latest-win-arm64.yml", "powerai-staged-update-arm64.json")
               or re.fullmatch(r"PowerAI-.+-win-arm64\.(exe(?:\.blockmap)?|zip)", asset["name"])
               for asset in release["assets"])


def arm64_fingerprint(tag, provenance):
    return "\n".join([
        "retained-arm64-v1", "source:" + tag,
        "provenance-sha256:" + hashlib.sha256(provenance[0]).hexdigest(),
        *sorted(name + ":" + provenance[1][name] for name in arm64_names(tag)),
    ])


def local_arm64(channel):
    """Recover one previously verified feed, including beyond the API window."""
    directory = os.path.join(DEST, channel)
    retained = os.path.join(directory, ARM64_PROVENANCE)
    source = retained if os.path.exists(retained) else os.path.join(directory, "release-provenance.json")
    if not os.path.isfile(source):
        return None
    with open(source, "rb") as handle:
        body = handle.read()
    version = json.loads(body).get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("invalid local ARM64 source version")
    tag = "v" + version
    provenance = parse_provenance(body, tag)
    names = arm64_names(tag)
    if not set(names) & provenance[1].keys():
        return None
    if not set(names) <= provenance[1].keys():
        raise ValueError("incomplete local ARM64 provenance")
    fingerprint = current_fingerprint(channel) or ""
    if source == retained:
        anchor = fingerprint.split("\nretained-blockmaps-v1", 1)[0]
        if not anchor.endswith("\n" + arm64_fingerprint(tag, provenance)):
            raise ValueError("local ARM64 provenance is not anchored by the fingerprint")
    elif current_tag(channel) != tag or ("\nprovenance-sha256:" + hashlib.sha256(body).hexdigest() + "\n") not in fingerprint:
        raise ValueError("local ARM64 source is not anchored by the fingerprint")
    return {"tag_name": tag, "provenance": provenance, "directory": directory}


def select_arm64(releases, release, channel, cache):
    """An omitted architecture retains its latest complete, eligible feed."""
    if advertises_arm64(release):
        # A damaged new ARM publication must never be hidden by an older feed.
        candidates = [release]
    else:
        candidates = [old for old in releases
                      if version_key(old["tag_name"]) <= version_key(release["tag_name"])
                      and (channel == "dev" or (not old.get("prerelease") and "-" not in old["tag_name"]))
                      and advertises_arm64(old)]
        local = local_arm64(channel)
        if local and version_key(local["tag_name"]) <= version_key(release["tag_name"]) and (channel == "dev" or "-" not in local["tag_name"]):
            candidates.append(local)
    if not candidates:
        return None
    # Catalog entries win equal versions: a fresh original provenance can gain
    # Mac assets without changing any ARM payload. Local state cannot mask it.
    selected = max(candidates, key=lambda old: version_key(old["tag_name"]))
    names = arm64_names(selected["tag_name"])
    if "directory" in selected:
        for name in names:
            file = os.path.join(selected["directory"], name)
            if not os.path.isfile(file) or file_digest(file) != selected["provenance"][1][name]:
                raise ValueError("local ARM64 file missing or HASH MISMATCH: " + name)
        validate_arm64_feed(selected["directory"], selected["tag_name"])
        return selected
    assets = {asset["name"]: asset for asset in selected["assets"]}
    provenance = read_provenance(selected, cache)
    if not set(names) <= assets.keys() or not set(names) <= provenance[1].keys():
        raise ValueError("incomplete ARM64 release: " + selected["tag_name"])
    return {"tag_name": selected["tag_name"], "provenance": provenance,
            "assets": [assets[name] for name in names]}


def validate_arm64_feed(directory, tag):
    version = tag.removeprefix("v")
    with open(os.path.join(directory, "latest-win-arm64.yml")) as handle:
        yaml = handle.read()
    def scalar(key):
        match = re.search(r"^" + key + r":\s*([^\r\n]+)", yaml, re.MULTILINE)
        return match[1].strip().strip("\"'") if match else None
    installer = "PowerAI-%s-win-arm64.exe" % version
    urls = [value.strip().strip("\"'") for value in re.findall(r"^\s*- url:\s*([^\r\n]+)", yaml, re.MULTILINE)]
    if scalar("version") != version or scalar("path") != installer or urls != [installer]:
        raise ValueError("ARM64 update metadata does not match source " + tag)
    installer_path = os.path.join(directory, installer)
    installer_hash = base64.b64encode(bytes.fromhex(file_digest(installer_path, "sha512"))).decode()
    hashes = [value.strip().strip("\"'") for value in re.findall(r"^\s*sha512:\s*([^\r\n]+)", yaml, re.MULTILINE)]
    entry_hashes = [value.strip().strip("\"'") for value in re.findall(r"^[ \t]+sha512:[ \t]*([^\r\n]+)", yaml, re.MULTILINE)]
    sizes = re.findall(r"^[ \t]+size:[ \t]*([^\r\n]+)", yaml, re.MULTILINE)
    if entry_hashes != [installer_hash] or any(value != installer_hash for value in hashes) or sizes != [str(os.path.getsize(installer_path))]:
        raise ValueError("ARM64 installer metadata checksum/size does not match " + tag)
    with open(os.path.join(directory, "powerai-staged-update-arm64.json")) as handle:
        manifest = json.load(handle)
    zip_name = "PowerAI-%s-win-arm64.zip" % version
    if not isinstance(manifest, dict) or not isinstance(manifest.get("zip"), dict):
        raise ValueError("invalid ARM64 staged manifest")
    zip_info = manifest["zip"]
    if manifest.get("schemaVersion") != 1 or manifest.get("version") != version or zip_info.get("name") != zip_name:
        raise ValueError("ARM64 staged manifest does not match source " + tag)
    zip_path = os.path.join(directory, zip_name)
    zip_hash = base64.b64encode(bytes.fromhex(file_digest(zip_path, "sha512"))).decode()
    if zip_info.get("size") != os.path.getsize(zip_path) or zip_info.get("sha512") != zip_hash:
        raise ValueError("ARM64 staged ZIP checksum/size does not match " + tag)


def stage_asset(asset, staging, expected=None):
    name = asset["name"]
    if os.path.basename(name) != name or name in (".", ".."):
        raise ValueError("invalid asset name: " + name)
    target = os.path.join(staging, name)
    if os.path.exists(target):
        if expected and file_digest(target) == expected:
            return
        raise ValueError("conflicting mirrored asset: " + name)
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


def mirror(release, channel, provenance, blockmaps, arm64, fingerprint):
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
        if asset["name"] == ARM64_PROVENANCE:
            raise ValueError("release uses reserved mirror provenance name")
        if asset["name"] != "release-provenance.json":
            stage_asset(asset, staging, provenance[1].get(asset["name"]))
    if arm64:
        for name in arm64_names(arm64["tag_name"]):
            if "directory" in arm64:
                os.link(os.path.join(arm64["directory"], name), os.path.join(staging, name))
            else:
                asset = next(asset for asset in arm64["assets"] if asset["name"] == name)
                stage_asset(asset, staging, arm64["provenance"][1][name])
        validate_arm64_feed(staging, arm64["tag_name"])
        with open(os.path.join(staging, ARM64_PROVENANCE), "wb") as handle:
            handle.write(arm64["provenance"][0])
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
            arm64 = select_arm64(releases, release, channel, provenance_cache)
            blockmaps = [
                (asset, read_provenance(old, provenance_cache)[1][asset["name"]])
                for old in history_releases(releases, release, channel, stable)
                for asset in windows_blockmaps(old)
            ]
            fingerprint = "\n".join([
                release_fingerprint(release),
                "provenance-sha256:" + hashlib.sha256(provenance[0]).hexdigest(),
                *([arm64_fingerprint(arm64["tag_name"], arm64["provenance"])] if arm64 else []),
                "retained-blockmaps-v1",
                *sorted(asset["name"] + ":" + expected for asset, expected in blockmaps),
            ])
            if current_fingerprint(channel) == fingerprint:
                continue
            status |= mirror(release, channel, provenance, blockmaps, arm64, fingerprint)
        except (OSError, ValueError, KeyError, TypeError) as error:
            print("cannot mirror %s: %s" % (channel, error), file=sys.stderr)
            shutil.rmtree(os.path.join(DEST, ".staging-" + channel), ignore_errors=True)
            status = 1
    prune()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
