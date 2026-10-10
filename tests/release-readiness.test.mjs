import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import test from "node:test";
import { prepareRelease, waitForRelease } from "../scripts/release-readiness.mjs";

const desktop = "a".repeat(40);
const agent = "b".repeat(40);
const tooling = "c".repeat(40);
const repository = "dztabel-happy/powerai-releases";
const buildUrl = `https://github.com/${repository}/actions/runs/123`;
const input = { version: "1.1.0-dev.2", desktopRef: desktop, agentRef: agent, windowsArm64: false };
const sha = (body) => crypto.createHash("sha256").update(body).digest("hex");
const sha512 = (body) => crypto.createHash("sha512").update(body).digest("base64");
const windows = (version, arch) => [
  `PowerAI-${version}-win-${arch}.exe`,
  `PowerAI-${version}-win-${arch}.exe.blockmap`,
  `PowerAI-${version}-win-${arch}.zip`,
  arch === "arm64" ? "latest-win-arm64.yml" : "latest.yml",
  arch === "arm64" ? "powerai-staged-update-arm64.json" : "powerai-staged-update.json",
];

async function fixture(t, { arm = true } = {}) {
  const releases = [];
  const bodies = new Map();
  const requests = [];
  const failures = new Map();
  let hook;
  let catalog;
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      range: request.headers.range,
      authorization: request.headers.authorization,
    });
    hook?.(request);
    const failure = failures.get(request.url);
    if (failure) {
      if (failure.count !== Infinity) failure.count -= 1;
      if (failure.count <= 0) failures.delete(request.url);
      if (failure.disconnect) {
        response.writeHead(200, { "Content-Length": 32 });
        response.write("partial");
        setImmediate(() => response.destroy());
        return;
      }
      response.statusCode = failure.status;
      return response.end("unavailable");
    }
    let body;
    if (request.url === `/repos/${repository}/releases?per_page=100`)
      body = Buffer.from(JSON.stringify(catalog ?? releases));
    else if (request.url === `/repos/${repository}/releases/latest`)
      body = Buffer.from(JSON.stringify(releases.find((release) => release.tag_name === "v1.0.0")));
    else if (request.url === `/repos/${repository}/actions/runs/123`)
      body = Buffer.from(JSON.stringify({ id: 123, head_sha: tooling }));
    else if (request.url.startsWith(`/repos/${repository}/releases/tags/`)) {
      const release = releases.find((item) => item.tag_name === request.url.split("/").at(-1));
      if (release) body = Buffer.from(JSON.stringify(release));
    } else body = bodies.get(request.url);
    if (!body) {
      response.statusCode = 404;
      return response.end("missing");
    }
    if (request.headers.range) {
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes 0-0/${body.length}`);
      return response.end(body.subarray(0, 1));
    }
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  function publish(version, arches = ["x64"], mac = true) {
    const contents = new Map();
    const release = {
      id: releases.length + 1,
      tag_name: `v${version}`,
      prerelease: version.includes("-"),
      draft: false,
      published_at: "2026-10-10T12:00:00Z",
      assets: [],
    };
    for (const arch of arches) {
      const [exe, blockmap, zip, yml, staged] = windows(version, arch);
      contents.set(exe, Buffer.alloc(5 * 1024 * 1024 + 1, arch === "x64" ? 65 : 66));
      contents.set(blockmap, Buffer.from(`blockmap ${version} ${arch}`));
      contents.set(zip, Buffer.from(`zip ${version} ${arch}`));
      contents.set(
        yml,
        Buffer.from(
          `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512(contents.get(exe))}\n    size: ${contents.get(exe).length}\npath: ${exe}\n`,
        ),
      );
      contents.set(
        staged,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            version,
            zip: { name: zip, sha512: sha512(contents.get(zip)), size: contents.get(zip).length },
          }),
        ),
      );
    }
    const addMac = () => {
      for (const suffix of ["dmg", "zip", "zip.blockmap"])
        contents.set(
          `PowerAI-${version}-mac-arm64.${suffix}`,
          Buffer.from(`mac ${version} ${suffix}`),
        );
      for (const name of ["latest-mac.yml", "latest-arm64-mac.yml"])
        contents.set(name, Buffer.from(`version: ${version}\n`));
    };
    if (mac) addMac();
    const update = (overrides = {}) => {
      const provenance = {
        schemaVersion: 1,
        version,
        platform: arches.includes("arm64") ? "windows-x64-arm64" : "windows-x64",
        desktopCommit: desktop,
        agentCommit: agent,
        workflowRun: buildUrl,
        assets: Object.fromEntries(
          [...contents]
            .filter(([name]) => name !== "notary-state.json")
            .map(([name, body]) => [name, sha(body)]),
        ),
        ...overrides,
      };
      const raw = Buffer.from(JSON.stringify(provenance));
      release.assets = [...contents, ["release-provenance.json", raw]].map(([name, body]) => {
        const url = `/assets/${version}/${name}`;
        bodies.set(url, body);
        return {
          name,
          size: body.length,
          digest: `sha256:${sha(body)}`,
          state: "uploaded",
          browser_download_url: base + url,
        };
      });
      return provenance;
    };
    update();
    releases.unshift(release);
    return { release, contents, update, addMac };
  }
  const stable = publish("1.0.0");
  const previous0 = publish("1.1.0-dev.0", arm ? ["x64", "arm64"] : ["x64"]);
  const previous = publish("1.1.0-dev.1", arm ? ["x64", "arm64"] : ["x64"]);
  const mirror = (item, channel, retained = null, history = []) => {
    for (const name of [...bodies.keys()])
      if (name.startsWith(`/mirror/${channel}/`)) bodies.delete(name);
    for (const asset of item.release.assets)
      bodies.set(
        `/mirror/${channel}/${asset.name}`,
        bodies.get(new URL(asset.browser_download_url).pathname),
      );
    if (retained) {
      for (const name of windows(retained.release.tag_name.slice(1), "arm64"))
        bodies.set(`/mirror/${channel}/${name}`, retained.contents.get(name));
      bodies.set(
        `/mirror/${channel}/release-provenance-win-arm64.json`,
        bodies.get(`/assets/${retained.release.tag_name.slice(1)}/release-provenance.json`),
      );
    }
    for (const old of history) {
      for (const asset of old.release.assets)
        if (/-win-(x64|arm64)\.exe\.blockmap$/.test(asset.name))
          bodies.set(
            `/mirror/${channel}/${asset.name}`,
            bodies.get(new URL(asset.browser_download_url).pathname),
          );
    }
  };
  mirror(stable, "latest");
  mirror(previous, "dev", arm ? previous : null, [previous0, stable]);
  const deps = {
    apiBase: base,
    mirrorBase: `${base}/mirror`,
    env: {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: tooling,
      GH_TOKEN: "test-secret-not-to-be-serialized",
    },
    pollIntervalMs: 5,
  };
  return {
    base,
    deps,
    releases,
    bodies,
    requests,
    failures,
    publish,
    stable,
    previous,
    previous0,
    mirror,
    setCatalog: (value) => {
      catalog = value;
    },
    setHook: (value) => {
      hook = value;
    },
  };
}

const wait = (plan, f, phase = "windows") =>
  waitForRelease(plan, { phase, timeoutSeconds: 2 }, f.deps);

async function assertPendingTimeout(plan, f, phase, reason) {
  const pending = [];
  let elapsed = 0;
  // HTTP remains real and gets a 15-second request budget. Only polling advances
  // the logical deadline, so runner load cannot replace the observed failure.
  await assert.rejects(
    waitForRelease(
      plan,
      { phase, timeoutSeconds: 30 },
      {
        ...f.deps,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        pollIntervalMs: 15000,
        onPending: (state) => pending.push(state),
      },
    ),
    (error) => {
      assert.equal(error.report.status, "failed");
      assert.equal(error.report.attempts, 2);
      assert.equal(error.message, `Readiness timed out: ${reason}`);
      return true;
    },
  );
  assert.equal(elapsed, 30000);
  assert.deepEqual(pending, [
    { attempts: 1, reason },
    { attempts: 2, reason },
  ]);
}

function publishTarget(f, { mac = false, arm = false } = {}) {
  const target = f.publish(input.version, arm ? ["x64", "arm64"] : ["x64"], mac);
  f.mirror(target, "dev", arm ? target : f.previous, [f.previous, f.previous0, f.stable]);
  return target;
}

test("prepare freezes original bytes and the latest complete source, without serializing tokens", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  assert.deepEqual(plan.requiredArches, ["x64"]);
  assert.equal(plan.previous.x64.version, "1.1.0-dev.1");
  assert.equal(plan.retainedArmTag, "v1.1.0-dev.1");
  assert.equal(plan.expectedBuild.buildUrl, buildUrl);
  assert.equal(Object.keys(plan.history).length, 5);
  assert.equal(
    plan.snapshots[plan.retainedArmTag].provenance.raw,
    f.bodies.get("/assets/1.1.0-dev.1/release-provenance.json").toString(),
  );
  assert.ok(!JSON.stringify(plan).includes("test-secret"));
  assert.ok(
    f.requests
      .filter((r) => r.url.startsWith("/repos/"))
      .every((r) => r.authorization === "Bearer test-secret-not-to-be-serialized"),
  );
  assert.ok(
    f.requests
      .filter((r) => !r.url.startsWith("/repos/"))
      .every((r) => r.authorization === undefined),
  );
});

test("real HTTP windows readiness retains the ARM source and five historical maps", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f);
  const result = await wait(plan, f);
  assert.equal(result.status, "passed");
  assert.equal(result.macComplete, false);
  assert.equal(result.provenanceAssets, 5);
  assert.equal(result.retainedArmVersion, "1.1.0-dev.1");
  assert.ok(result.mirrorChecks.some((check) => check.verification === "range-and-size"));
  assert.equal(
    result.mirrorChecks.filter((check) => /dev\.[01]-win-.+blockmap/.test(check.name)).length,
    4,
  );
  assert.ok(result.stableChecks.length > 0);
});

test("a coherent full Mac append is accepted in either phase; Windows bytes remain the same", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f, { mac: true });
  for (const phase of ["windows", "complete"]) {
    const result = await wait(plan, f, phase);
    assert.equal(result.status, "passed");
    assert.equal(result.macComplete, true);
    assert.equal(result.provenanceAssets, 10);
    assert.equal(result.publishedAssets, 11);
  }
});

test("pending marker and partial Mac assets never turn a bounded wait green", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  target.contents.set("notary-state.json", Buffer.from("{}"));
  target.update();
  f.mirror(target, "dev", f.previous, [f.previous, f.previous0, f.stable]);
  assert.equal((await wait(plan, f)).macComplete, false);
  await assertPendingTimeout(plan, f, "complete", "Mac notarization/assets are still pending");
  target.contents.set(`PowerAI-${input.version}-mac-arm64.dmg`, Buffer.from("partial"));
  target.update();
  await assertPendingTimeout(plan, f, "windows", "Mac assets are being appended");
});

test("missing HTTP files and transient 503 retry, then pass only when actual bytes arrive", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  const url = `/mirror/dev/PowerAI-${input.version}-win-x64.exe.blockmap`;
  f.failures.set(url, { status: 503, count: 1 });
  const result = await wait(plan, f);
  assert.ok(result.attempts >= 2);
  f.bodies.delete(url);
  await assertPendingTimeout(plan, f, "windows", `HTTP 404: ${url}`);
  f.bodies.set(url, target.contents.get(`PowerAI-${input.version}-win-x64.exe.blockmap`));
});

test("same-snapshot corrupted metadata fails immediately instead of retrying to success", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f);
  f.bodies.set("/mirror/dev/latest.yml", Buffer.from("bad digest"));
  await assert.rejects(
    wait(plan, f),
    (error) => error.report?.attempts === 1 && /hash\/size mismatch/.test(error.message),
  );
});

test("an incorrect build/source identity or omitted-but-published ARM fails closed", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  target.update({ workflowRun: buildUrl.replace("123", "456") });
  await assert.rejects(wait(plan, f), /source\/build identity/);
  target.update({ desktopCommit: "d".repeat(40) });
  await assert.rejects(wait(plan, f), /source\/build identity/);
  target.update();
  target.release.assets.push({ name: `PowerAI-${input.version}-win-arm64.exe`, size: 1 });
  await assert.rejects(wait(plan, f), /Unexpected Windows ARM/);
});

test("stable source/provenance and retained ARM original bytes must remain unchanged", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f);
  const arm = "/mirror/dev/release-provenance-win-arm64.json";
  const original = f.bodies.get(arm);
  f.bodies.set(arm, Buffer.from(`${original}\n`));
  await assert.rejects(wait(plan, f), /hash\/size mismatch/);
  f.bodies.set(arm, original);
  f.stable.update({ desktopCommit: "d".repeat(40) });
  await assert.rejects(wait(plan, f), /Stable original provenance changed/);
});

test("ARM-selected plans require a real prior ARM source and accept a new complete ARM suite", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease({ ...input, windowsArm64: true }, f.deps);
  assert.equal(plan.previous.arm64.version, "1.1.0-dev.1");
  publishTarget(f, { arm: true });
  const result = await wait(plan, f);
  assert.equal(result.provenanceAssets, 10);
  assert.equal(result.retainedArmVersion, input.version);
});

test("first ARM publication cannot fabricate an installed-upgrade source", async (t) => {
  const f = await fixture(t, { arm: false });
  await assert.rejects(
    prepareRelease({ ...input, windowsArm64: true }, f.deps),
    /No complete public previous arm64/,
  );
});

test("stable source selection never uses a prerelease ARM package", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease({ ...input, version: "1.1.0" }, f.deps);
  assert.equal(plan.channel, "stable");
  assert.equal(plan.previous.x64.version, "1.0.0");
  assert.equal(plan.retainedArmTag, null);
  await assert.rejects(
    prepareRelease({ ...input, version: "1.1.0", windowsArm64: true }, f.deps),
    /No complete public previous arm64/,
  );
});

test("catalog-external retained ARM is checked against its official original provenance", async (t) => {
  const f = await fixture(t);
  const old = f.previous;
  // Tag lookup still serves the source, while the actual HTTP catalog omits it.
  const current = f.publish("1.1.0-dev.1.1", ["x64"]);
  f.mirror(current, "dev", old, [f.previous, f.previous0, f.stable]);
  f.setCatalog([current.release, f.stable.release]);
  const plan = await prepareRelease(input, f.deps);
  assert.equal(plan.retainedArmTag, old.release.tag_name);
  assert.equal(
    plan.snapshots[old.release.tag_name].provenance.sha256,
    sha(f.bodies.get("/assets/1.1.0-dev.1/release-provenance.json")),
  );
});

test("a provenance append during snapshot is retried and never treated as an integrity failure", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  let reads = 0;
  f.setHook((request) => {
    if (request.url === `/assets/${input.version}/release-provenance.json` && ++reads === 2) {
      target.addMac();
      target.update();
      f.mirror(target, "dev", f.previous, [f.previous, f.previous0, f.stable]);
    }
  });
  const result = await wait(plan, f);
  assert.ok(result.attempts >= 2);
  assert.equal(result.macComplete, true);
});

test("a later public release fails current-target validation rather than certifying stale release", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f);
  f.publish("1.1.0-dev.3");
  await assert.rejects(wait(plan, f), /superseded/);
});

test("ordinary asset downloads and API asset ordering do not invalidate a stable snapshot", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  f.setHook(() => {
    for (const asset of target.release.assets)
      asset.download_count = (asset.download_count ?? 0) + 1;
    target.release.assets.reverse();
  });
  assert.equal((await wait(plan, f)).attempts, 1);
});

test("prepare rejects existing tags outside the catalog and unpublished lower channel versions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareRelease({ ...input, version: "1.1.0-dev.0.1" }, f.deps),
    /newer than the current channel/,
  );
  f.setCatalog([f.previous.release, f.stable.release]);
  await assert.rejects(
    prepareRelease({ ...input, version: "1.1.0-dev.0" }, f.deps),
    /already exists/,
  );
});

test("plan file references cannot override frozen provenance or stable payload baselines", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  publishTarget(f);
  const cases = [
    (copy) => {
      copy.history[Object.keys(copy.history)[0]].sha256 = "d".repeat(64);
    },
    (copy) => {
      delete copy.stableFiles["latest.yml"];
    },
    (copy) => {
      copy.previous.x64.version = "0.9.0";
    },
    (copy) => {
      copy.retainedArmTag = copy.stableTag;
    },
  ];
  for (const alter of cases) {
    const copy = structuredClone(plan);
    alter(copy);
    await assert.rejects(wait(copy, f), /anchor|baseline|previous version|architecture source/);
  }
});

test("a dropped HTTP response is retried but incorrect Range support or size is fatal", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  f.failures.set("/mirror/dev/latest.yml", { count: 1, disconnect: true });
  assert.ok((await wait(plan, f)).attempts >= 2);
  const exe = `PowerAI-${input.version}-win-x64.exe`;
  f.failures.set(`/mirror/dev/${exe}`, { count: 1, status: 200 });
  await assert.rejects(
    wait(plan, f),
    (error) => error.report?.attempts === 1 && /Unexpected HTTP 200/.test(error.message),
  );
  f.bodies.set(`/mirror/dev/${exe}`, Buffer.concat([target.contents.get(exe), Buffer.from("x")]));
  await assert.rejects(wait(plan, f), /Range\/size mismatch/);
});

test("an old mirror only passes after the actual target feed arrives", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = f.publish(input.version, ["x64"], false);
  let reads = 0;
  f.setHook((request) => {
    if (request.url === "/mirror/dev/release-provenance.json" && ++reads === 2)
      f.mirror(target, "dev", f.previous, [f.previous, f.previous0, f.stable]);
  });
  assert.equal((await wait(plan, f)).attempts, 2);
});

test("real prepare/wait CLI writes the workflow outputs and a failed bounded-wait record", async (t) => {
  const f = await fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "powerai-readiness-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "http-fixture.mjs");
  // Test-only loader sends the unmodified CLI's fixed public URLs to this real HTTP fixture.
  fs.writeFileSync(
    preload,
    `const original = globalThis.fetch;
     globalThis.fetch = (url, options) => original(String(url).replace("https://api.github.com", ${JSON.stringify(f.base)}).replace("https://powerai.dztabel.com/releases", ${JSON.stringify(`${f.base}/mirror`)}), options);
     // Advance only the CLI's 60-second readiness polling sleep; HTTP requests
     // and their native AbortSignal timeouts still run against the real server.
     let now = Date.now();
     Date.now = () => now;
     const timeout = globalThis.setTimeout;
     globalThis.setTimeout = (callback, delay, ...args) => {
       if (delay === 60000) { now += delay; return timeout(callback, 0, ...args); }
       return timeout(callback, delay, ...args);
     };`,
  );
  const planFile = path.join(directory, "release-plan.json");
  const resultFile = path.join(directory, "result.json");
  const outputFile = path.join(directory, "github-output");
  const script = path.resolve(import.meta.dirname, "../scripts/release-readiness.mjs");
  const invoke = (args) =>
    promisify(execFile)(process.execPath, ["--import", preload, script, ...args], {
      env: { ...process.env, ...f.deps.env, GITHUB_OUTPUT: outputFile },
      timeout: 10000,
    });
  await invoke([
    "prepare",
    "--version",
    input.version,
    "--desktop-ref",
    desktop,
    "--agent-ref",
    agent,
    "--windows-arm64",
    "false",
    "--output",
    planFile,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(planFile)).status, "prepared");
  assert.equal(
    fs.readFileSync(outputFile, "utf8"),
    'channel=dev\nfrom_x64=1.1.0-dev.1\nfrom_arm64=\nwindows_matrix={"include":[{"arch":"x64","from_version":"1.1.0-dev.1"}]}\n',
  );
  publishTarget(f);
  await invoke([
    "wait",
    "--plan",
    planFile,
    "--phase",
    "windows",
    "--output",
    resultFile,
    "--timeout-seconds",
    "2",
  ]);
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).status, "passed");
  await assert.rejects(
    invoke([
      "wait",
      "--plan",
      planFile,
      "--phase",
      "complete",
      "--output",
      resultFile,
      "--timeout-seconds",
      "60",
    ]),
    (error) => error.code === 1,
  );
  const failed = JSON.parse(fs.readFileSync(resultFile));
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.reason, "Readiness timed out: Mac notarization/assets are still pending");
});

test("an in-progress GitHub asset upload is bounded pending rather than a corrupt release", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  const asset = target.release.assets.find((item) => item.name === "release-provenance.json");
  const original = { ...asset };
  asset.state = "starter";
  asset.size = 0;
  let reads = 0;
  f.setHook((request) => {
    if (request.url === `/repos/${repository}/releases/tags/v${input.version}` && ++reads === 2)
      Object.assign(asset, original);
  });
  assert.equal((await wait(plan, f)).attempts, 2);
});

test("a zero-size upload seen on the second API snapshot is retried before digest checks", async (t) => {
  const f = await fixture(t);
  const plan = await prepareRelease(input, f.deps);
  const target = publishTarget(f);
  const asset = target.release.assets.find((item) => item.name === "release-provenance.json");
  const original = { ...asset };
  let reads = 0;
  f.setHook((request) => {
    if (request.url !== `/repos/${repository}/releases/tags/v${input.version}`) return;
    reads += 1;
    if (reads === 2) Object.assign(asset, { state: "starter", size: 0 });
    if (reads === 3) Object.assign(asset, original);
  });
  assert.equal((await wait(plan, f)).attempts, 2);
});
