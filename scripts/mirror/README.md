# Release mirror

`powerai-release-mirror.py` runs on the release VPS at
`/usr/local/bin/powerai-release-mirror.py`, on a ten-minute cron
(`/etc/cron.d/powerai-mirror`) and by hand after a release. It pulls published
GitHub releases into the two channel directories the desktop app updates from.

It lived only on that box until 2026-08-31. It is kept here because it is the
only thing standing between a published release and every user's updater, and
because a script that exists on one machine is a script nobody can review.

## Deploying a change

```bash
# Configure this alias with the current release VPS host, port and identity in ~/.ssh/config.
release_host="${POWERAI_RELEASE_SSH_HOST:?Set the current release VPS SSH alias}"
scp scripts/mirror/powerai-release-mirror.py \
  "$release_host:/usr/local/bin/powerai-release-mirror.py"
ssh "$release_host" 'chmod 755 /usr/local/bin/powerai-release-mirror.py && /usr/local/bin/powerai-release-mirror.py'
```

Then inspect both channel fingerprints. Each contains the current tag and sorted
asset names/sizes, the current provenance digest, and a `retained-blockmaps-v1`
section listing historical blockmap names and their verified SHA-256 hashes:

```bash
ssh "$release_host" 'cat /var/www/powerai-releases/latest/.fingerprint /var/www/powerai-releases/dev/.fingerprint'
gh release view vX.Y.Z --repo dztabel-happy/powerai-releases \
  --json tagName,assets --jq '{tag: .tagName, assets: [.assets[] | {name, size}]}'
```

Compare each channel with its expected public release. Repeat the mirror and
comparison after macOS notarization appends assets: matching `.tag` files alone
cannot prove those later files are present. Fingerprints check the mirrored
asset set; the mirror separately verifies each provenance-listed file's SHA-256
before installing the channel directory.

After the first run of this version, check the old blockmap URL in the **target**
channel. For example, a client switching from stable to dev needs:

```bash
source_version="${POWERAI_UPDATE_SOURCE_VERSION:?Set the installed stable version}"
curl --fail --head "https://powerai.dztabel.com/releases/dev/PowerAI-${source_version}-win-x64.exe.blockmap"
```

Repeat for an available prior dev version, and for ARM64 when that source release
has an ARM64 installer. A retained version returns HTTP 200. Versions outside the
retention window can still update through the full-download fallback.

## Windows differential download history

The mirror keeps only historical `PowerAI-<version>-win-{x64,arm64}.exe.blockmap`
files, verified against their own release's provenance:

| Channel   | Historical releases retained                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `latest/` | The two most recent older stable releases with Windows blockmaps                                          |
| `dev/`    | The two most recent older releases with Windows blockmaps, plus the current stable release when different |

Selection uses one bounded GitHub catalog request for the latest 100 releases,
excluding drafts. This includes older stable releases even when recent dev
builds occupy the first 20 entries; releases beyond 100 entries are outside the
retention window. This adds at most four historical files to `latest/` and six to `dev/`; it does
not retain historical installers, ZIPs or channel metadata. Older blockmaps leave
the mirror when they fall outside the window. The existing `hold/` directory is
unchanged.

Every run fetches the small provenance documents needed for these releases.
An unchanged fingerprint skips asset downloads. A metadata/history-only refresh
rehashes existing assets before hard-linking them into staging, so unchanged
large installers are reused rather than downloaded or copied. Historical hashes
and the retention set are part of the fingerprint, including when an older
blockmap is replaced without changing its size.

Missing provenance, a missing historical checksum, an HTTP error or a digest
mismatch leaves the installed channel intact and makes the run fail. The script
validates the complete staging directory before the existing directory swap,
rolls back a failed rename, and restores the previous directory on the next run
if the process stopped between renames. Failed staging is cleaned up; an
unrestored backup is not pruned.

This fixes the missing old blockmap URLs for retained versions. A differential
download still needs the client's matching cached installer and working HTTP
Range requests. Clients with missing/stale caches, incompatible blockmaps or
versions outside the retention window continue to use electron-updater's
checksum-verified full download.

## Tests

```bash
node --test tests/*.test.mjs
```

The mirror tests run the real Python script against a local HTTP server and
temporary directories. They cover stable-to-dev and same-channel history,
bounded pruning, checksum failures, cache reuse, appended macOS assets and
recovery after an interrupted directory swap. They do not contact the VPS.

## Why a fingerprint, not a tag

`latest/` follows the newest stable release and `dev/` the newest of all, and a
channel used to be considered current when its `.tag` matched. That was true
while a release gained all of its assets at once. It stopped being true when
macOS started landing on a release the Windows lane had already published: the
tag never changes, so the macOS assets would never mirror. A channel is now
current only when its release assets, provenance digest and retained blockmap
hashes match the expected set.
