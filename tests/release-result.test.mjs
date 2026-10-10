import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseResult } from '../scripts/release-result.mjs';
import { scenarios, verifyBuildAcceptance } from '../scripts/verify-build-acceptance.mjs';

const write = (root, name, value) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
};
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

function buildFixture(root) {
  write(root, 'spreadsheet-preview-budget-windows/evidence.json', { passed: true, rendererErrors: { total: 0 },
    lifecycle: { switch: { beforeReady: true }, close: { beforeReady: true, tabRemoved: true },
      reopen: { route: 'live', value: 'acceptance-edit' }, externalReload: { route: 'live', value: 'acceptance-reloaded' } },
    linked: { errorValues: 0, editFound: true, externalLinkKept: true, imageKept: true } });
  write(root, 'image-model-smoke-windows/evidence.json', { status: 'passed', passed: true,
    expected: ['K7P9', 'R4W2', 'M8Q6', 'H3N5'], answer: 'K7P9 R4W2 M8Q6 H3N5' });
  write(root, 'titlebar-windows/result.json', { passed: true, appVersion: '0.1.40-dev.6', host: 'win32', renderer: 'packaged', records: [{}] });
  write(root, 'failure-continuity-windows/matrix.json', scenarios.map(scenario => ({ scenario, code: 0, timedOut: false, failurePhase: null, injected: scenario !== 'healthy-reopen' })));
  for (const scenario of scenarios) {
    write(root, `failure-continuity-windows/${scenario}/outcome.json`, { scenario, status: 'passed' });
    write(root, `failure-continuity-windows/${scenario}/result.json`, Object.fromEntries([
      'twoTurnsCompleted', 'noInspect', 'rowsUnchanged', 'processRowsUnchanged', 'runtimeNotStarted', 'transcriptWithoutRuntimeStartup',
      'commandObserverVerified', 'abandonedWithoutAssistant', 'terminated', 'terminalRecorded', 'processVisible', 'messageRetained',
      'sessionContinuous', 'diagnosticsExported', 'nextOperationAnswered', 'writeNotRepeated', 'recallUsedNoTools', 'secondContinuationAnswered',
    ].map(key => [key, true])));
  }
}

test('packaged acceptance requires actual evidence for every mandatory gate', t => {
  const root = fixture(t); buildFixture(root);
  const result = verifyBuildAcceptance(root, '0.1.40-dev.6', 'x64');
  assert.equal(result.accepted, true); assert.equal(result.failureContinuity.length, 23);
  write(root, 'image-model-smoke-windows/evidence.json', { status: 'skipped', passed: false });
  assert.throws(() => verifyBuildAcceptance(root, '0.1.40-dev.6', 'x64'), /missing or skipped/);
});
test('a truncated matrix or hidden failed assertion blocks publication', t => {
  const root = fixture(t); buildFixture(root);
  write(root, 'failure-continuity-windows/new-provider-empty-text/result.json', { terminated: true, sessionContinuous: false });
  assert.throws(() => verifyBuildAcceptance(root, '0.1.40-dev.6', 'x64'));
  buildFixture(root);
  write(root, 'failure-continuity-windows/matrix.json', []);
  assert.throws(() => verifyBuildAcceptance(root, '0.1.40-dev.6', 'x64'), /Incomplete failure matrix/);
});

function resultFixture(root) {
  const input = { version: '0.1.40-dev.6', desktopRef: 'd'.repeat(40), agentRef: 'a'.repeat(40), windowsArm64: false,
    buildUrl: 'https://github.com/example/releases/actions/runs/6', toolingCommit: 'b'.repeat(40) };
  const jobs = Object.fromEntries(['guard', 'approve', 'windows-x64', 'macos-arm64', 'publish-windows', 'mark-macos-pending',
    'windows-mirror-ready', 'installed-windows', 'complete-mirror-ready', 'official-macos'].map(name => [name, { result: 'success', outputs: { accepted: 'true' } }]));
  const expectedBuild = { buildUrl: input.buildUrl, toolingCommit: input.toolingCommit };
  write(root, 'release-plan/release-plan.json', { ...input, expectedBuild, requiredArches: ['x64'], previous: { x64: { version: '0.1.40-dev.5', tag: 'v0.1.40-dev.5' } }, channel: 'dev', snapshots: { 'v0.1.40-dev.5': { provenance: { sha256: 'p' }, assets: { 'PowerAI-0.1.40-dev.5-win-x64.exe': { sha256: 'i' } } } } });
  write(root, 'build-acceptance-x64/build-acceptance.json', { accepted: true, version: input.version, arch: 'x64', failureContinuity: scenarios });
  write(root, `update-acceptance-windows-x64-dev-0.1.40-dev.5-${input.version}/installed-update-summary.json`, {
    accepted: true, arch: 'x64', fromVersion: '0.1.40-dev.5', toVersion: input.version, channel: 'dev', harnessCommit: input.desktopRef,
    userDataRetained: true, noRestartLoop: true, pdfConversion: true, titlebarPassed: true,
    sourceInstaller: { verified: true, version: '0.1.40-dev.5', arch: 'x64', name: 'PowerAI-0.1.40-dev.5-win-x64.exe', actualSha256: 'i', provenanceSha256: 'p' }, relaunchMode: 'controlled', firstAutomaticRelaunch: false,
  });
  for (const phase of ['windows', 'complete']) write(root, `${phase}-mirror-readiness/${phase}-readiness.json`, {
    ...input, phase, status: 'passed', expectedBuild, macComplete: phase === 'complete',
  });
  write(root, `macos-official-acceptance-${input.version}/execution.json`, { accepted: true, runtimePassed: true, version: input.version,
    desktopCommit: input.desktopRef, agentCommit: input.agentRef, payloadBefore: { binary: 'x', asar: 'y', agent: 'z' }, payloadAfter: { binary: 'x', asar: 'y', agent: 'z' } });
  return { input, jobs };
}
test('complete acceptance requires all stages and matching version/source records', t => {
  const root = fixture(t); const { input, jobs } = resultFixture(root);
  assert.equal(releaseResult(root, input, jobs).accepted, true);
  jobs['official-macos'].result = 'skipped';
  assert.equal(releaseResult(root, input, jobs).accepted, false);
  jobs['official-macos'].result = 'success';
  assert.equal(releaseResult(root, { ...input, toolingCommit: 'wrong' }, jobs).accepted, false);
  fs.rmSync(path.join(root, `macos-official-acceptance-${input.version}/execution.json`));
  assert.equal(releaseResult(root, input, jobs).accepted, false);
});
test('pending notarization and a skipped architecture cannot be reported accepted', t => {
  const root = fixture(t); const { input, jobs } = resultFixture(root);
  assert.equal(releaseResult(root, { ...input, windowsArm64: true }, jobs).accepted, false);
  write(root, 'complete-mirror-readiness/complete-readiness.json', { status: 'passed', macComplete: false });
  assert.equal(releaseResult(root, input, jobs).accepted, false);
});
test('installed evidence must match the frozen source package digest', t => {
  const root = fixture(t); const { input, jobs } = resultFixture(root);
  const name = `update-acceptance-windows-x64-dev-0.1.40-dev.5-${input.version}/installed-update-summary.json`;
  const value = JSON.parse(fs.readFileSync(path.join(root, name)));
  value.sourceInstaller.actualSha256 = 'different-package';
  write(root, name, value);
  const result = releaseResult(root, input, jobs);
  assert.equal(result.accepted, false);
  assert(result.errors.some(error => error.startsWith('installed Windows x64:')));
});
