import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "macos-release.mjs");
const version = "1.2.3";

function run(...args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function expectFailure(...args) {
  try {
    run(...args);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail(`Expected macos-release.mjs ${args[0]} to fail`);
}

function sha512(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function buildDir({ extraFile } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-macos-release-"));
  const build = path.join(directory, "build");
  fs.mkdirSync(build, { recursive: true });
  const dmg = path.join(build, `PowerAI-${version}-mac-arm64.dmg`);
  const zip = path.join(build, `PowerAI-${version}-mac-arm64.zip`);
  const blockmap = path.join(build, `PowerAI-${version}-mac-arm64.zip.blockmap`);
  fs.writeFileSync(dmg, "disk-image");
  fs.writeFileSync(zip, "update-archive");
  fs.writeFileSync(blockmap, "blocks");
  fs.writeFileSync(
    path.join(build, "latest-mac.yml"),
    [
      `version: ${version}`,
      "files:",
      `  - url: PowerAI-${version}-mac-arm64.zip`,
      `    sha512: ${sha512(zip)}`,
      `    size: ${fs.statSync(zip).size}`,
      `  - url: PowerAI-${version}-mac-arm64.dmg`,
      `    sha512: ${sha512(dmg)}`,
      `    size: ${fs.statSync(dmg).size}`,
      `path: PowerAI-${version}-mac-arm64.zip`,
      "",
    ].join("\n"),
  );
  if (extraFile) fs.writeFileSync(path.join(build, extraFile), "unexpected");
  return { directory, build, output: path.join(directory, "release") };
}

test("staging carries exactly the macOS assets and both updater manifests", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  assert.deepEqual(fs.readdirSync(output).sort(), [
    `PowerAI-${version}-mac-arm64.dmg`,
    `PowerAI-${version}-mac-arm64.zip`,
    `PowerAI-${version}-mac-arm64.zip.blockmap`,
    "latest-arm64-mac.yml",
    "latest-mac.yml",
  ]);
  run("verify", output, version);
});

test("the Windows assets a published release already carries are refused", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  // The whole point of staging macOS separately: these files are already
  // public, and re-uploading them would delete and replace live downloads.
  fs.writeFileSync(path.join(output, `PowerAI-${version}-win-x64.exe`), "installer");
  assert.match(expectFailure("verify", output, version), /must contain exactly/);
  fs.rmSync(path.join(output, `PowerAI-${version}-win-x64.exe`));
  fs.writeFileSync(path.join(output, "latest.yml"), "version: 1.2.3");
  assert.match(expectFailure("verify", output, version), /must contain exactly/);
});

test("a manifest that does not describe the staged archive is rejected", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  const manifest = path.join(output, "latest-arm64-mac.yml");
  fs.writeFileSync(
    manifest,
    fs.readFileSync(manifest, "utf8").replace(/sha512: .+/, "sha512: AAAA"),
  );
  assert.match(expectFailure("verify", output, version), /invalid sha512/);
});

test("a manifest for a different version is rejected", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  const manifest = path.join(output, "latest-mac.yml");
  fs.writeFileSync(
    manifest,
    fs.readFileSync(manifest, "utf8").replace(`version: ${version}`, "version: 9.9.9"),
  );
  assert.match(expectFailure("verify", output, version), /does not match/);
});

test("a manifest pointing off-release is rejected", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  const manifest = path.join(output, "latest-arm64-mac.yml");
  fs.writeFileSync(
    manifest,
    fs
      .readFileSync(manifest, "utf8")
      .replace(`url: PowerAI-${version}-mac-arm64.zip`, `url: https://example.test/PowerAI-${version}-mac-arm64.zip`),
  );
  assert.match(expectFailure("verify", output, version), /non-local asset URL|does not reference/);
});

test("a missing build artifact fails staging instead of publishing a partial set", () => {
  const { build, output } = buildDir();
  fs.rmSync(path.join(build, `PowerAI-${version}-mac-arm64.dmg`));
  assert.match(expectFailure("prepare", build, output, version), /Expected exactly one/);
});

test("stapling the disk image invalidates the manifest until it is synced", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  run("verify", output, version);

  // What `xcrun stapler staple` does to the dmg: same file, different bytes.
  const dmg = path.join(output, `PowerAI-${version}-mac-arm64.dmg`);
  fs.writeFileSync(dmg, "disk-image-with-stapled-ticket");
  assert.match(expectFailure("verify", output, version), /invalid sha512|invalid size/);

  run("sync-dmg", output, version);
  run("verify", output, version);
});

test("syncing refreshes only the disk image entry, never the archive's", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  const before = fs.readFileSync(path.join(output, "latest-mac.yml"), "utf8");
  const zipDigest = before.match(/sha512: (\S+)/)[1];

  fs.writeFileSync(path.join(output, `PowerAI-${version}-mac-arm64.dmg`), "restapled");
  run("sync-dmg", output, version);

  const after = fs.readFileSync(path.join(output, "latest-mac.yml"), "utf8");
  // The zip is never restapled: electron-updater's download must keep matching
  // the digest electron-builder measured.
  assert.equal(after.match(/sha512: (\S+)/)[1], zipDigest);
  run("verify", output, version);
});

test("syncing a manifest that never described the disk image is an error", () => {
  const { build, output } = buildDir();
  run("prepare", build, output, version);
  const file = path.join(output, "latest-arm64-mac.yml");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(new RegExp(`  - url: PowerAI-${version}-mac-arm64\\.dmg[\\s\\S]*?size: \\d+\n`), ""),
  );
  assert.match(expectFailure("sync-dmg", output, version), /no PowerAI.*\.dmg entry to refresh/);
});
