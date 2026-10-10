import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "mirror", "powerai-release-mirror.py");

// The mirror runs on the VPS with no test harness of its own; these exercise
// the decision it makes about whether a channel is already up to date, which
// is where appended macOS assets used to be missed entirely.
function evaluate(expression, setup = "") {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, sys",
        `spec = importlib.util.spec_from_file_location("mirror", ${JSON.stringify(script)})`,
        "mirror = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mirror)",
        setup,
        `print(${expression})`,
      ].join("\n"),
    ],
    { encoding: "utf8" },
  ).trim();
}

const windowsOnly = JSON.stringify({
  tag_name: "v1.2.3",
  assets: [
    { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
    { name: "latest.yml", size: 10 },
  ],
});

const withMacos = JSON.stringify({
  tag_name: "v1.2.3",
  assets: [
    { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
    { name: "latest.yml", size: 10 },
    { name: "PowerAI-1.2.3-mac-arm64.dmg", size: 300 },
    { name: "latest-arm64-mac.yml", size: 12 },
  ],
});

test("the bounded release catalog includes up to 100 releases so recent dev builds do not hide stable history", () => {
  const catalog = new URL(evaluate("mirror.REPO_API"));
  assert.equal(catalog.searchParams.get("per_page"), "100");
});

test("appending macOS assets to a published release changes the fingerprint", () => {
  // The whole reason this exists: the tag is identical in both, and keying on
  // it left the macOS assets sitting on GitHub, never mirrored.
  const before = evaluate("mirror.release_fingerprint(before)", `before = ${windowsOnly}`);
  const after = evaluate("mirror.release_fingerprint(after)", `after = ${withMacos}`);
  assert.notEqual(before, after);
  assert.match(before, /^v1\.2\.3\n/);
  assert.match(after, /mac-arm64\.dmg:300/);
});

test("the same asset set fingerprints identically regardless of order", () => {
  const forward = evaluate("mirror.release_fingerprint(r)", `r = ${withMacos}`);
  const shuffled = evaluate(
    "mirror.release_fingerprint(r)",
    `r = ${JSON.stringify({
      tag_name: "v1.2.3",
      assets: [
        { name: "latest-arm64-mac.yml", size: 12 },
        { name: "PowerAI-1.2.3-mac-arm64.dmg", size: 300 },
        { name: "latest.yml", size: 10 },
        { name: "PowerAI-1.2.3-win-x64.exe", size: 100 },
      ],
    })}`,
  );
  assert.equal(forward, shuffled);
});

test("a replaced asset of a different size changes the fingerprint", () => {
  const original = evaluate("mirror.release_fingerprint(r)", `r = ${windowsOnly}`);
  const rebuilt = evaluate(
    "mirror.release_fingerprint(r)",
    `r = ${JSON.stringify({
      tag_name: "v1.2.3",
      assets: [
        { name: "PowerAI-1.2.3-win-x64.exe", size: 101 },
        { name: "latest.yml", size: 10 },
      ],
    })}`,
  );
  assert.notEqual(original, rebuilt);
});

const installer = (version, arch = "x64") => `PowerAI-${version}-win-${arch}.exe`;
const blockmap = (version, arch) => `${installer(version, arch)}.blockmap`;
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-mirror-"));
  const dest = path.join(directory, "mirror");
  fs.mkdirSync(dest);
  const releases = [];
  const bodies = new Map();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/releases") return response.end(JSON.stringify(releases));
    const body = request.url.startsWith("/mirror/")
      ? (() => {
          const file = path.join(directory, request.url);
          return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
        })()
      : bodies.get(request.url);
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body ?? "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function publish(version, arches = ["x64"]) {
    const release = { tag_name: `v${version}`, prerelease: version.includes("-"), assets: [] };
    const contents = new Map([
      ["latest.yml", `version: ${version}\n`],
      ...arches.flatMap((arch) => [
        [installer(version, arch), `installer ${version} ${arch}`],
        [blockmap(version, arch), `blocks ${version} ${arch}`],
      ]),
    ]);
    const update = () => {
      const provenance = JSON.stringify({
        assets: Object.fromEntries([...contents].map(([name, body]) => [name, sha256(body)])),
      });
      release.assets = [...contents, ["release-provenance.json", provenance]].map(
        ([name, body]) => {
          const url = `/assets/${version}/${name}`;
          bodies.set(url, body);
          return { name, size: Buffer.byteLength(body), browser_download_url: `${base}${url}` };
        },
      );
    };
    update();
    releases.push(release);
    return { release, contents, update };
  }
  async function run() {
    const child = spawn("python3", [
      "-B",
      "-c",
      [
        "import importlib.util, sys",
        `spec = importlib.util.spec_from_file_location("mirror", ${JSON.stringify(script)})`,
        "mirror = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mirror)",
        `mirror.DEST = ${JSON.stringify(dest)}`,
        `mirror.LOCK_PATH = ${JSON.stringify(path.join(directory, "lock"))}`,
        `mirror.REPO_API = ${JSON.stringify(`${base}/releases`)}`,
        "sys.exit(mirror.main())",
      ].join("\n"),
    ]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output };
  }
  return { dest, base, releases, bodies, requests, publish, run };
}

test("real HTTP mirroring retains bounded same-channel and stable-to-dev blockmaps without old installers", async (t) => {
  const f = await fixture(t);
  for (const version of [
    "0.7.0",
    "0.8.0",
    "0.9.0",
    "1.0.0",
    "1.1.0-dev.1",
    "1.1.0-dev.2",
    "1.1.0-dev.3",
    "1.1.0-dev.4",
  ]) {
    f.publish(version, ["x64", "arm64"]);
  }
  assert.equal((await f.run()).code, 0);
  for (const [channel, versions] of [
    ["latest", ["0.8.0", "0.9.0"]],
    ["dev", ["1.0.0", "1.1.0-dev.2", "1.1.0-dev.3"]],
  ]) {
    for (const version of versions) {
      for (const arch of ["x64", "arm64"]) {
        const response = await fetch(`${f.base}/mirror/${channel}/${blockmap(version, arch)}`);
        assert.equal(response.status, 200, `${channel} must retain ${version} ${arch}`);
        assert.equal(await response.text(), `blocks ${version} ${arch}`);
        assert.equal(fs.existsSync(path.join(f.dest, channel, installer(version, arch))), false);
      }
    }
  }
  assert.equal(fs.existsSync(path.join(f.dest, "latest", blockmap("0.7.0"))), false);
  assert.equal(fs.existsSync(path.join(f.dest, "dev", blockmap("1.1.0-dev.1"))), false);
  assert.equal(
    f.requests.some((url) => url.endsWith(installer("0.9.0"))),
    false,
  );
  f.requests.length = 0;
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(
    f.requests.filter(
      (url) => url.startsWith("/assets/") && !url.endsWith("release-provenance.json"),
    ),
    [],
  );
  fs.mkdirSync(path.join(f.dest, "hold"));
  fs.writeFileSync(path.join(f.dest, "hold", "manual-build"), "kept");
  fs.mkdirSync(path.join(f.dest, "obsolete-release"));
  f.publish("1.0.1");
  f.publish("1.1.0-dev.5");
  assert.equal((await f.run()).code, 0);
  assert.ok(fs.existsSync(path.join(f.dest, "dev", blockmap("1.0.1"))));
  assert.ok(fs.existsSync(path.join(f.dest, "dev", blockmap("1.1.0-dev.4"))));
  assert.equal(fs.existsSync(path.join(f.dest, "dev", blockmap("1.1.0-dev.2"))), false);
  assert.equal(fs.existsSync(path.join(f.dest, "dev", blockmap("1.0.0"))), false);
  assert.equal(fs.existsSync(path.join(f.dest, "latest", blockmap("0.8.0"))), false);
  assert.equal(fs.existsSync(path.join(f.dest, "obsolete-release")), false);
  assert.equal(fs.readFileSync(path.join(f.dest, "hold", "manual-build"), "utf8"), "kept");
});

test("migrating an existing channel adds history and appended assets without downloading its installers again", async (t) => {
  const f = await fixture(t);
  f.publish("0.9.0");
  const current = f.publish("1.0.0");
  for (const channel of ["latest", "dev"]) {
    fs.mkdirSync(path.join(f.dest, channel));
    for (const asset of current.release.assets) {
      fs.writeFileSync(
        path.join(f.dest, channel, asset.name),
        f.bodies.get(new URL(asset.browser_download_url).pathname),
      );
    }
    fs.writeFileSync(path.join(f.dest, channel, ".tag"), "v1.0.0");
    fs.writeFileSync(
      path.join(f.dest, channel, ".fingerprint"),
      evaluate(
        "mirror.release_fingerprint(r)",
        `import json; r = json.loads(${JSON.stringify(JSON.stringify(current.release))})`,
      ),
    );
  }
  const previous = fs.readFileSync(path.join(f.dest, "dev", ".fingerprint"), "utf8");
  assert.equal((await f.run()).code, 0);
  assert.ok(fs.existsSync(path.join(f.dest, "dev", blockmap("0.9.0"))));
  assert.notEqual(fs.readFileSync(path.join(f.dest, "dev", ".fingerprint"), "utf8"), previous);
  assert.equal(
    f.requests.some((url) => url.endsWith(".exe")),
    false,
  );
  f.requests.length = 0;
  current.contents.set("PowerAI-1.0.0-mac-arm64.dmg", "notarized image");
  current.update();
  assert.equal((await f.run()).code, 0);
  assert.equal(
    fs.readFileSync(path.join(f.dest, "dev", "PowerAI-1.0.0-mac-arm64.dmg"), "utf8"),
    "notarized image",
  );
  assert.equal(
    f.requests.some((url) => url.endsWith(".exe")),
    false,
  );
  // Reuse is based on a fresh digest, not the presence of a filename/marker.
  fs.writeFileSync(path.join(f.dest, "dev", installer("1.0.0")), "corrupt local installer");
  current.contents.set("latest-mac.yml", "version: 1.0.0\n");
  current.update();
  assert.equal((await f.run()).code, 0);
  assert.ok(f.requests.some((url) => url.endsWith(installer("1.0.0"))));
  assert.equal(
    fs.readFileSync(path.join(f.dest, "dev", installer("1.0.0")), "utf8"),
    "installer 1.0.0 x64",
  );
});

test("historical checksum changes refresh the fingerprint and reject corrupt downloads before switching a channel", async (t) => {
  const f = await fixture(t);
  const old = f.publish("0.9.0");
  f.publish("1.0.0");
  assert.equal((await f.run()).code, 0);
  const fingerprint = fs.readFileSync(path.join(f.dest, "latest", ".fingerprint"), "utf8");
  const name = blockmap("0.9.0");
  old.contents.set(name, old.contents.get(name).replace("blocks", "BLOCKS"));
  old.update();
  const expected = old.contents.get(name);
  f.bodies.set(`/assets/0.9.0/${name}`, "corrupted");
  const failed = await f.run();
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /HASH MISMATCH/);
  assert.equal(fs.readFileSync(path.join(f.dest, "latest", ".fingerprint"), "utf8"), fingerprint);
  assert.equal(fs.readFileSync(path.join(f.dest, "latest", name), "utf8"), "blocks 0.9.0 x64");
  assert.equal(
    fs.readdirSync(f.dest).some((name) => name.startsWith(".staging-")),
    false,
  );
  f.bodies.set(`/assets/0.9.0/${name}`, expected);
  f.requests.length = 0;
  assert.equal((await f.run()).code, 0);
  assert.notEqual(
    fs.readFileSync(path.join(f.dest, "latest", ".fingerprint"), "utf8"),
    fingerprint,
  );
  assert.equal(fs.readFileSync(path.join(f.dest, "latest", name), "utf8"), expected);
  assert.equal(
    f.requests.some((url) => url.endsWith(".exe")),
    false,
  );
});

test("unavailable or unverified history leaves both installed channels intact", async (t) => {
  const f = await fixture(t);
  f.publish("1.0.0");
  assert.equal((await f.run()).code, 0);
  const fingerprints = Object.fromEntries(
    ["latest", "dev"].map((channel) => [
      channel,
      fs.readFileSync(path.join(f.dest, channel, ".fingerprint"), "utf8"),
    ]),
  );
  const old = f.publish("0.9.0");
  const url = "/assets/0.9.0/release-provenance.json";
  const provenance = f.bodies.get(url);
  f.bodies.delete(url);
  assert.notEqual((await f.run()).code, 0);
  const parsed = JSON.parse(provenance);
  delete parsed.assets[blockmap("0.9.0")];
  f.bodies.set(url, JSON.stringify(parsed));
  assert.notEqual((await f.run()).code, 0);
  parsed.assets[blockmap("0.9.0")] = "";
  f.bodies.set(url, JSON.stringify(parsed));
  assert.match((await f.run()).output, /invalid provenance/);
  for (const channel of ["latest", "dev"]) {
    assert.equal(
      fs.readFileSync(path.join(f.dest, channel, ".fingerprint"), "utf8"),
      fingerprints[channel],
    );
    assert.equal(fs.existsSync(path.join(f.dest, channel, blockmap("0.9.0"))), false);
  }
  old.update();
  assert.equal((await f.run()).code, 0);
  assert.equal((await fetch(`${f.base}/mirror/dev/${blockmap("0.9.0")}`)).status, 200);
});

test("a previous verified channel survives an interrupted directory swap", async (t) => {
  const f = await fixture(t);
  f.publish("1.0.0");
  assert.equal((await f.run()).code, 0);
  const before = fs.readFileSync(path.join(f.dest, "dev", ".fingerprint"), "utf8");
  fs.renameSync(path.join(f.dest, "dev"), path.join(f.dest, ".previous-dev"));
  fs.mkdirSync(path.join(f.dest, ".staging-dev"));
  fs.writeFileSync(path.join(f.dest, ".staging-dev", ".tag"), "partial");
  f.requests.length = 0;
  assert.equal((await f.run()).code, 0);
  assert.equal(fs.readFileSync(path.join(f.dest, "dev", ".fingerprint"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(f.dest, ".previous-dev")), false);
  assert.equal(fs.existsSync(path.join(f.dest, ".staging-dev")), false);
  assert.equal(
    f.requests.some((url) => url.endsWith(".exe")),
    false,
  );
});
