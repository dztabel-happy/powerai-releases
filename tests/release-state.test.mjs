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
  assert.match(build, /retention-days: 1/);
  assert.match(build, /PowerAI-\$\{\{ needs\.guard\.outputs\.version \}\}-win-x64\.zip/);
  assert.match(build, /tests\/manual\/spreadsheet-preview-budget\/verify\.ts/);
  assert.match(build, /spreadsheet-preview-budget-windows/);
  // Build intermediates stay short-lived: only diagnosis evidence (3 days)
  // and the signed macOS app awaiting notarization (14 days) outlive their
  // run. The macOS exception is load-bearing — Apple's queue is unbounded,
  // and the finalizer fetches that artifact once the answer arrives.
  const retentions = build
    .split("\n")
    .map((line, index) => [line, index])
    .filter(([line]) => /retention-days: (?:[2-9]|[1-9][0-9]+)/.test(line))
    .map(([line, index]) => [
      line.trim(),
      build.split("\n").slice(Math.max(0, index - 6), index + 1).join("\n"),
    ]);
  assert.deepEqual(
    retentions.map(([line]) => line),
    ["retention-days: 3", "retention-days: 14"],
  );
  assert.match(retentions[0][1], /name: spreadsheet-preview-budget-windows/);
  assert.match(retentions[1][1], /name: macos-pending/);
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

  // The macOS lane must never gate the Windows publish: Apple's queue is
  // unbounded, and gating on it is what stalled macOS releases before.
  const macJob = build.slice(build.indexOf("\n  macos-arm64:"), build.indexOf("\n  mark-macos-pending:"));
  assert.ok(macJob.length > 0);
  assert.match(macJob, /needs: \[guard, approve\]/);
  const windowsPublish = build.slice(build.indexOf("\n  publish-windows:"));
  assert.doesNotMatch(windowsPublish.split("\n").slice(0, 6).join("\n"), /macos/);
  assert.match(build, /POWERAI_NOTARIZATION_MODE: deferred/);
  assert.match(build, /xcrun notarytool submit/);
  assert.doesNotMatch(build, /notarytool submit[\s\S]{0,400}--wait/);
  // The published release carries the marker the finalizer looks for.
  assert.match(build, /pending\/notary-state\.json --clobber/);
  // The finalizer polls on a schedule because nothing else can tell us when
  // Apple answered; the release it completes is already published.
  assert.match(finalize, /schedule:/);
  assert.match(finalize, /workflow_dispatch:/);
  assert.match(finalize, /notarytool info/);
  assert.match(finalize, /--prepackaged/);
  assert.match(finalize, /xcrun stapler staple/);
  assert.match(finalize, /spctl --assess/);
  // It finds work by the marker asset, not by a draft release.
  assert.match(finalize, /index\("notary-state\.json"\)/);
  assert.doesNotMatch(finalize, /select\(\.draft == true/);
  // It fetches the submitted app from the build run that produced it.
  assert.match(finalize, /gh run download "\$BUILD_RUN_ID"/);
  // The artifact carries its own notary-state.json; extracting it over the
  // marker downloaded from the release would fail the run and, before this
  // was separated, be misread as an expired artifact.
  assert.match(finalize, /artifact_dir="\$RUNNER_TEMP\/submitted"/);
  assert.doesNotMatch(finalize, /gh run download[^\n]*RUNNER_TEMP\/pending/);
  // Expiry is what the API says, not any download failure.
  assert.match(finalize, /actions\/runs\/\$BUILD_RUN_ID\/artifacts/);
  // macOS appends to a published release: it must never restage or re-upload
  // the Windows assets, and must not re-assert the release pointer.
  assert.match(finalize, /scripts\/macos-release\.mjs prepare/);
  assert.match(finalize, /scripts\/macos-release\.mjs sync-dmg/);
  assert.match(finalize, /scripts\/macos-release\.mjs verify/);
  // A downloaded disk image is assessed on its own, and electron-builder does
  // not sign the container — so the dmg carries its own notarization, and the
  // staple that follows must happen before the manifest is measured.
  assert.match(finalize, /notarytool submit "\$RUNNER_TEMP\/final-mac[^\n]*\n[\s\S]{0,400}?--wait/);
  assert.ok(
    finalize.indexOf('stapler staple "$RUNNER_TEMP/final-mac') < finalize.indexOf("macos-release.mjs prepare"),
  );
  assert.ok(finalize.indexOf("macos-release.mjs sync-dmg") < finalize.indexOf("macos-release.mjs verify"));
  assert.doesNotMatch(finalize, /assets\.mjs (?:prepare|provenance|verify)/);
  assert.doesNotMatch(finalize, /gh release edit[^\n]*--latest/);
  assert.doesNotMatch(finalize, /gh release edit[^\n]*--prerelease/);
  // Every gh release call names the repository, like the build workflow's do.
  assert.deepEqual(
    finalize
      .split("\n")
      .filter((line) => line.includes("gh release ") && !line.trim().startsWith("#"))
      .filter((line) => !line.includes("--repo")),
    [],
  );
  // A newer release still waiting on Apple must not starve an older answered one.
  assert.match(finalize, /for tag in \$candidates; do/);
  // The release pointer belongs to whoever published the release. macOS only
  // appends assets and rewrites the notes; re-asserting --latest here would
  // hand it to whichever release finishes notarization last, which is not the
  // newest one. (The mirror keys off the prerelease flag and the version, so
  // it is unaffected either way — the pointer this protects is the one humans
  // and the GitHub API see.)
  assert.match(finalize, /gh release edit "\$TAG" --repo "\$GITHUB_REPOSITORY" --notes-file/);
  // The poller runs on a schedule, so every terminal outcome must remove the
  // marker. A marker left on a release that can never be finished becomes a
  // failing run every 30 minutes, forever.
  assert.match(finalize, /drop_marker\n\s+exit 1/);
  assert.match(finalize, /macOS artifact expired/);
  assert.doesNotMatch(`${build}\n${finalize}`, /uses: [^\n]+@v[0-9]/);
});

test("Windows release assets are exact, self-consistent, and tamper evident", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-windows-release-"));
  const artifacts = path.join(directory, "artifacts", "windows-x64");
  const output = path.join(directory, "release");
  const version = "1.2.3";
  const installer = Buffer.from("installer");
  const blockmap = Buffer.from("blockmap");
  const archive = Buffer.from("staged-zip");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe`), installer);
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe.blockmap`), blockmap);
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.zip`), archive);
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

  const manifest = JSON.parse(fs.readFileSync(path.join(output, "powerai-staged-update.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, version);
  assert.equal(manifest.zip.name, `PowerAI-${version}-win-x64.zip`);
  assert.equal(manifest.zip.sha512, sha512(archive));
  assert.equal(manifest.zip.size, archive.length);
  const provenanceAssets = JSON.parse(
    fs.readFileSync(path.join(output, "release-provenance.json"), "utf8"),
  ).assets;
  assert.ok(provenanceAssets[`PowerAI-${version}-win-x64.zip`]);
  assert.ok(provenanceAssets["powerai-staged-update.json"]);

  fs.appendFileSync(path.join(output, `PowerAI-${version}-win-x64.exe`), "tampered");
  assert.throws(() => execFileSync(process.execPath, [windowsScript, "verify", output, version], { stdio: "ignore" }));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("staged zip tampering is detected by verification", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-staged-zip-"));
  const artifacts = path.join(directory, "artifacts", "windows-x64");
  const output = path.join(directory, "release");
  const version = "1.2.3";
  const installer = Buffer.from("installer");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe`), installer);
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.exe.blockmap`), Buffer.from("blockmap"));
  fs.writeFileSync(path.join(artifacts, `PowerAI-${version}-win-x64.zip`), Buffer.from("staged-zip"));
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

  fs.appendFileSync(path.join(output, `PowerAI-${version}-win-x64.zip`), "tampered");
  assert.throws(() => execFileSync(process.execPath, [windowsScript, "verify", output, version], { stdio: "ignore" }));
  fs.rmSync(directory, { recursive: true, force: true });
});
