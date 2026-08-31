import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "mirror", "powerai-release-mirror.py");

// The mirror runs on the VPS with no test harness of its own; these exercise
// the decision it makes about whether a channel is already up to date, which
// is where appended macOS assets used to be missed entirely.
function evaluate(expression, setup = "") {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, sys",
        `spec = importlib.util.spec_from_file_location("mirror", ${JSON.stringify(script)})`,
        "mirror = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mirror)",
        setup,
        `print(${expression})`,
      ].join("\n"),
    ],
    { encoding: "utf8" },
  ).trim();
}

const windowsOnly = JSON.stringify({
  tag_name: "v1.2.3",
  assets: [
    { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
    { name: "latest.yml", size: 10 },
  ],
});

const withMacos = JSON.stringify({
  tag_name: "v1.2.3",
  assets: [
    { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
    { name: "latest.yml", size: 10 },
    { name: "PowerAI-1.2.3-mac-arm64.dmg", size: 300 },
    { name: "latest-arm64-mac.yml", size: 12 },
  ],
});

test("appending macOS assets to a published release changes the fingerprint", () => {
  // The whole reason this exists: the tag is identical in both, and keying on
  // it left the macOS assets sitting on GitHub, never mirrored.
  const before = evaluate("mirror.release_fingerprint(before)", `before = ${windowsOnly}`);
  const after = evaluate("mirror.release_fingerprint(after)", `after = ${withMacos}`);
  assert.notEqual(before, after);
  assert.match(before, /^v1\.2\.3\n/);
  assert.match(after, /mac-arm64\.dmg:300/);
});

test("the same asset set fingerprints identically regardless of order", () => {
  const forward = evaluate("mirror.release_fingerprint(r)", `r = ${withMacos}`);
  const shuffled = evaluate(
    "mirror.release_fingerprint(r)",
    `r = ${JSON.stringify({
      tag_name: "v1.2.3",
      assets: [
        { name: "latest-arm64-mac.yml", size: 12 },
        { name: "PowerAI-1.2.3-mac-arm64.dmg", size: 300 },
        { name: "latest.yml", size: 10 },
        { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
      ],
    })}`,
  );
  assert.equal(forward, shuffled);
});

test("a replaced asset of a different size changes the fingerprint", () => {
  const original = evaluate("mirror.release_fingerprint(r)", `r = ${windowsOnly}`);
  const rebuilt = evaluate(
    "mirror.release_fingerprint(r)",
    `r = ${JSON.stringify({
      tag_name: "v1.2.3",
      assets: [
        { name: "PowerAI-1.2.3-win-x64.exe", size: 101 },
        { name: "latest.yml", size: 10 },
      ],
    })}`,
  );
  assert.notEqual(original, rebuilt);
});

test("the installed fingerprint is what decides whether a channel is current", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /if current_fingerprint\(channel\) == release_fingerprint\(release\)/);
  // Written after the digests are verified, so a half-installed channel never
  // looks up to date. (The first mention is the reader; the write is the one
  // that must come last.)
  assert.ok(
    source.indexOf("HASH MISMATCH") <
      source.indexOf('with open(os.path.join(staging, ".fingerprint")'),
  );
});
