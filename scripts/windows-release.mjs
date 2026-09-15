#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;

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

function hash(file, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
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
  if (!version) fail("latest.yml has no version");
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
  if (!entries.length) fail("latest.yml has no file entries");
  return { version: scalar(version.replace(/^version:\s*/, "")), entries };
}

const updateMetadata = (arch) => arch === "arm64" ? "latest-win-arm64.yml" : "latest.yml";
const stagedManifest = (arch) => arch === "arm64" ? "powerai-staged-update-arm64.json" : "powerai-staged-update.json";
const architectures = (target = "x64") => {
  if (target === "all") return ["x64", "arm64"];
  if (target === "x64" || target === "arm64") return [target];
  fail(`Unsupported Windows architecture: ${target}`);
};

function names(version, arch) {
  const installer = `PowerAI-${version}-win-${arch}.exe`;
  return [installer, `${installer}.blockmap`, updateMetadata(arch), `PowerAI-${version}-win-${arch}.zip`];
}

/**
 * Sidecar consumed by the desktop staged updater: it downloads and verifies
 * the zip against this manifest, pre-extracts it while the app runs, and
 * swaps directories at restart instead of running the NSIS installer.
 */
function writeStagedManifest(directory, version, arch) {
  const zipName = `PowerAI-${version}-win-${arch}.zip`;
  const zipPath = path.join(directory, zipName);
  fs.writeFileSync(
    path.join(directory, stagedManifest(arch)),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version,
        zip: { name: zipName, sha512: hash(zipPath, "sha512", "base64"), size: fs.statSync(zipPath).size },
      },
      null,
      2,
    )}\n`,
  );
}

function verifyStagedManifest(directory, version, arch) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, stagedManifest(arch)), "utf8"));
  const zipName = `PowerAI-${version}-win-${arch}.zip`;
  if (manifest.schemaVersion !== 1) fail("Staged manifest has an invalid schema version");
  if (manifest.version !== version) fail(`Staged manifest version ${manifest.version} does not match ${version}`);
  if (manifest.zip?.name !== zipName) fail(`Staged manifest does not reference ${zipName}`);
  const zipPath = path.join(directory, zipName);
  if (manifest.zip.sha512 !== hash(zipPath, "sha512", "base64")) fail("Staged manifest zip sha512 does not match");
  if (manifest.zip.size !== fs.statSync(zipPath).size) fail("Staged manifest zip size does not match");
}

function verifyMetadata(directory, version, arch) {
  const installer = names(version, arch)[0];
  const value = metadata(path.join(directory, updateMetadata(arch)));
  if (value.version !== version) fail(`latest.yml version ${value.version} does not match ${version}`);
  const entry = value.entries.find((candidate) => candidate.url === installer);
  if (!entry) fail(`latest.yml does not reference ${installer}`);
  const file = path.join(directory, installer);
  if (entry.sha512 !== hash(file, "sha512", "base64")) fail("latest.yml installer sha512 does not match");
  if (entry.size !== fs.statSync(file).size) fail("latest.yml installer size does not match");
  verifyStagedManifest(directory, version, arch);
}

function prepare(artifacts, output, version, target = "x64") {
  if (!versionPattern.test(version)) fail("Invalid release version");
  const arches = architectures(target);
  const files = filesUnder(artifacts);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const arch of arches) {
    for (const name of names(version, arch)) {
      // electron-builder emits latest.yml per isolated Windows build. Rename
      // only ARM64's copy, before merging; never overwrite x64's metadata.
      const source = name === updateMetadata(arch)
        ? path.join(path.dirname(findUnique(files, names(version, arch)[0])), "latest.yml")
        : findUnique(files, name);
      fs.copyFileSync(source, path.join(output, name));
    }
    writeStagedManifest(output, version, arch);
    verifyMetadata(output, version, arch);
  }
}

function assetHashes(directory) {
  return Object.fromEntries(
    filesUnder(directory)
      .filter((file) => path.basename(file) !== "release-provenance.json")
      .map((file) => [path.basename(file), hash(file, "sha256", "hex")])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function provenance(directory, version, desktopCommit, agentCommit, workflowRun, target = "x64") {
  if (!versionPattern.test(version)) fail("Invalid release version");
  if (!commitPattern.test(desktopCommit)) fail("Invalid desktop commit");
  if (!commitPattern.test(agentCommit)) fail("Invalid agent commit");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(workflowRun)) {
    fail("Invalid workflow run URL");
  }
  fs.writeFileSync(
    path.join(directory, "release-provenance.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version,
        platform: target === "all" ? "windows-x64-arm64" : `windows-${architectures(target)[0]}`,
        signing: "unsigned-internal",
        desktopCommit,
        agentCommit,
        workflowRun,
        assets: assetHashes(directory),
      },
      null,
      2,
    )}\n`,
  );
}

function verify(directory, version, target = "x64") {
  const arches = architectures(target);
  const expected = [...arches.flatMap((arch) => [...names(version, arch), stagedManifest(arch)]), "release-provenance.json"].sort();
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Release directory contains missing or unexpected files");
  for (const arch of arches) verifyMetadata(directory, version, arch);
  const value = JSON.parse(fs.readFileSync(path.join(directory, "release-provenance.json"), "utf8"));
  if (value.schemaVersion !== 1 || value.version !== version || value.platform !== (target === "all" ? "windows-x64-arm64" : `windows-${arches[0]}`)) {
    fail("Invalid release provenance identity");
  }
  if (value.signing !== "unsigned-internal") fail("Invalid Windows signing declaration");
  if (!commitPattern.test(value.desktopCommit) || !commitPattern.test(value.agentCommit)) {
    fail("Invalid release source commits");
  }
  if (JSON.stringify(value.assets) !== JSON.stringify(assetHashes(directory))) {
    fail("Release provenance asset hashes do not match");
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "prepare" && [3, 4].includes(args.length)) prepare(...args);
else if (command === "provenance" && [5, 6].includes(args.length)) provenance(...args);
else if (command === "verify" && [2, 3].includes(args.length)) verify(...args);
else fail("Usage: windows-release.mjs <prepare|provenance|verify> [arguments]");
