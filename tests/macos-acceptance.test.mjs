import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  parseOptions,
  macAssetNames,
  validateCatalog,
  verifyDownloadedRelease,
  validatePreviewEvidence,
  runCommand,
  ownedProcesses,
} from "../scripts/verify-macos-release.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/verify-macos-release.mjs");
const version = "0.1.40-dev.5";
const options = {
  version,
  "desktop-ref": "a".repeat(40),
  "agent-ref": "b".repeat(40),
  "desktop-dir": "/tmp/desktop",
  output: "/tmp/evidence",
};
const args = Object.entries(options).map(([key, value]) => `--${key}=${value}`);
const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  crypto.createHash(algorithm).update(bytes).digest(encoding);

function temp(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "powerai-macos-acceptance-test-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t) {
  const dir = temp(t);
  const assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir);
  const names = macAssetNames(version);
  for (const name of names.slice(0, 3))
    fs.writeFileSync(path.join(assetsDir, name), `actual bytes of ${name}`);
  const yml = [
    `version: ${version}`,
    "files:",
    ...names.slice(0, 2).flatMap((name) => {
      const bytes = fs.readFileSync(path.join(assetsDir, name));
      return [
        `  - url: ${name}`,
        `    sha512: ${digest(bytes, "sha512", "base64")}`,
        `    size: ${bytes.length}`,
      ];
    }),
    "",
  ].join("\n");
  for (const name of names.slice(3)) fs.writeFileSync(path.join(assetsDir, name), yml);
  const provenanceFile = path.join(dir, "release-provenance.json");
  const provenance = {
    schemaVersion: 1,
    version,
    desktopCommit: options["desktop-ref"],
    agentCommit: options["agent-ref"],
    workflowRun: "https://github.com/dztabel-happy/powerai-releases/actions/runs/123",
    assets: {},
  };
  const catalog = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    published_at: "2026-10-10T00:00:00Z",
    assets: [],
  };
  const refresh = () => {
    for (const name of names)
      provenance.assets[name] = digest(fs.readFileSync(path.join(assetsDir, name)));
    fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
    catalog.assets = [...names, "release-provenance.json"].map((name, index) => {
      const bytes = fs.readFileSync(
        name === "release-provenance.json" ? provenanceFile : path.join(assetsDir, name),
      );
      return {
        id: index + 1,
        name,
        state: "uploaded",
        size: bytes.length,
        digest: `sha256:${digest(bytes)}`,
      };
    });
  };
  refresh();
  return {
    dir,
    assetsDir,
    provenanceFile,
    provenance,
    catalog,
    refresh,
    verify: () => verifyDownloadedRelease(catalog, provenanceFile, assetsDir, options),
  };
}

function preview(runtimeRoot) {
  return {
    passed: true,
    platform: "darwin",
    rendererErrors: { total: 0, errors: [], truncated: false },
    ordinary: { loadMs: 1 },
    large: { fallbackMs: 2 },
    imageHeavy: { loadMs: 3 },
    linked: { errorValues: 0, editFound: true, externalLinkKept: true, imageKept: true },
    lifecycle: {
      switch: { beforeReady: true },
      close: { beforeReady: true, tabRemoved: true },
      reopen: { route: "live", value: "acceptance-edit" },
      externalReload: { route: "live", value: "acceptance-reloaded" },
      actualUserData: path.join(runtimeRoot, "powerai-xlsx-budget-actual/user-data"),
    },
  };
}

test("the CLI validates literal exact version/source inputs without invoking release or platform commands", () => {
  assert.deepEqual(parseOptions(args), options);
  assert.match(
    execFileSync(process.execPath, [script, "validate", ...args], { encoding: "utf8" }),
    /inputs are valid/,
  );
  for (const malformed of [
    "main",
    "../main",
    "0.1.40-dev.5;touch /tmp/unwanted",
    "v0.1.40-dev.5",
  ]) {
    assert.throws(
      () =>
        parseOptions(
          args.map((arg) => (arg.startsWith("--version=") ? `--version=${malformed}` : arg)),
        ),
      /exact stable or dev/,
    );
  }
  assert.throws(
    () =>
      parseOptions(args.map((arg) => (arg.startsWith("--agent-ref=") ? "--agent-ref=main" : arg))),
    /exact 40-character/,
  );
  assert.throws(() => parseOptions([...args, "--version=9.0.0"]), /duplicate/);
  assert.throws(() => parseOptions([...args, "--skip-signature=true"]), /Unknown/);
});

test("downloaded bytes pass both catalog/provenance and the real shared updater metadata verifier", (t) => {
  const f = fixture(t);
  const checked = f.verify();
  assert.equal(checked.assets.length, 5);
  assert.equal(checked.bothUpdaterManifestsVerified, true);
  assert.equal(checked.provenanceAsset.name, "release-provenance.json");
});

test("catalog refuses pending, draft, duplicate, incomplete and unverifiable publication", (t) => {
  const f = fixture(t);
  for (const [change, pattern] of [
    [(c) => c.assets.push({ name: "notary-state.json" }), /still pending/],
    [
      (c) => {
        c.draft = true;
      },
      /must be published/,
    ],
    [
      (c) => {
        c.tag_name = "v0.1.40-dev.4";
      },
      /exact requested/,
    ],
    [
      (c) => {
        c.prerelease = false;
      },
      /classification/,
    ],
    [(c) => c.assets.push(c.assets[0]), /duplicate/],
    [(c) => c.assets.pop(), /Missing or unverifiable/],
    [
      (c) => {
        c.assets[0].digest = null;
      },
      /Missing or unverifiable/,
    ],
  ]) {
    const catalog = structuredClone(f.catalog);
    change(catalog);
    assert.throws(() => validateCatalog(catalog, options), pattern);
  }
});

test("a tampered provenance is rejected against catalog before its claims are used", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.provenanceFile, " ");
  assert.throws(f.verify, /GitHub digest or size mismatch: release-provenance/);
});

test("correctly hashed provenance cannot substitute either source commit or version", (t) => {
  const f = fixture(t);
  for (const [key, value] of [
    ["desktopCommit", "c".repeat(40)],
    ["agentCommit", "d".repeat(40)],
    ["version", "0.1.40-dev.4"],
  ]) {
    const prior = f.provenance[key];
    f.provenance[key] = value;
    f.refresh();
    assert.throws(f.verify, /source commit mismatch/);
    f.provenance[key] = prior;
  }
});

test("a changed asset fails even when it has the original byte length", (t) => {
  const f = fixture(t);
  const file = path.join(f.assetsDir, macAssetNames(version)[1]);
  const bytes = fs.readFileSync(file);
  bytes[0] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(f.verify, /GitHub digest or size mismatch/);
});

test("catalog and provenance must agree on each payload", (t) => {
  const f = fixture(t);
  const name = macAssetNames(version)[2];
  f.provenance.assets[name] = "0".repeat(64);
  fs.writeFileSync(f.provenanceFile, JSON.stringify(f.provenance));
  const asset = f.catalog.assets.find((a) => a.name === "release-provenance.json");
  const bytes = fs.readFileSync(f.provenanceFile);
  asset.digest = `sha256:${digest(bytes)}`;
  asset.size = bytes.length;
  assert.throws(f.verify, /Provenance digest mismatch/);
});

test("valid catalog hashes cannot conceal invalid updater SHA512 or extra staged files", (t) => {
  const f = fixture(t);
  const name = path.join(f.assetsDir, "latest-arm64-mac.yml");
  fs.writeFileSync(name, fs.readFileSync(name, "utf8").replace(/sha512: .+/, "sha512: wrong"));
  f.refresh();
  assert.throws(f.verify, (error) => /invalid sha512/.test(String(error.stderr)));
  fs.copyFileSync(path.join(f.assetsDir, "latest-mac.yml"), name);
  f.refresh();
  fs.writeFileSync(path.join(f.assetsDir, "unrelated.zip"), "not part of the Mac release");
  assert.throws(f.verify, (error) => /must contain exactly/.test(String(error.stderr)));
});

test("a success flag cannot mask headless routes, missing lifecycle coverage, renderer failures or lost image parts", (t) => {
  const dir = temp(t);
  validatePreviewEvidence(preview(dir), dir);
  for (const [change, pattern] of [
    [
      (e) => {
        e.lifecycle.reopen.route = "headless";
      },
      /expected live/,
    ],
    [
      (e) => {
        e.lifecycle.externalReload.value = "acceptance-edit";
      },
      /expected live/,
    ],
    [
      (e) => {
        e.lifecycle.close.beforeReady = false;
      },
      /coverage was not observed/,
    ],
    [
      (e) => {
        e.rendererErrors.total = 1;
      },
      /exception evidence/,
    ],
    [
      (e) => {
        delete e.rendererErrors;
      },
      /exception evidence/,
    ],
    [
      (e) => {
        e.linked.imageKept = false;
      },
      /fidelity/,
    ],
    [
      (e) => {
        e.lifecycle.actualUserData = `${dir}-other/user-data`;
      },
      /escaped/,
    ],
    [
      (e) => {
        e.platform = "win32";
      },
      /macOS/,
    ],
  ]) {
    const evidence = preview(dir);
    change(evidence);
    assert.throws(() => validatePreviewEvidence(evidence, dir), pattern);
  }
});

test("real command failures retain stdout and stderr instead of returning a successful empty result", async (t) => {
  const dir = temp(t);
  const logPath = path.join(dir, "command.log");
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "console.log('kept stdout'); console.error('kept failure'); process.exit(7)"],
      { logPath },
    ),
    /exited 7/,
  );
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /kept stdout/);
  assert.match(log, /kept failure/);
});

test("real timed-out command is stopped without killing an unrelated process", async (t) => {
  const dir = temp(t);
  const logPath = path.join(dir, "timeout.log");
  const other = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => other.kill());
  await once(other.stdout, "data");
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "console.log('ownedpid='+process.pid);setInterval(()=>{},1000)"],
      { logPath, timeoutMs: 1_000 },
    ),
    /timed out/,
  );
  const pid = Number(fs.readFileSync(logPath, "utf8").match(/^ownedpid=(\d+)$/m)[1]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(other.pid, 0));
});

test("cleanup selection uses unique installation/profile paths and excludes other PowerAI installs", () => {
  const app = "/private/tmp/run-one/unpacked/PowerAI.app";
  const runtime = "/private/tmp/run-one/runtime";
  const table = `101 ${app}/Contents/MacOS/PowerAI --user-data-dir=${runtime}/powerai-xlsx-budget-one/user-data\n102 ${app}/Contents/Frameworks/PowerAI Helper.app/Contents/MacOS/PowerAI Helper\n103 /Applications/PowerAI.app/Contents/MacOS/PowerAI\n104 /bin/sh ${runtime}/powerai-xlsx-budget-one/user-data/cache/libreoffice/soffice\n105 /private/tmp/run-two/unpacked/PowerAI.app/Contents/MacOS/PowerAI\n106 ps -axo pid=,command=`;
  assert.deepEqual(
    ownedProcesses(table, app, runtime).map((entry) => entry.pid),
    [101, 102, 104],
  );
});
