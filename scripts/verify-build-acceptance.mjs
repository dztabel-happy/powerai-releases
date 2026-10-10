import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const scenarios = ['new', 'history'].flatMap(history =>
  ['provider', 'runtime'].flatMap(origin => ['empty', 'queued'].flatMap(queue =>
    ['tools', 'text'].map(tools => `${history}-${origin}-${queue}-${tools}`))))
  .concat(['ack-unknown', 'abandon-reopen', 'desktop-death', 'late-reload', 'disk-terminal', 'content-stall', 'healthy-reopen']);

// Consume the real harness results. Missing or skipped gates must not turn a
// successful build into a release that appears to have passed acceptance.
export function verifyBuildAcceptance(root, version, arch) {
  assert(['x64', 'arm64'].includes(arch), 'Unsupported Windows architecture');
  const suffix = arch === 'arm64' ? '-arm64' : '';
  const read = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
  const preview = read(`spreadsheet-preview-budget-windows${suffix}`, 'evidence.json');
  assert.equal(preview.passed, true, 'Spreadsheet acceptance did not pass');
  assert.equal(preview.rendererErrors?.total, 0, 'Spreadsheet renderer errors');
  assert.equal(preview.lifecycle?.switch?.beforeReady, true);
  assert.equal(preview.lifecycle?.close?.beforeReady, true);
  assert.equal(preview.lifecycle?.close?.tabRemoved, true);
  assert.equal(preview.lifecycle?.reopen?.route, 'live');
  assert.equal(preview.lifecycle?.reopen?.value, 'acceptance-edit');
  assert.equal(preview.lifecycle?.externalReload?.route, 'live');
  assert.equal(preview.lifecycle?.externalReload?.value, 'acceptance-reloaded');
  assert.equal(preview.linked?.errorValues, 0);
  for (const key of ['editFound', 'externalLinkKept', 'imageKept']) assert.equal(preview.linked?.[key], true, key);
  const image = read(`image-model-smoke-windows${suffix}`, 'evidence.json');
  assert.equal(image.passed, true, 'Real model image acceptance missing or skipped');
  assert.equal(image.status, 'passed');
  assert.deepEqual(image.expected, ['K7P9', 'R4W2', 'M8Q6', 'H3N5']);
  assert(image.expected.every(code => image.answer?.includes(code)), 'Image codes were not all observed');
  const titlebar = read(`titlebar-windows${suffix}`, 'result.json');
  assert.equal(titlebar.passed, true, 'Titlebar acceptance did not pass');
  assert.equal(titlebar.appVersion, version);
  assert.equal(titlebar.host, 'win32');
  assert.equal(titlebar.renderer, 'packaged');
  assert(titlebar.records?.length > 0, 'Titlebar evidence is empty');
  const matrix = read(`failure-continuity-windows${suffix}`, 'matrix.json');
  assert(Array.isArray(matrix), 'Failure continuity missing or skipped');
  assert.deepEqual(matrix.map(item => item.scenario).sort(), [...scenarios].sort(), 'Incomplete failure matrix');
  const checks = matrix.map(item => {
    assert.equal(item.code, 0, item.scenario);
    assert.equal(item.timedOut, false, item.scenario);
    assert.equal(item.failurePhase, null, item.scenario);
    assert.equal(item.injected, item.scenario !== 'healthy-reopen', item.scenario);
    const outcome = read(`failure-continuity-windows${suffix}`, item.scenario, 'outcome.json');
    assert.equal(outcome.scenario, item.scenario);
    assert.equal(outcome.status, 'passed');
    const result = read(`failure-continuity-windows${suffix}`, item.scenario, 'result.json');
    const keys = item.scenario === 'healthy-reopen'
      ? ['twoTurnsCompleted', 'noInspect', 'rowsUnchanged', 'processRowsUnchanged', 'runtimeNotStarted', 'transcriptWithoutRuntimeStartup', 'commandObserverVerified']
      : item.scenario === 'abandon-reopen' ? ['commandObserverVerified', 'abandonedWithoutAssistant']
        : ['terminated', 'terminalRecorded', 'processVisible', 'messageRetained', 'sessionContinuous', 'diagnosticsExported', 'nextOperationAnswered', 'writeNotRepeated', 'recallUsedNoTools', 'secondContinuationAnswered'];
    for (const key of keys) assert.equal(result[key], true, `${item.scenario}: ${key}`);
    return { scenario: item.scenario, assertions: keys.length };
  });
  return { accepted: true, version, arch, spreadsheet: true, realModelImage: true,
    titlebar: true, failureContinuity: checks, completedAt: new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, version, arch, output] = process.argv.slice(2);
  assert(root && version && arch && output, 'Usage: verify-build-acceptance ROOT VERSION ARCH OUTPUT');
  fs.writeFileSync(output, `${JSON.stringify(verifyBuildAcceptance(root, version, arch), null, 2)}\n`);
}
