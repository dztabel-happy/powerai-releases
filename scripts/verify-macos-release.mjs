#!/usr/bin/env node

// Run the unchanged Desktop preview harness against a published, notarized app.
// Downloads and the disposable profile stay outside the retained evidence tree.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = "dztabel-happy/powerai-releases";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function parseOptions(args) {
  const options = {};
  for (const argument of args) {
    const match = argument.match(/^--(version|desktop-ref|agent-ref|desktop-dir|output)=(.+)$/);
    assert(
      match && !Object.hasOwn(options, match[1]),
      `Unknown or duplicate argument: ${argument}`,
    );
    options[match[1]] = match[2];
  }
  assert(
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?$/.test(options.version ?? ""),
    "version must be an exact stable or dev version",
  );
  for (const key of ["desktop-ref", "agent-ref"]) {
    assert(
      /^[0-9a-f]{40}$/.test(options[key] ?? ""),
      `${key} must be an exact 40-character commit`,
    );
  }
  for (const key of ["desktop-dir", "output"]) {
    assert(
      typeof options[key] === "string" && path.isAbsolute(options[key]),
      `${key} must be an absolute path`,
    );
  }
  return options;
}

export function macAssetNames(version) {
  return [
    `PowerAI-${version}-mac-arm64.dmg`,
    `PowerAI-${version}-mac-arm64.zip`,
    `PowerAI-${version}-mac-arm64.zip.blockmap`,
    "latest-arm64-mac.yml",
    "latest-mac.yml",
  ];
}

export function validateCatalog(catalog, options) {
  assert(
    catalog?.tag_name === `v${options.version}` &&
      catalog.draft === false &&
      typeof catalog.published_at === "string",
    "Release must be published at the exact requested tag",
  );
  assert(
    catalog.prerelease === options.version.includes("-dev."),
    "Release prerelease classification does not match version",
  );
  assert(Array.isArray(catalog.assets), "Release catalog has no assets");
  const assets = new Map();
  for (const asset of catalog.assets) {
    assert(
      typeof asset.name === "string" && !assets.has(asset.name),
      "Release catalog contains duplicate or invalid asset names",
    );
    assets.set(asset.name, asset);
  }
  assert(!assets.has("notary-state.json"), "Mac finalization is still pending");
  for (const name of [...macAssetNames(options.version), "release-provenance.json"]) {
    const asset = assets.get(name);
    assert(
      asset?.state === "uploaded" &&
        Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? ""),
      `Missing or unverifiable published asset: ${name}`,
    );
  }
  return assets;
}

export function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; )
      hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function verifyAsset(file, asset, provenanceDigest) {
  assert(fs.lstatSync(file).isFile(), `Not a regular downloaded asset: ${asset.name}`);
  const digest = sha256(file);
  assert(
    fs.statSync(file).size === asset.size && `sha256:${digest}` === asset.digest,
    `GitHub digest or size mismatch: ${asset.name}`,
  );
  if (provenanceDigest !== undefined)
    assert(provenanceDigest === digest, `Provenance digest mismatch: ${asset.name}`);
  return { name: asset.name, sha256: digest, bytes: asset.size };
}

export function verifyDownloadedRelease(catalog, provenanceFile, assetsDir, options) {
  const assets = validateCatalog(catalog, options);
  const provenanceAsset = verifyAsset(provenanceFile, assets.get("release-provenance.json"));
  const provenance = json(provenanceFile);
  validateProvenance(provenance, options);
  const verified = macAssetNames(options.version).map((name) => {
    assert(/^[0-9a-f]{64}$/.test(provenance.assets[name] ?? ""), `Provenance is missing ${name}`);
    return verifyAsset(path.join(assetsDir, name), assets.get(name), provenance.assets[name]);
  });
  // Keep the existing updater metadata validator as the single implementation.
  execFileSync(
    process.execPath,
    [path.join(scriptDir, "macos-release.mjs"), "verify", assetsDir, options.version],
    { stdio: "pipe" },
  );
  return {
    provenanceAsset,
    assets: verified,
    workflowRun: provenance.workflowRun,
    bothUpdaterManifestsVerified: true,
  };
}

function validateProvenance(provenance, options) {
  assert(
    provenance.schemaVersion === 1 &&
      provenance.version === options.version &&
      provenance.desktopCommit === options["desktop-ref"] &&
      provenance.agentCommit === options["agent-ref"],
    "Published provenance version or source commit mismatch",
  );
  assert(
    new RegExp(`^https://github\\.com/${repository}/actions/runs/[0-9]+$`).test(
      provenance.workflowRun ?? "",
    ),
    "Provenance has no build workflow identity",
  );
  assert(
    provenance.assets && typeof provenance.assets === "object" && !Array.isArray(provenance.assets),
    "Provenance has no asset digests",
  );
}

export function validatePreviewEvidence(evidence, runtimeRoot) {
  assert(
    evidence?.passed === true && evidence.platform === "darwin",
    "Preview did not pass on macOS",
  );
  assert(
    evidence.rendererErrors?.total === 0 &&
      evidence.rendererErrors?.truncated === false &&
      evidence.rendererErrors?.errors?.length === 0,
    "Renderer exception evidence is missing or not clean",
  );
  const lifecycle = evidence.lifecycle;
  assert(
    lifecycle?.switch?.beforeReady === true &&
      lifecycle?.close?.beforeReady === true &&
      lifecycle?.close?.tabRemoved === true,
    "Loading-time switch/close coverage was not observed",
  );
  assert(
    lifecycle.reopen?.route === "live" &&
      lifecycle.reopen.value === "acceptance-edit" &&
      lifecycle.externalReload?.route === "live" &&
      lifecycle.externalReload.value === "acceptance-reloaded",
    "Reopen/reload did not read the expected live workbook values",
  );
  const relative = path.relative(
    fs.realpathSync(runtimeRoot),
    path.resolve(lifecycle.actualUserData ?? "/"),
  );
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Recorded userData escaped the isolated runtime directory",
  );
  assert(
    evidence.linked?.errorValues === 0 &&
      evidence.linked.editFound === true &&
      evidence.linked.externalLinkKept === true &&
      evidence.linked.imageKept === true,
    "Saved workbook fidelity checks did not pass",
  );
  for (const value of [
    evidence.ordinary?.loadMs,
    evidence.large?.fallbackMs,
    evidence.imageHeavy?.loadMs,
  ]) {
    assert(Number.isFinite(value) && value >= 0, "Missing workbook render/fallback evidence");
  }
}

// Real subprocesses and real logs; timeout kills only the new command's group.
export async function runCommand(
  command,
  args,
  { logPath, outputFile, timeoutMs = 180_000, ...options },
) {
  const log = fs.openSync(logPath, "w");
  const output = outputFile ? fs.openSync(outputFile, "wx") : undefined;
  fs.writeSync(log, `${JSON.stringify({ command, args })}\n`);
  let stdout = "";
  let timedOut = false;
  let overflow = false;
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = (signal) => {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let forced;
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    forced = setTimeout(() => kill("SIGKILL"), 2_000);
  }, timeoutMs);
  child.stdout.on("data", (data) => {
    if (output !== undefined) fs.writeSync(output, data);
    else {
      fs.writeSync(log, data);
      if (stdout.length + data.length <= 10 * 1024 * 1024) stdout += data.toString();
      else {
        overflow = true;
        kill("SIGTERM");
      }
    }
  });
  child.stderr.on("data", (data) => fs.writeSync(log, data));
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve({ code, signal, pid: child.pid, stdout, timedOut }),
      );
    });
    assert(
      !timedOut && !overflow && result.code === 0,
      `${command} ${timedOut ? "timed out" : overflow ? "exceeded output limit" : `exited ${result.code} (${result.signal ?? "no signal"})`}; see ${logPath}`,
    );
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
    fs.closeSync(log);
    if (output !== undefined) fs.closeSync(output);
  }
}

export function ownedProcesses(table, app, runtimeRoot) {
  return table.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) return [];
    // Exact unique paths, never a process name shared with another installation.
    const command = match[2];
    if (
      !command.startsWith(`${app}/Contents/`) &&
      !command.includes(`${runtimeRoot}/powerai-xlsx-budget-`)
    )
      return [];
    return [{ pid: Number(match[1]), command }];
  });
}

async function cleanupProcesses(app, runtimeRoot) {
  const list = () =>
    ownedProcesses(
      execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
      app,
      runtimeRoot,
    );
  const before = list();
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const entry of list()) {
      try {
        process.kill(entry.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (!list().length) break;
    await delay(1_500);
  }
  return { before, remaining: list() };
}

export async function verifyMacosRelease(options) {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "Official Mac acceptance requires a native macOS ARM64 runner",
  );
  // A fresh evidence directory prevents a prior screenshot/result being reused.
  fs.mkdirSync(options.output);
  const evidenceDir = fs.realpathSync(options.output);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "powerai-macos-acceptance-")));
  const assetsDir = path.join(work, "assets");
  const runtimeRoot = path.join(work, "runtime");
  const app = path.join(work, "unpacked", "PowerAI.app");
  fs.mkdirSync(assetsDir);
  fs.mkdirSync(runtimeRoot);
  fs.mkdirSync(path.join(evidenceDir, "preview"));
  const result = {
    accepted: false,
    startedAt: new Date().toISOString(),
    version: options.version,
    desktopCommit: options["desktop-ref"],
    agentCommit: options["agent-ref"],
    commands: [],
    scope:
      "Official signed Mac package spreadsheet runtime acceptance; not a Mac automatic update or a real-model/Agent conversation. External-link/image parts and marker persistence are checked, not arbitrary OOXML byte identity.",
  };
  const save = () => writeJson(path.join(evidenceDir, "execution.json"), result);
  const run = async (name, command, args, extra = {}) => {
    result.commands.push({ name, command, args });
    save();
    return runCommand(command, args, { logPath: path.join(evidenceDir, `${name}.log`), ...extra });
  };
  const payloadHashes = () =>
    Object.fromEntries(
      [
        "Contents/MacOS/PowerAI",
        "Contents/Resources/app.asar",
        "Contents/Resources/bundled-powerai-agent/darwin-arm64/powerai-agent",
      ].map((name) => {
        const file = path.join(app, name);
        assert(
          fs.realpathSync(file).startsWith(`${app}/`) && fs.statSync(file).isFile(),
          `App payload escaped its package: ${name}`,
        );
        return [name, sha256(file)];
      }),
    );
  save();
  try {
    result.runner = {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      imageVersion: process.env.ImageVersion ?? null,
    };
    await run("gui-session", "launchctl", ["print", `gui/${process.getuid()}`]);
    const head = await run("harness-commit", "git", [
      "-C",
      options["desktop-dir"],
      "rev-parse",
      "HEAD",
    ]);
    assert(
      head.stdout.trim() === options["desktop-ref"],
      "Checked-out harness commit does not match input",
    );
    result.harnessFiles = Object.fromEntries(
      ["verify.ts", "rendererErrors.ts"].map((name) => {
        const relative = `tests/manual/spreadsheet-preview-budget/${name}`;
        const digest = sha256(path.join(options["desktop-dir"], relative));
        const tracked = execFileSync("git", [
          "-C",
          options["desktop-dir"],
          "show",
          `${options["desktop-ref"]}:${relative}`,
        ]);
        assert(
          crypto.createHash("sha256").update(tracked).digest("hex") === digest,
          `Harness changed after checkout: ${name}`,
        );
        return [relative, digest];
      }),
    );
    const catalogFile = path.join(evidenceDir, "release-catalog.json");
    await run(
      "release-catalog",
      "gh",
      ["api", `repos/${repository}/releases/tags/v${options.version}`],
      { outputFile: catalogFile },
    );
    const catalog = json(catalogFile);
    const assets = validateCatalog(catalog, options);
    const provenanceFile = path.join(evidenceDir, "release-provenance.json");
    for (const name of ["release-provenance.json", ...macAssetNames(options.version)]) {
      await run(
        `download-${name}`,
        "gh",
        [
          "api",
          `repos/${repository}/releases/assets/${assets.get(name).id}`,
          "-H",
          "Accept: application/octet-stream",
        ],
        {
          outputFile:
            name === "release-provenance.json" ? provenanceFile : path.join(assetsDir, name),
          timeoutMs: 10 * 60_000,
        },
      );
      if (name === "release-provenance.json") {
        verifyAsset(provenanceFile, assets.get(name));
        validateProvenance(json(provenanceFile), options);
      }
    }
    result.release = verifyDownloadedRelease(catalog, provenanceFile, assetsDir, options);
    await run("unpack", "ditto", [
      "-x",
      "-k",
      path.join(assetsDir, `PowerAI-${options.version}-mac-arm64.zip`),
      path.dirname(app),
    ]);
    for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) {
      const value = await run(key, "plutil", [
        "-extract",
        key,
        "raw",
        "-o",
        "-",
        path.join(app, "Contents/Info.plist"),
      ]);
      assert(value.stdout.trim() === options.version, `Official app ${key} mismatch`);
    }
    const agent = json(
      path.join(app, "Contents/Resources/bundled-powerai-agent/darwin-arm64/manifest.json"),
    );
    assert(
      agent.sourceCommit === options["agent-ref"] &&
        agent.platform === "darwin" &&
        agent.arch === "arm64" &&
        Number.isInteger(agent.protocolVersion) &&
        agent.protocolVersion > 0,
      "Bundled Agent source/platform/protocol mismatch",
    );
    result.agent = {
      sourceCommit: agent.sourceCommit,
      protocolVersion: agent.protocolVersion,
      scope:
        "Signed payload hash below; manifest binarySha256 precedes signing. No Agent conversation is run.",
    };
    const arch = await run("app-architecture", "lipo", [
      "-archs",
      path.join(app, "Contents/MacOS/PowerAI"),
    ]);
    assert(
      arch.stdout.trim().split(/\s+/).includes("arm64"),
      "Official executable does not contain arm64",
    );
    const dmg = path.join(assetsDir, `PowerAI-${options.version}-mac-arm64.dmg`);
    for (const [name, command, args] of [
      ["app-codesign", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]],
      ["app-identity", "codesign", ["-dvvv", app]],
      ["app-stapler", "xcrun", ["stapler", "validate", app]],
      ["app-gatekeeper", "spctl", ["--assess", "--type", "execute", "--verbose=4", app]],
      ["dmg-codesign", "codesign", ["--verify", "--strict", "--verbose=2", dmg]],
      ["dmg-stapler", "xcrun", ["stapler", "validate", dmg]],
      [
        "dmg-gatekeeper",
        "spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          "--verbose=4",
          dmg,
        ],
      ],
    ]) {
      await run(name, command, args);
      const log = fs.readFileSync(path.join(evidenceDir, `${name}.log`), "utf8");
      if (name.endsWith("gatekeeper"))
        assert(
          log.includes("source=Notarized Developer ID") && /:\s+accepted\b/.test(log),
          `${name} did not report notarized acceptance`,
        );
      if (name === "app-identity")
        assert(
          log.includes("Authority=Developer ID Application:"),
          "App lacks a Developer ID Application signature",
        );
    }
    result.payloadBefore = payloadHashes();
    const wrapper = path.join(work, "run-preview");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nset -eu\nunset ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL POWERAI_E2E_AGENT_BINARY_PATH\nexport POWERAI_CDP_PORT=0\nexec ${quote(path.join(app, "Contents/MacOS/PowerAI"))} "$@"\n`,
      { mode: 0o700 },
    );
    fs.copyFileSync(wrapper, path.join(evidenceDir, "run-preview.txt"));
    const env = { ...process.env, TMPDIR: runtimeRoot };
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_RENDERER_URL",
      "POWERAI_E2E_AGENT_BINARY_PATH",
    ])
      delete env[key];
    result.documentEngine = {
      existingSystemCandidates: [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/opt/homebrew/bin/soffice",
        "/usr/local/bin/soffice",
      ].filter((file) => fs.existsSync(file)),
      scope:
        "Harness waits for the real product provisioning/health gate (600 seconds); no ready-state injection or provisioning bypass.",
    };
    await run(
      "runtime",
      "bun",
      [
        "tests/manual/spreadsheet-preview-budget/verify.ts",
        `--executable=${wrapper}`,
        `--evidence=${path.join(evidenceDir, "preview/evidence.json")}`,
      ],
      { cwd: options["desktop-dir"], env, timeoutMs: 20 * 60_000 },
    );
    const preview = json(path.join(evidenceDir, "preview/evidence.json"));
    validatePreviewEvidence(preview, runtimeRoot);
    const screenshot = fs.readFileSync(path.join(evidenceDir, "preview/success-screenshot.png"));
    assert(
      screenshot.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
      "Success screenshot is missing or is not PNG",
    );
    result.preview = {
      evidenceSha256: sha256(path.join(evidenceDir, "preview/evidence.json")),
      screenshotSha256: sha256(path.join(evidenceDir, "preview/success-screenshot.png")),
      lifecycle: preview.lifecycle,
      rendererErrors: preview.rendererErrors,
    };
    result.runtimePassed = true;
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
  } finally {
    if (result.payloadBefore) {
      try {
        result.payloadAfter = payloadHashes();
        assert(
          JSON.stringify(result.payloadBefore) === JSON.stringify(result.payloadAfter),
          "Official app payload changed during runtime acceptance",
        );
      } catch (error) {
        result.error ??= { message: error.message, stack: error.stack };
      }
    }
    try {
      result.cleanup = await cleanupProcesses(app, runtimeRoot);
      assert(result.cleanup.remaining.length === 0, "Owned application processes survived cleanup");
      result.cleanup.remainingScratchProfiles = fs
        .readdirSync(runtimeRoot)
        .filter((name) => name.startsWith("powerai-xlsx-budget-"));
      // A leaked profile is evidence of failed harness cleanup, even if this
      // outer owner can remove it. Never turn that failure into accepted=true.
      fs.rmSync(work, { recursive: true, force: true });
      result.cleanup.workDirectoryRemoved = true;
      assert(
        !result.runtimePassed || result.cleanup.remainingScratchProfiles.length === 0,
        "Harness left a scratch profile after successful runtime",
      );
    } catch (error) {
      result.cleanupError = error.message;
    }
    result.accepted = result.runtimePassed === true && !result.error && !result.cleanupError;
    result.completedAt = new Date().toISOString();
    save();
  }
  assert(
    result.accepted,
    result.error?.message ?? result.cleanupError ?? "Mac acceptance did not pass",
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    assert(
      command === "validate" || command === "run",
      "Usage: verify-macos-release.mjs validate|run --version=… --desktop-ref=… --agent-ref=… --desktop-dir=… --output=…",
    );
    const options = parseOptions(args);
    if (command === "run") await verifyMacosRelease(options);
    console.log(
      command === "run"
        ? "Official Mac runtime acceptance passed."
        : "Mac acceptance inputs are valid.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
