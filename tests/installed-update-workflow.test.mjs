import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/verify-desktop-update.yml", import.meta.url),
  "utf8",
);
const steps = workflow.split(/\n(?=      - )/);
const step = (name) => steps.find((value) => value.includes(`- name: ${name}\n`));
const inlineNode = (name) => step(name)
  .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
  .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
const verifySource = inlineNode("Verify source installer against published provenance");
const verifyEvidence = inlineNode("Validate installed update evidence");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(context, arch = "x64") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-installed-workflow-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    RUNNER_TEMP: directory,
    FROM_VERSION: "0.1.40-dev.4",
    TO_VERSION: "0.1.40-dev.5",
    TARGET_ARCH: arch,
    TARGET_CHANNEL: "dev",
    CHANNEL_TRANSITION: "none",
    DESKTOP_REF: "a".repeat(40),
    GITHUB_OUTPUT: path.join(directory, "outputs"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
  };
  const name = `PowerAI-${env.FROM_VERSION}-win-${arch}.exe`;
  const installer = Buffer.from("synthetic installer fixture, never executed");
  const provenance = {
    schemaVersion: 1,
    version: env.FROM_VERSION,
    desktopCommit: "b".repeat(40),
    agentCommit: "c".repeat(40),
    workflowRun: "https://github.com/dztabel-happy/powerai-releases/actions/runs/1",
    assets: { [name]: sha256(installer) },
  };
  const evidence = {
    fromVersion: env.FROM_VERSION,
    toVersion: env.TO_VERSION,
    installedVersion: env.TO_VERSION,
    platform: "win32",
    expectedArch: arch,
    sourceExecutableArch: arch,
    installedExecutableArch: arch,
    harnessCommit: env.DESKTOP_REF,
    channelTransition: "none",
    relaunchMode: "controlled",
    expectedRoute: "any",
    firstAutomaticRelaunch: false,
    sourceExitCode: 0,
    updateInstallerExited: true,
    userDataRetained: true,
    noRestartLoop: true,
    documentEngine: { pdfConversion: true },
    startedAt: "2026-10-10T15:12:47.404Z",
    completedAt: "2026-10-10T15:15:04.273Z",
    updateRoute: { route: "unknown", helperArmed: true, helperComplete: true, installerExecuted: false },
    windowsTitlebar: { reservedWidth: 136, safeRight: 836, paddingRight: 144, interactiveRight: 166 },
  };
  fs.mkdirSync(path.join(directory, "download"));
  fs.writeFileSync(path.join(directory, "download", name), installer);
  const writeProvenance = () => fs.writeFileSync(path.join(directory, "download/release-provenance.json"), JSON.stringify(provenance));
  const writeEvidence = () => fs.writeFileSync(path.join(directory, `update-acceptance-windows-${arch}.json`), JSON.stringify(evidence));
  writeProvenance();
  writeEvidence();
  const run = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, stdio: "pipe" });
  const assertNotAccepted = () => {
    assert.ok(!fs.existsSync(env.GITHUB_OUTPUT));
    assert.ok(!fs.existsSync(path.join(directory, "installed-update-summary.json")));
  };
  return { directory, env, name, provenance, evidence, run, writeProvenance, writeEvidence, assertNotAccepted };
}

test("reusable installed acceptance retains manual choices and fails closed before using credentials or installing", () => {
  const callable = workflow.slice(workflow.indexOf("  workflow_call:"), workflow.indexOf("  workflow_dispatch:"));
  for (const name of ["from_version", "to_version", "desktop_ref", "arch", "target_channel"])
    assert.match(callable, new RegExp(`${name}:\\n(?:[^\\n]+\\n)*?        type: string`));
  assert.match(callable, /require_windows_signature:\n(?:[^\n]+\n)*?        type: boolean/);
  assert.match(callable, /value: \$\{\{ jobs.windows-update.outputs.accepted \}\}/);
  assert.match(workflow, /accepted: \$\{\{ steps.acceptance.outputs.accepted \|\| 'false' \}\}/);
  assert.match(step("Require private harness deploy key"), /test -n "\$DEPLOY_KEY"/);
  assert.doesNotMatch(step("Require private harness deploy key"), /echo.*\$DEPLOY_KEY/);
  assert.ok(workflow.indexOf("Require private harness deploy key") < workflow.indexOf("Checkout exact private Desktop harness"));
  assert.ok(workflow.indexOf("Verify source installer against published provenance") < workflow.indexOf("- name: Install source version"));
  assert.match(step("Download source installer and published provenance"), /--pattern 'release-provenance.json'/);
  assert.match(step("Exercise old to new update"), /node tests\/manual\/auto-update\/verify.mjs/);
  assert.doesNotMatch(step("Exercise old to new update"), /--relaunch|--expected-route/);
  assert.match(workflow, /node tests\/manual\/auto-update\/validate-release.mjs/);
  assert.match(workflow, /group: powerai-update-/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /retention-days: 90/);
  for (const name of ["installed-update-summary.json", "source-installer-integrity.json", "download/release-provenance.json"])
    assert.ok(steps.find((value) => value.includes("actions/upload-artifact@")).includes(name));
});

for (const arch of ["x64", "arm64"]) {
  test(`verifies the actual downloaded ${arch} installer bytes before accepting evidence`, (context) => {
    const value = fixture(context, arch);
    value.run(verifySource);
    const receipt = JSON.parse(fs.readFileSync(path.join(value.directory, "source-installer-integrity.json")));
    assert.equal(receipt.verified, true);
    assert.equal(receipt.name, value.name);
    assert.equal(receipt.actualSha256, value.provenance.assets[value.name]);
    assert.equal(receipt.provenanceSha256, sha256(fs.readFileSync(path.join(value.directory, "download/release-provenance.json"))));
    value.run(verifyEvidence);
    assert.equal(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), "accepted=true\n");
    const summary = JSON.parse(fs.readFileSync(path.join(value.directory, "installed-update-summary.json")));
    assert.equal(summary.accepted, true);
    assert.equal(summary.updateRoute.route, "unknown");
    assert.equal(summary.firstAutomaticRelaunch, false);
    assert.equal(summary.sourceInstaller.actualSha256, receipt.actualSha256);
    assert.equal(summary.evidenceSha256, sha256(fs.readFileSync(path.join(value.directory, `update-acceptance-windows-${arch}.json`))));
    assert.match(summary.boundaries.join(" "), /does not verify the first automatic target launch/);
  });
}

for (const [label, mutate] of [
  ["changed installer bytes", (value) => fs.appendFileSync(path.join(value.directory, "download", value.name), "corruption")],
  ["wrong source version", (value) => { value.provenance.version = "0.1.39"; value.writeProvenance(); }],
  ["missing architecture digest", (value) => { delete value.provenance.assets[value.name]; value.writeProvenance(); }],
  ["malformed digest", (value) => { value.provenance.assets[value.name] = "not-a-sha"; value.writeProvenance(); }],
  ["unsupported provenance", (value) => { value.provenance.schemaVersion = 2; value.writeProvenance(); }],
  ["missing provenance", (value) => fs.unlinkSync(path.join(value.directory, "download/release-provenance.json"))],
]) {
  test(`rejects source installation with ${label}`, (context) => {
    const value = fixture(context);
    mutate(value);
    assert.throws(() => value.run(verifySource));
    assert.ok(!fs.existsSync(path.join(value.directory, "source-installer-integrity.json")));
    value.assertNotAccepted();
  });
}

for (const [label, mutate] of [
  ["wrong source", (value) => { value.fromVersion = "0.1.39"; }],
  ["wrong target", (value) => { value.toVersion = "0.1.40-dev.4"; }],
  ["wrong installed version", (value) => { value.installedVersion = "0.1.40-dev.4"; }],
  ["wrong source architecture", (value) => { value.sourceExecutableArch = "arm64"; }],
  ["wrong target architecture", (value) => { value.installedExecutableArch = "arm64"; }],
  ["wrong harness source", (value) => { value.harnessCommit = "d".repeat(40); }],
  ["wrong transition", (value) => { value.channelTransition = "stable-to-dev"; }],
  ["missing marker retention", (value) => { delete value.userDataRetained; }],
  ["restart loop", (value) => { value.noRestartLoop = false; }],
  ["missing PDF conversion", (value) => { delete value.documentEngine; }],
  ["failed PDF conversion", (value) => { value.documentEngine.pdfConversion = false; }],
  ["source crash", (value) => { value.sourceExitCode = 1; }],
  ["installer still active", (value) => { value.updateInstallerExited = false; }],
  ["missing completion", (value) => { delete value.completedAt; }],
  ["invalid completion", (value) => { value.completedAt = "not-a-time"; }],
  ["recorded failure", (value) => { value.error = "late failure after completion"; }],
  ["recorded failure time", (value) => { value.failedAt = value.completedAt; }],
  ["route collection failure", (value) => { value.routeDiagnosticError = "logs unavailable"; }],
  ["conflicting update routes", (value) => { value.updateRoute.route = "conflict"; }],
  ["missing route diagnostics", (value) => { delete value.updateRoute; }],
  ["automatic mode substituted", (value) => { value.relaunchMode = "automatic"; }],
  ["unsupported first launch claim", (value) => { value.firstAutomaticRelaunch = true; }],
  ["missing titlebar checks", (value) => { delete value.windowsTitlebar; }],
  ["invalid titlebar geometry", (value) => { value.windowsTitlebar.reservedWidth = null; }],
  ["titlebar overlap", (value) => { value.windowsTitlebar.interactiveRight = 900; }],
]) {
  test(`does not emit accepted=true for ${label}`, (context) => {
    const value = fixture(context);
    value.run(verifySource);
    mutate(value.evidence);
    value.writeEvidence();
    assert.throws(() => value.run(verifyEvidence));
    value.assertNotAccepted();
  });
}

for (const route of ["staged", "nsis"]) {
  test(`accepts a valid controlled ${route} route without changing the original handoff policy`, (context) => {
    const value = fixture(context);
    value.run(verifySource);
    value.evidence.updateRoute.route = route;
    value.writeEvidence();
    value.run(verifyEvidence);
    assert.equal(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), "accepted=true\n");
  });
}

test("successful process exit without actual evidence cannot be accepted", (context) => {
  const value = fixture(context);
  value.run(verifySource);
  fs.unlinkSync(path.join(value.directory, "update-acceptance-windows-x64.json"));
  assert.throws(() => value.run(verifyEvidence));
  value.assertNotAccepted();
});

test("missing private deploy key stops before checkout without disclosing a configured key", () => {
  const guard = step("Require private harness deploy key").match(/run: \|\n([\s\S]*)/)[1];
  assert.throws(() => execFileSync("bash", ["-c", guard], { env: { ...process.env, DEPLOY_KEY: "" }, stdio: "pipe" }));
  assert.equal(execFileSync("bash", ["-c", guard], {
    env: { ...process.env, DEPLOY_KEY: "synthetic-not-a-real-key" }, encoding: "utf8",
  }), "");
});

test("stable-to-dev acceptance requires the recorded channel toggle and exact discovered version", (context) => {
  const value = fixture(context);
  value.run(verifySource);
  value.env.CHANNEL_TRANSITION = "stable-to-dev";
  value.evidence.channelTransition = "stable-to-dev";
  value.writeEvidence();
  assert.throws(() => value.run(verifyEvidence));
  value.assertNotAccepted();
  value.evidence.prereleaseEnabledWithoutRestart = true;
  value.evidence.discoveredVersion = "0.1.40-dev.4";
  value.writeEvidence();
  assert.throws(() => value.run(verifyEvidence));
  value.assertNotAccepted();
  value.evidence.discoveredVersion = value.env.TO_VERSION;
  value.writeEvidence();
  value.run(verifyEvidence);
  assert.equal(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), "accepted=true\n");
});

test("acceptance cannot proceed without the independently created installer integrity receipt", (context) => {
  const value = fixture(context);
  assert.throws(() => value.run(verifyEvidence));
  value.assertNotAccepted();
});
