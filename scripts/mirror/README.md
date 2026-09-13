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

Then inspect both channel fingerprints. Each contains the tag followed by the
sorted asset names and sizes:

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

## Why a fingerprint, not a tag

`latest/` follows the newest stable release and `dev/` the newest of all, and a
channel used to be considered current when its `.tag` matched. That was true
while a release gained all of its assets at once. It stopped being true when
macOS started landing on a release the Windows lane had already published: the
tag never changes, so the macOS assets would never mirror. A channel is now
current only when its installed asset set — names and sizes — matches the
release's.
