#!/usr/bin/env node

/**
 * macOS arm64 release staging.
 *
 * macOS lands on a release the Windows lane already published, because Apple's
 * notary queue has no upper bound and gating a release on it is what stalled
 * macOS distribution before. So this stages ONLY the macOS assets: touching the
 * Windows assets again would mean deleting and re-uploading files users can
 * already download.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function findUnique(files, basename) {
  const matches = files.filter((file) => path.basename(file) === basename);
  if (matches.length !== 1) fail(`Expected exactly one ${basename}, found ${matches.length}`);
  return matches[0];
}

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function metadata(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const version = lines.find((line) => /^version:\s*/.test(line));
  if (!version) fail(`${path.basename(file)} has no version`);
  const entries = lines.flatMap((line, index) => {
    const match = line.match(/^\s*-\s+url:\s*(.+)$/);
    if (!match) return [];
    const entry = { url: scalar(match[1]) };
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*-\s+url:/.test(lines[cursor]) || /^\S/.test(lines[cursor])) break;
      const sha512 = lines[cursor].match(/^\s+sha512:\s*(.+)$/);
      const size = lines[cursor].match(/^\s+size:\s*(\d+)$/);
      if (sha512) entry.sha512 = scalar(sha512[1]);
      if (size) entry.size = Number(size[1]);
    }
    return [entry];
  });
  if (!entries.length) fail(`${path.basename(file)} has no file entries`);
  return { version: scalar(version.replace(/^version:\s*/, "")), entries };
}

function names(version) {
  const zip = `PowerAI-${version}-mac-arm64.zip`;
  return [`PowerAI-${version}-mac-arm64.dmg`, zip, `${zip}.blockmap`, "latest-arm64-mac.yml", "latest-mac.yml"];
}

function prepare(buildDir, outputDir, version) {
  if (!versionPattern.test(version)) fail("Version must be exact semver");
  const files = filesUnder(buildDir);
  const source = findUnique(files, "latest-mac.yml");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  for (const basename of [
    `PowerAI-${version}-mac-arm64.dmg`,
    `PowerAI-${version}-mac-arm64.zip`,
    `PowerAI-${version}-mac-arm64.zip.blockmap`,
  ]) {
    fs.copyFileSync(findUnique(files, basename), path.join(outputDir, basename));
  }
  // electron-updater reads the arch-suffixed name; the unsuffixed one stays
  // for older clients that were built before the suffix existed.
  fs.copyFileSync(source, path.join(outputDir, "latest-arm64-mac.yml"));
  fs.copyFileSync(source, path.join(outputDir, "latest-mac.yml"));
}

function verify(outputDir, version) {
  if (!versionPattern.test(version)) fail("Version must be exact semver");
  const staged = filesUnder(outputDir).map((file) => path.basename(file)).sort();
  const expected = names(version).sort();
  if (staged.join("\n") !== expected.join("\n")) {
    fail(`macOS staging must contain exactly ${expected.join(", ")}; found ${staged.join(", ") || "nothing"}`);
  }
  const zip = `PowerAI-${version}-mac-arm64.zip`;
  for (const name of ["latest-arm64-mac.yml", "latest-mac.yml"]) {
    const parsed = metadata(path.join(outputDir, name));
    if (parsed.version !== version) fail(`${name} version ${parsed.version} does not match ${version}`);
    if (!parsed.entries.some((entry) => path.basename(entry.url) === zip)) {
      fail(`${name} does not reference ${zip}`);
    }
    for (const entry of parsed.entries) {
      const basename = path.basename(entry.url);
      if (basename !== entry.url) fail(`${name} contains a non-local asset URL: ${entry.url}`);
      const asset = path.join(outputDir, basename);
      if (!fs.existsSync(asset)) fail(`${name} references missing asset: ${basename}`);
      const digest = crypto.createHash("sha512").update(fs.readFileSync(asset)).digest("base64");
      if (!entry.sha512 || entry.sha512 !== digest) fail(`${name} has an invalid sha512 for ${basename}`);
      if (!Number.isSafeInteger(entry.size) || entry.size !== fs.statSync(asset).size) {
        fail(`${name} has an invalid size for ${basename}`);
      }
    }
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "prepare" && args.length === 3) prepare(args[0], args[1], args[2]);
  else if (command === "verify" && args.length === 2) verify(args[0], args[1]);
  else fail("Usage: macos-release.mjs prepare <build-dir> <output> <version> | verify <output> <version>");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
