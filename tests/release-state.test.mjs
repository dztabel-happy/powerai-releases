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

test("public update acceptance rejects unsafe dispatches and uploads only synthetic evidence", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/verify-desktop-update.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /pull_request:|push:|contents: write|gh release (?:create|upload|edit)/,
  );
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ inputs.desktop_ref \}\}/);
  assert.match(workflow, /node tests\/manual\/auto-update\/validate-release.mjs/);
  assert.match(workflow, /node tests\/manual\/auto-update\/verify.mjs/);
  const artifacts = workflow
    .split(/\n(?=      - )/)
    .filter((step) => step.includes("actions/upload-artifact@"));
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0], /retention-days: 90/);
  assert.match(artifacts[0], /name: update-acceptance-windows-\$\{\{ inputs.arch \}\}-/);
  assert.match(
    artifacts[0],
    /path: \|\n\s+\$\{\{ runner.temp \}\}\/update-acceptance-windows-\$\{\{ inputs.arch \}\}.json\n\s+\$\{\{ runner.temp \}\}\/update-acceptance-windows-\$\{\{ inputs.arch \}\}.json.diagnostics\/\n\s+\$\{\{ runner.temp \}\}\/installed-update-summary.json\n\s+\$\{\{ runner.temp \}\}\/source-installer-integrity.json\n\s+\$\{\{ runner.temp \}\}\/download\/release-provenance.json\s*$/,
  );
  assert.match(
    workflow,
    /arch:\n\s+description:[^\n]+\n\s+required: true\n\s+default: x64\n\s+type: choice\n\s+options:\n\s+- x64\n\s+- arm64/,
  );
  assert.match(
    workflow,
    /runs-on: \$\{\{ inputs.arch == 'arm64' && 'windows-11-arm' \|\| 'windows-2025' \}\}/,
  );
  assert.match(workflow, /TARGET_ARCH: \$\{\{ inputs.arch \}\}/);
  assert.match(workflow, /PowerAI-\$\(\$env:FROM_VERSION\)-win-\$\(\$env:TARGET_ARCH\).exe/);
  assert.doesNotMatch(workflow, /PowerAI-[^\n]*-win-x64.exe/);
  assert.match(workflow, /"--arch=\$env:TARGET_ARCH"/);
  assert.match(workflow, /"--channel-transition=\$env:CHANNEL_TRANSITION"/);
  assert.ok(
    workflow.indexOf("Restrict ARM64 runner temporary directory permissions") <
      workflow.indexOf("Checkout exact private Desktop harness"),
  );

  const guardStep = workflow
    .split(/\n(?=      - )/)
    .find((step) => step.includes("- name: Validate dispatch inputs"));
  const guard = guardStep
    .match(/run: \|\n([\s\S]*)/)[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-update-dispatch-"));
  const output = path.join(directory, "environment");
  const env = {
    ...process.env,
    GITHUB_ENV: output,
    GITHUB_REF_NAME: "main",
    DESKTOP_REF: "a".repeat(40),
    FROM_VERSION: "0.1.38",
    TO_VERSION: "0.1.39",
    TARGET_CHANNEL: "stable",
    TARGET_ARCH: "x64",
  };
  const run = (overrides = {}) => {
    fs.writeFileSync(output, "");
    execFileSync("bash", ["-c", guard], { env: { ...env, ...overrides }, stdio: "pipe" });
    return fs.readFileSync(output, "utf8");
  };
  try {
    assert.match(run(), /CHANNEL_TRANSITION=none/);
    assert.match(
      run({ TARGET_CHANNEL: "dev", TO_VERSION: "0.1.39-dev.24" }),
      /CHANNEL_TRANSITION=stable-to-dev/,
    );
    assert.match(
      run({
        TARGET_CHANNEL: "dev",
        TARGET_ARCH: "arm64",
        FROM_VERSION: "0.1.40-dev.2",
        TO_VERSION: "0.1.40-dev.3",
      }),
      /CHANNEL_TRANSITION=none/,
    );
    for (const overrides of [
      { GITHUB_REF_NAME: "other" },
      { DESKTOP_REF: "main" },
      { FROM_VERSION: "../source" },
      { TO_VERSION: "0.1.39; false" },
      { TARGET_CHANNEL: "other" },
      { TARGET_ARCH: "aarch64" },
      { TARGET_ARCH: "x64; false" },
    ]) {
      assert.throws(() => run(overrides), JSON.stringify(overrides));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
  assert.match(build, /PowerAI-\$\{\{ needs\.guard\.outputs\.version \}\}-win-\$\{\{ matrix.arch \}\}\.zip/);
  assert.match(build, /tests\/manual\/spreadsheet-preview-budget\/verify\.ts/);
  assert.match(build, /spreadsheet-preview-budget-windows/);
  // Published acceptance records outlive build intermediates. The signed app
  // awaiting Apple's answer remains a 14-day exception, not a public payload.
  const retentions = build.split(/\n(?=      - )/)
    .filter((step) => step.includes("actions/upload-artifact@"))
    .map((step) => [step.match(/^\s+name: (.+)$/m)?.[1], Number(step.match(/retention-days: (\d+)/)?.[1])]);
  assert.deepEqual(retentions, [
    ["release-plan", 90],
    ["spreadsheet-preview-budget-windows${{ matrix.evidence_suffix }}", 90],
    ["image-model-smoke-windows${{ matrix.evidence_suffix }}", 90],
    ["arm64-install-evidence", 90],
    ["titlebar-windows${{ matrix.evidence_suffix }}", 90],
    ["failure-continuity-windows${{ matrix.evidence_suffix }}", 90],
    ["build-acceptance-${{ matrix.arch }}", 90],
    ["windows-${{ matrix.arch }}", 1],
    ["macos-pending", 14],
    ["windows-mirror-readiness", 90],
    ["complete-mirror-readiness", 90],
    ["release-result-${{ inputs.version }}", 90],
  ]);
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
  // One reusable implementation owns installed verification; the build waits
  // for actual mirror readiness and supplies the frozen per-architecture source.
  assert.doesNotMatch(build, /tests\/manual\/auto-update\/verify\.mjs/);
  const installed = build.slice(build.indexOf("\n  installed-windows:"), build.indexOf("\n  complete-mirror-ready:"));
  assert.match(installed, /needs: \[guard, windows-mirror-ready\]/);
  assert.match(installed, /uses: \.\/\.github\/workflows\/verify-desktop-update\.yml/);
  assert.match(installed, /from_version: \$\{\{ matrix.from_version \}\}/);
  assert.match(installed, /target_channel: \$\{\{ needs.guard.outputs.channel \}\}/);
  assert.match(installed, /secrets: inherit/);
  assert.match(build, /group:.*'powerai-release-publish'/);
  assert.match(build, /cancel-in-progress: false/);
  assert.match(build, /gh workflow run finalize-notarization.yml/);
  assert.match(build, /scripts\/release-result.mjs acceptance release-result.json/);
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
  // A notarization ticket is not a signature: Gatekeeper assesses a downloaded
  // disk image against its primary signature, so the container is signed
  // before it is submitted.
  assert.match(finalize, /codesign --force --timestamp[\s\S]{0,200}mac-arm64\.dmg/);
  assert.ok(
    finalize.indexOf("codesign --force --timestamp") <
      finalize.indexOf('notarytool submit "$RUNNER_TEMP/final-mac'),
  );
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

test("every workflow step declares the variables its script actually reads", () => {
  // `set -u` turns a missing env var into a failure at the exact line that
  // needs it — after minutes of work, as a real release run showed. The
  // mapping between a step's script and its env block is easy to break when a
  // command moves between steps, so it is checked here rather than in a run.
  const ambient = new Set([
    "VERSION", "TAG", "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITHUB_RUN_ID",
    "GITHUB_REF_NAME", "GITHUB_ENV", "GITHUB_OUTPUT", "RUNNER_TEMP", "HOME", "PATH", "BUN_VERSION",
  ]);
  for (const file of ["build-release.yml", "finalize-notarization.yml"]) {
    const text = fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
    // Split on step boundaries: a step starts at "      - name:" and its env
    // block and run script belong to it until the next one.
    const steps = text.split(/\n(?=      - (?:name|uses|run):)/);
    const exported = new Set();
    for (const step of steps) {
      for (const match of step.matchAll(/echo "([A-Z][A-Z0-9_]+)=[^"]*" >> "\$GITHUB_ENV"/g)) {
        exported.add(match[1]);
      }
      const envBlock = step.match(/\n        env:\n((?:\s{10}\S[^\n]*\n)+)/);
      const declared = new Set(
        (envBlock ? envBlock[1] : "")
          .split("\n")
          .map((line) => line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):/))
          .filter(Boolean)
          .map((match) => match[1]),
      );
      const runBlock = step.slice(step.indexOf("\n        run:"));
      if (!runBlock) continue;
      for (const match of runBlock.matchAll(/"\$([A-Z][A-Z0-9_]{2,})"/g)) {
        const name = match[1];
        if (ambient.has(name) || declared.has(name) || exported.has(name)) continue;
        const stepName = (step.match(/- name: (.+)/) ?? [, "(unnamed)"])[1];
        assert.fail(`${file} step "${stepName}" reads $${name} but no env block declares it`);
      }
    }
  }
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


test("Windows image acceptance uses the packaged binary and cannot pass without credentials", () => {
  const build = fs.readFileSync(path.join(root, ".github/workflows/build-release.yml"), "utf8");
  const start = build.indexOf("      - name: Check real model image credentials");
  const end = build.indexOf("      - name: Retain real model image evidence");
  assert.ok(start >= 0 && end > start);
  const lane = build.slice(start, end);
  assert.ok(lane.length > 0);
  assert.match(lane, /POWERAI_SMOKE_API_KEY: \$\{\{ secrets\.POWERAI_SMOKE_API_KEY \}\}/);
  assert.match(lane, /IsNullOrWhiteSpace/);
  assert.match(lane, /status = 'skipped'; passed = \$false/);
  assert.match(lane, /if: steps.image_credentials.outputs.available == 'true'/);
  assert.match(lane, /out\/\$\{\{ matrix.unpacked \}\}\/resources\/bundled-powerai-agent\/win32-\$\{\{ matrix.arch \}\}\/powerai-agent\.exe/);
  assert.match(lane, /bun tests\/manual\/image-model-smoke\/verify\.ts/);
  assert.match(lane, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  assert.doesNotMatch(lane, /continue-on-error|gh secret set/);
  assert.match(lane, /GITHUB_STEP_SUMMARY/);
});
