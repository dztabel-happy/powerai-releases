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
scp -P 56227 -i ~/.ssh/id_ed25519 scripts/mirror/powerai-release-mirror.py \
  root@207.57.132.199:/usr/local/bin/powerai-release-mirror.py
ssh hk-relay 'chmod 755 /usr/local/bin/powerai-release-mirror.py && /usr/local/bin/powerai-release-mirror.py'
```

Then check both channels report the tags you expect:

```bash
ssh hk-relay 'cat /var/www/powerai-releases/latest/.tag /var/www/powerai-releases/dev/.tag'
```

## Why a fingerprint, not a tag

`latest/` follows the newest stable release and `dev/` the newest of all, and a
channel used to be considered current when its `.tag` matched. That was true
while a release gained all of its assets at once. It stopped being true when
macOS started landing on a release the Windows lane had already published: the
tag never changes, so the macOS assets would never mirror. A channel is now
current only when its installed asset set — names and sizes — matches the
release's.
