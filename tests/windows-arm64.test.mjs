import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = path.resolve('scripts/windows-release.mjs');
const run = (...args) => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' });

for (const target of ['x64', 'arm64', 'all']) {
  test(`${target} release retains independent installer metadata and staged payloads`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-arches-'));
    try {
      const artifacts = path.join(root, 'artifacts');
      const output = path.join(root, 'output');
      const arches = target === 'all' ? ['x64', 'arm64'] : [target];
      for (const arch of arches) {
        const dir = path.join(artifacts, `windows-${arch}`);
        fs.mkdirSync(dir, { recursive: true });
        const exe = `PowerAI-1.2.3-win-${arch}.exe`;
        fs.writeFileSync(path.join(dir, exe), arch);
        fs.writeFileSync(path.join(dir, `${exe}.blockmap`), 'blockmap');
        fs.writeFileSync(path.join(dir, `PowerAI-1.2.3-win-${arch}.zip`), `zip-${arch}`);
        fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 1.2.3\nfiles:\n  - url: ${exe}\n    sha512: ${crypto.createHash('sha512').update(arch).digest('base64')}\n    size: ${arch.length}\npath: ${exe}\n`);
      }
      run('prepare', artifacts, output, '1.2.3', target);
      run('provenance', output, '1.2.3', 'a'.repeat(40), 'b'.repeat(40), 'https://github.com/owner/repo/actions/runs/1', target);
      run('verify', output, '1.2.3', target);
      for (const arch of arches) {
        const yaml = arch === 'x64' ? 'latest.yml' : 'latest-win-arm64.yml';
        assert.equal(fs.readFileSync(path.join(output, yaml), 'utf8'), fs.readFileSync(path.join(artifacts, `windows-${arch}`, 'latest.yml'), 'utf8'));
      }
      if (target === 'all') {
        fs.copyFileSync(path.join(output, 'latest.yml'), path.join(output, 'latest-win-arm64.yml'));
        assert.throws(() => run('verify', output, '1.2.3', target), /does not reference/);
      } else {
        assert.throws(() => run('verify', output, '1.2.3', target === 'x64' ? 'arm64' : 'x64'), /missing or unexpected/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('candidate mode cannot publish and ARM64 remains opt-in for releases', () => {
  const workflow = fs.readFileSync('.github/workflows/build-release.yml', 'utf8');
  assert.match(workflow, /windows_arm64:[\s\S]*?default: false/);
  for (const job of ['macos-arm64', 'publish-windows']) {
    assert.ok(workflow.includes(`  ${job}:\n    if: inputs.mode != 'arm64-candidate'`));
  }
  assert.match(workflow, /if \[ "\$RELEASE_MODE" != arm64-candidate \]; then\n\s*test .*refs\/heads\/main/);
  assert.match(workflow, /test "\$\(git -C powerai-desktop rev-parse HEAD\)" = "\$DESKTOP_REF"/);
});
