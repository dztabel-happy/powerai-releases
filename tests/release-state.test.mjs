import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/release-state.mjs");

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
  assert.match(build, /needs: \[guard, approve, windows-x64\]/);
  assert.match(build, /POWERAI_NOTARIZATION_MODE: deferred/);
  assert.match(
    build,
    /gh release create "\$tag" --repo "\$GITHUB_REPOSITORY" --draft/,
  );
  assert.doesNotMatch(build, /notarytool submit[^\n]*--wait/);
  assert.match(finalize, /schedule:/);
  assert.match(finalize, /notarytool info/);
  assert.match(finalize, /--prepackaged/);
  assert.match(finalize, /gh release edit "\$TAG" --draft=false --latest/);
  assert.doesNotMatch(`${build}\n${finalize}`, /uses: [^\n]+@v[0-9]/);
});
