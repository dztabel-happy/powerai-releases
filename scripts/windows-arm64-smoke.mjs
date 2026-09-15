#!/usr/bin/env node
// Runs on a disposable Windows ARM64 runner, against the installed candidate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [installer, root] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'arm64', 'Acceptance must run in a native ARM64 Node process');
assert.ok(installer && root);
fs.mkdirSync(root, { recursive: true });
const cwd = path.join(root, 'workspace');
fs.mkdirSync(cwd, { recursive: true });
const env = { ...process.env, OFFICECLI_SKIP_UPDATE: '1' };
const evidence = { passed: false, platform: process.platform, arch: process.arch, commands: [] };
process.once('uncaughtException', (error) => {
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ ...evidence, error: error.message }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
function run(file, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 180_000, windowsHide: true, ...options });
  evidence.commands.push({ executable: path.basename(file), command: args[0], exitCode: result.status, elapsedMs: Date.now() - started });
  assert.equal(result.status, 0, `${path.basename(file)} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function machine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    assert.equal(header.toString('ascii', 0, 2), 'MZ');
    const pe = Buffer.alloc(6);
    fs.readSync(fd, pe, 0, 6, header.readUInt32LE(60));
    assert.equal(pe.toString('ascii', 0, 4), 'PE\0\0');
    return pe.readUInt16LE(4);
  } finally { fs.closeSync(fd); }
}
const installed = path.join(root, 'installed');
run(path.resolve(installer), ['/S', `/D=${installed}`]);
const app = path.join(installed, 'PowerAI.exe');
assert.equal(machine(app), 0xaa64, 'Electron must be ARM64');
const resources = path.join(installed, 'resources');
const binary = (kit, name) => path.join(resources, `bundled-${kit}`, 'win32-arm64', `${name}.exe`);
assert.equal(machine(binary('powerai-agent', 'powerai-agent')), 0xaa64, 'Agent must be ARM64');
const office = binary('officecli', 'officecli');
assert.equal(machine(office), 0xaa64, 'OfficeCLI must be ARM64');
run(office, ['create', 'office.docx']);
run(office, ['create', 'office.xlsx']);
run(office, ['set', 'office.xlsx', '/Sheet1/A1', '--prop', 'value=ARM64']);
assert.match(run(office, ['get', 'office.xlsx', '/Sheet1/A1']), /ARM64/);
run(office, ['validate', 'office.docx']);
run(office, ['close', 'office.docx']);
run(office, ['close', 'office.xlsx']);

const docx = binary('docxkit', 'docx-kit');
const chart = binary('chartkit', 'chart-kit');
assert.equal(machine(docx), 0x8664, 'The pinned standalone DocxKit uses Windows x64 emulation');
assert.equal(machine(chart), 0x8664, 'The pinned standalone ChartKit uses Windows x64 emulation');
fs.writeFileSync(path.join(cwd, 'content.md'), '# 架构验收\n\n这是隔离测试目录中的 Word 生成验收。\n');
run(docx, ['build', 'content.md', '--out', 'word', '--filename', 'arm64.docx']);
assert.ok(fs.statSync(path.join(cwd, 'word', 'arm64.docx')).size > 1000);
fs.writeFileSync(path.join(cwd, 'input.csv'), 'Workload,A,B\nLight,12,20\nMedium,18,30\nHeavy,9,15\n');
fs.writeFileSync(path.join(cwd, 'figure.json'), JSON.stringify({
  version: '0.1', type: 'bar', profile: 'report_a4.full_width',
  contract: { conclusion: 'A is 40% lower than B in this synthetic fixture.', role: 'comparison', archetype: 'quantitative_grid', evidence_hierarchy: { hero: 'latency comparison' }, statistics: [{ n_definition: 'workloads', center: 'mean', interval: 'none' }], source_data: [{ path: 'input.csv' }] },
  data: { series: [{ label: 'A', role: 'ours', values: [12, 18, 9] }, { label: 'B', role: 'baseline', values: [20, 30, 15] }], categories: ['Light', 'Medium', 'Heavy'] }
}));
run(chart, ['build', 'figure.json', '--out', 'chart', '--theme', 'business-cn', '--format', 'all']);
const figures = fs.readdirSync(path.join(cwd, 'chart'), { recursive: true }).filter((name) => String(name).endsWith('.png'));
assert.ok(figures.length > 0, 'ChartKit must actually render PNG output');
fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ ...evidence, passed: true, installed: true, agent: 'arm64', officecli: 'arm64', docxkit: 'x64-emulation', chartkit: 'x64-emulation', wordCreated: true, spreadsheetReadback: true, chartRendered: true }, null, 2));
console.log('Installed ARM64 app and native/compatibility document tools passed.');
