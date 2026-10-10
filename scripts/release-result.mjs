import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredJobs = ['guard', 'approve', 'windows-x64', 'macos-arm64', 'publish-windows', 'mark-macos-pending',
  'windows-mirror-ready', 'installed-windows', 'complete-mirror-ready', 'official-macos'];

export function releaseResult(root, input, jobs) {
  const result = { accepted: false, version: input.version, desktopRef: input.desktopRef, agentRef: input.agentRef,
    buildUrl: input.buildUrl, toolingCommit: input.toolingCommit, completedAt: new Date().toISOString(), jobs,
    checks: [], errors: [], installedWindows: {}, mirrors: {}, boundaries: [
      'Windows installed update uses a controlled relaunch; first automatic relaunch is unverified.',
      'Mac acceptance runs the official signed package; it does not verify an installed automatic upgrade.',
      'Omitted Windows ARM64 is retained at its prior release and is not certified for this release.',
      'Large mirror files are checked by HTTP range and size; small files are hashed in full.',
    ] };
  const read = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
  const check = (name, fn) => {
    try { fn(); result.checks.push({ name, passed: true }); }
    catch (error) { result.errors.push(`${name}: ${error.message}`); result.checks.push({ name, passed: false }); }
  };
  for (const name of requiredJobs) check(`job ${name}`, () => assert.equal(jobs[name]?.result, 'success'));
  const arches = input.windowsArm64 ? ['x64', 'arm64'] : ['x64'];
  let plan;
  check('immutable plan', () => {
    plan = read('release-plan', 'release-plan.json');
    assert.equal(plan.version, input.version);
    assert.equal(plan.desktopRef, input.desktopRef);
    assert.equal(plan.agentRef, input.agentRef);
    assert.equal(plan.expectedBuild.buildUrl, input.buildUrl);
    assert.equal(plan.expectedBuild.toolingCommit, input.toolingCommit);
    assert.deepEqual(plan.requiredArches, arches);
  });
  for (const arch of arches) {
    check(`packaged Windows ${arch}`, () => {
      const value = read(`build-acceptance-${arch}`, 'build-acceptance.json');
      assert.equal(value.accepted, true); assert.equal(value.version, input.version); assert.equal(value.arch, arch);
      assert.equal(value.failureContinuity?.length, 23);
    });
    check(`installed Windows ${arch}`, () => {
      assert(plan, 'Missing upgrade baseline');
      const from = plan.previous[arch].version;
      const value = read(`update-acceptance-windows-${arch}-${plan.channel}-${from}-${input.version}`, 'installed-update-summary.json');
      assert.equal(value.accepted, true); assert.equal(value.arch, arch);
      assert.equal(value.fromVersion, from); assert.equal(value.toVersion, input.version);
      assert.equal(value.channel, plan.channel); assert.equal(value.harnessCommit, input.desktopRef);
      for (const key of ['userDataRetained', 'noRestartLoop', 'pdfConversion', 'titlebarPassed']) assert.equal(value[key], true, key);
      assert.equal(value.sourceInstaller?.verified, true);
      assert.equal(value.sourceInstaller.version, from);
      assert.equal(value.sourceInstaller.arch, arch);
      const source = plan.snapshots[plan.previous[arch].tag];
      const name = `PowerAI-${from}-win-${arch}.exe`;
      assert.equal(value.sourceInstaller.name, name);
      assert.equal(value.sourceInstaller.actualSha256, source.assets[name].sha256);
      assert.equal(value.sourceInstaller.provenanceSha256, source.provenance.sha256);
      assert.equal(value.relaunchMode, 'controlled');
      assert.equal(value.firstAutomaticRelaunch, false);
      result.installedWindows[arch] = value;
    });
  }
  for (const phase of ['windows', 'complete']) check(`${phase} public mirror`, () => {
    const value = read(`${phase}-mirror-readiness`, `${phase}-readiness.json`);
    assert.equal(value.status, 'passed'); assert.equal(value.phase, phase); assert.equal(value.version, input.version);
    assert.equal(value.desktopRef, input.desktopRef); assert.equal(value.agentRef, input.agentRef);
    assert.equal(value.expectedBuild?.buildUrl, input.buildUrl); assert.equal(value.expectedBuild?.toolingCommit, input.toolingCommit);
    if (phase === 'complete') assert.equal(value.macComplete, true);
    result.mirrors[phase] = value;
  });
  check('official Mac package', () => {
    assert.equal(jobs['official-macos']?.outputs?.accepted, 'true');
    const value = read(`macos-official-acceptance-${input.version}`, 'execution.json');
    assert.equal(value.accepted, true); assert.equal(value.runtimePassed, true);
    assert.equal(value.version, input.version); assert.equal(value.desktopCommit, input.desktopRef); assert.equal(value.agentCommit, input.agentRef);
    assert(value.payloadBefore && Object.keys(value.payloadBefore).length === 3);
    assert.deepEqual(value.payloadBefore, value.payloadAfter);
    result.macos = { accepted: value.accepted, scope: value.scope, release: value.release,
      preview: value.preview, payloadBefore: value.payloadBefore, payloadAfter: value.payloadAfter, cleanup: value.cleanup };
  });
  result.accepted = result.errors.length === 0;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, output] = process.argv.slice(2);
  assert(root && output, 'Usage: release-result ROOT OUTPUT');
  const result = releaseResult(root, { version: process.env.VERSION, desktopRef: process.env.DESKTOP_REF,
    agentRef: process.env.AGENT_REF, windowsArm64: process.env.WINDOWS_ARM64 === 'true',
    buildUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    toolingCommit: process.env.GITHUB_SHA }, JSON.parse(process.env.RELEASE_NEEDS));
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  const summary = `## Release ${result.version}: ${result.accepted ? 'ACCEPTED' : 'NOT ACCEPTED'}\n\n` +
    `Build: ${result.buildUrl}\n\n` + result.checks.map(item => `- ${item.passed ? 'PASS' : 'FAIL'}: ${item.name}`).join('\n') +
    '\n\n' + result.errors.map(error => `- ${error}`).join('\n') + '\n\nScope:\n' + result.boundaries.map(item => `- ${item}`).join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!result.accepted) process.exitCode = 1;
}
