import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/release-state.mjs");
const windowsScript = path.join(root, "scripts/windows-release.mjs");

function sha512(value) {
  return crypto.createHash("sha512").update(value).digest("base64");
}

test("release state is immutable and validated", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "powerai-release-state-"),
  );
  const state = path.join(directory, "notary-state.json");
  execFileSync(process.execPath, [
    script,
    "create",
    state,
    "1.2.3",
    "a".repeat(40),
    "b".repeat(40),
    "6fdde768-2206-44e0-b412-ea68378b77a5",
    "https://github.com/dztabel-happy/powerai-releases/actions/runs/1",
  ]);
  execFileSync(process.execPath, [script, "verify", state]);
  assert.equal(
    execFileSync(process.execPath, [script, "get", state, "version"], {
      encoding: "utf8",
    }),
    "1.2.3",
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("release workflows keep private source and credentials behind manual release gates", () => {
  const build = fs.readFileSync(
    path.join(root, ".github/workflows/build-release.yml"),
    "utf8",
  );
  const finalize = fs.readFileSync(
    path.join(root, ".github/workflows/finalize-notarization.yml"),
    "utf8",
  );
  assert.doesNotMatch(build, /pull_request:|push:/);
  assert.match(build, /test "\$GITHUB_REF_NAME" = main/);
  assert.match(build, /environment: release-approval/);
  assert.match(build, /needs: \[guard, windows-x64\]/);
  assert.match(build, /scripts\/windows-release\.mjs prepare/);
  assert.match(
    build,
    /gh release create "\$tag" --repo "\$GITHUB_REPOSITORY" --draft/,
  );
  assert.match(build, /diff -u "\$RUNNER_TEMP\/local-hashes\.txt" "\$RUNNER_TEMP\/remote-hashes\.txt"/);
  assert.match(build, /gh release edit "\$tag" --repo "\$GITHUB_REPOSITORY" --draft=false --latest/);
  assert.match(
    build,
    /bun install --cwd powerai-agent --filter '\.\/packages\/opencode' --filter '\.\/packages\/app' --frozen-lockfile/,
  );
  assert.doesNotMatch(build, /bun install --cwd powerai-agent --frozen-lockfile/);
  assert.doesNotMatch(build, /windows-update-acceptance:|tests\/manual\/auto-update\/verify\.mjs/);
  assert.doesNotMatch(build, /cleanup-failed-candidate:|Withdraw failed Windows candidate/);
  assert.deepEqual(
    build
      .split("\n")
      .filter((line) => line.includes("gh release ") && !line.trim().startsWith("#"))
      .filter((line) => !line.includes("--repo")),
    [],
  );
  assert.doesNotMatch(build, /macos-arm64:|notarytool|APPLE_|MAC_CSC/);
  assert.doesNotMatch(finalize, /schedule:/);
  assert.match(finalize, /workflow_dispatch:/);
  assert.match(finalize, /notarytool info/);
  assert.match(finalize, /--prepackaged/);
  assert.match(finalize, /gh release edit "\$TAG" --draft=false --latest/);
  assert.doesNotMatch(`${build}\n${finalize}`, /uses: [^\n]+@v[0-9]/);
});

test("Windows release assets are exact, self-consistent, and tamper evident", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-windows-release-"));
  const artifacts = path.join(directory, "artifacts", "windows-x64");
  const output = path.join(directory, "release");
  const version = "1.2.3";
  const installer = Buffer.from("installer");
  const blockmap = Buffer.from("blockmap");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe`), installer);
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe.blockmap`), blockmap);
  fs.writeFileSync(
    path.join(artifacts, "latest.yml"),
    [
      `version: ${version}`,
      "files:",
      `  - url: PowerAI-${version}-win-x64.exe`,
      `    sha512: ${sha512(installer)}`,
      `    size: ${installer.length}`,
      `path: PowerAI-${version}-win-x64.exe`,
      `sha512: ${sha512(installer)}`,
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [windowsScript, "prepare", path.join(directory, "artifacts"), output, version]);
  execFileSync(process.execPath, [
    windowsScript,
    "provenance",
    output,
    version,
    "a".repeat(40),
    "b".repeat(40),
    "https://github.com/dztabel-happy/powerai-releases/actions/runs/1",
  ]);
  execFileSync(process.execPath, [windowsScript, "verify", output, version]);

  fs.appendFileSync(path.join(output, `PowerAI-${version}-win-x64.exe`), "tampered");
  assert.throws(() => execFileSync(process.execPath, [windowsScript, "verify", output, version], { stdio: "ignore" }));
  fs.rmSync(directory, { recursive: true, force: true });
});
