#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = "dztabel-happy/powerai-releases";
const apiBase = "https://api.github.com";
const mirrorBase = "https://powerai.dztabel.com/releases";
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const provenanceName = "release-provenance.json";
const armProvenanceName = "release-provenance-win-arm64.json";
const smallLimit = 5 * 1024 * 1024;
const hash = (body) => crypto.createHash("sha256").update(body).digest("hex");
const versionOf = (release) => release.tag_name.replace(/^v/, "");
const windowsNames = (version, arch) => [
  `PowerAI-${version}-win-${arch}.exe`,
  `PowerAI-${version}-win-${arch}.exe.blockmap`,
  `PowerAI-${version}-win-${arch}.zip`,
  arch === "arm64" ? "latest-win-arm64.yml" : "latest.yml",
  arch === "arm64" ? "powerai-staged-update-arm64.json" : "powerai-staged-update.json",
];
const macNames = (version) => [
  `PowerAI-${version}-mac-arm64.dmg`,
  `PowerAI-${version}-mac-arm64.zip`,
  `PowerAI-${version}-mac-arm64.zip.blockmap`,
  "latest-mac.yml",
  "latest-arm64-mac.yml",
];

class ReadinessError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}
const requireValue = (condition, message) => {
  if (!condition) throw new ReadinessError(message);
};
const pending = (message) => {
  throw new ReadinessError(message, true);
};

function compareVersions(left, right) {
  const [a, ...ap] = left.split("-");
  const [b, ...bp] = right.split("-");
  const ac = a.split(".").map(Number);
  const bc = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (ac[i] !== bc[i]) return ac[i] - bc[i];
  if (!ap.length || !bp.length) return Number(!ap.length) - Number(!bp.length);
  const aa = ap.join("-").split(".");
  const bb = bp.join("-").split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if (aa[i] === undefined || bb[i] === undefined) return aa.length - bb.length;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]);
    const bn = /^\d+$/.test(bb[i]);
    if (an && bn) return Number(aa[i]) - Number(bb[i]);
    if (an !== bn) return an ? -1 : 1;
    return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

function assetMap(release) {
  requireValue(Array.isArray(release.assets), "Release assets are missing");
  const entries = release.assets.map((asset) => {
    requireValue(
      typeof asset.name === "string" &&
        /^[A-Za-z0-9_.-]+$/.test(asset.name) &&
        ![".", ".."].includes(asset.name),
      "Invalid asset name",
    );
    requireValue(
      Number.isSafeInteger(asset.size) && asset.size > 0,
      `Invalid asset size: ${asset.name}`,
    );
    return [asset.name, asset];
  });
  requireValue(
    new Set(entries.map(([name]) => name)).size === entries.length,
    "Duplicate release asset names",
  );
  return Object.fromEntries(entries);
}

function parseProvenance(raw, version) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ReadinessError(`Invalid provenance JSON for ${version}`);
  }
  requireValue(
    value.version === version &&
      value.assets &&
      typeof value.assets === "object" &&
      !Array.isArray(value.assets),
    `Invalid provenance identity for ${version}`,
  );
  for (const [name, digest] of Object.entries(value.assets)) {
    requireValue(
      /^[A-Za-z0-9_.-]+$/.test(name) && ![".", ".."].includes(name) && digestPattern.test(digest),
      `Invalid provenance digest: ${name}`,
    );
  }
  return value;
}

function runtime(deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const api = deps.apiBase ?? apiBase;
  const mirror = deps.mirrorBase ?? mirrorBase;
  const deadline = deps.deadline ?? Infinity;
  const request = async (url, { github = false, range = false, optional = false } = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) pending("Readiness deadline reached");
    let response;
    try {
      response = await fetcher(url, {
        headers: {
          "User-Agent": "powerai-release-readiness",
          ...(github
            ? {
                Accept: "application/vnd.github+json",
                ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}),
              }
            : {}),
          ...(range ? { Range: "bytes=0-0" } : {}),
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining))),
      });
    } catch {
      pending(`Network request failed: ${new URL(url).pathname}`);
    }
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (
      [404, 408, 429].includes(response.status) ||
      response.status >= 500 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      await response.body?.cancel();
      pending(`HTTP ${response.status}: ${new URL(url).pathname}`);
    }
    if (!response.ok || (range && response.status !== 206)) {
      await response.body?.cancel();
      throw new ReadinessError(`Unexpected HTTP ${response.status}: ${new URL(url).pathname}`);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        requireValue(
          size <= (range ? 1 : smallLimit),
          `Response exceeded expected bound: ${new URL(url).pathname}`,
        );
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ReadinessError) throw error;
      pending(`Network response failed: ${new URL(url).pathname}`);
    }
    return {
      body: Buffer.concat(chunks),
      status: response.status,
      contentRange: response.headers.get("content-range"),
    };
  };
  const json = async (suffix, optional = false) => {
    const response = await request(`${api}/repos/${repository}${suffix}`, {
      github: true,
      optional,
    });
    if (!response) return null;
    try {
      return JSON.parse(response.body);
    } catch {
      throw new ReadinessError(`Invalid API JSON: ${suffix}`);
    }
  };
  const catalog = async () => {
    const values = await json("/releases?per_page=100");
    requireValue(Array.isArray(values), "Invalid release catalog");
    return values
      .filter(
        (release) => !release.draft && versionPattern.test(release.tag_name?.replace(/^v/, "")),
      )
      .sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
  };
  const rawProvenance = async (release) => {
    const asset = assetMap(release)[provenanceName];
    requireValue(asset, `Missing provenance for ${release.tag_name}`);
    requireValue(typeof asset.browser_download_url === "string", "Missing provenance download URL");
    return (await request(asset.browser_download_url)).body.toString("utf8");
  };
  return {
    env,
    now,
    request,
    json,
    catalog,
    rawProvenance,
    mirror,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function snapshot(release, raw) {
  const version = versionOf(release);
  const provenance = parseProvenance(raw, version);
  const catalog = assetMap(release);
  requireValue(
    catalog[provenanceName]?.size === Buffer.byteLength(raw),
    `Provenance size mismatch: ${version}`,
  );
  if (catalog[provenanceName].digest)
    requireValue(
      catalog[provenanceName].digest === `sha256:${hash(raw)}`,
      `Provenance hash mismatch: ${version}`,
    );
  const assets = {};
  for (const [name, digest] of Object.entries(provenance.assets)) {
    requireValue(catalog[name], `Missing catalog asset: ${name}`);
    if (catalog[name].digest)
      requireValue(catalog[name].digest === `sha256:${digest}`, `Catalog hash mismatch: ${name}`);
    assets[name] = { sha256: digest, size: catalog[name].size, version };
  }
  return {
    version,
    tag: release.tag_name,
    releaseId: release.id,
    provenance: { raw, sha256: hash(raw) },
    assets,
  };
}

function compatible(release, channel) {
  return channel === "dev" || (!release.prerelease && !versionOf(release).includes("-"));
}

function completeArch(release, arch) {
  const names = new Set(release.assets.map((asset) => asset.name));
  return windowsNames(versionOf(release), arch).every((name) => names.has(name));
}

function historyReleases(releases, version, channel, stable) {
  const older = releases
    .filter(
      (release) =>
        compareVersions(versionOf(release), version) < 0 &&
        compatible(release, channel) &&
        release.assets.some((asset) =>
          ["x64", "arm64"].some(
            (arch) => asset.name === `PowerAI-${versionOf(release)}-win-${arch}.exe.blockmap`,
          ),
        ),
    )
    .slice(0, 2);
  if (
    channel === "dev" &&
    stable &&
    versionOf(stable) !== version &&
    !older.some((release) => release.tag_name === stable.tag_name)
  )
    older.push(stable);
  return older;
}

function descriptors(source) {
  return {
    ...source.assets,
    [provenanceName]: {
      sha256: source.provenance.sha256,
      size: Buffer.byteLength(source.provenance.raw),
      version: source.version,
    },
  };
}

async function checkMirror(rt, channel, expected, files, { strict = false } = {}) {
  const url = `${rt.mirror}/${channel}/`;
  const before = await rt.request(url + provenanceName);
  const beforeRaw = before.body.toString("utf8");
  if (hash(before.body) !== expected.provenance.sha256) {
    const observed = parseProvenance(beforeRaw, JSON.parse(beforeRaw).version);
    if (strict)
      throw new ReadinessError(`Stable mirror provenance changed from ${expected.version}`);
    if (compareVersions(observed.version, expected.version) < 0)
      pending(`Mirror still serves ${observed.version}`);
    const wanted = parseProvenance(expected.provenance.raw, expected.version);
    const withoutMac = (value) =>
      JSON.stringify(
        Object.entries(value.assets)
          .filter(([name]) => !macNames(expected.version).includes(name))
          .sort(),
      );
    if (
      observed.version === expected.version &&
      observed.desktopCommit === wanted.desktopCommit &&
      observed.agentCommit === wanted.agentCommit &&
      observed.workflowRun === wanted.workflowRun &&
      withoutMac(observed) === withoutMac(wanted) &&
      macNames(expected.version).some((name) => observed.assets[name] !== wanted.assets[name])
    )
      pending("Mirror is between Windows and Mac provenance snapshots");
    throw new ReadinessError("Mirror provenance hash/identity mismatch");
  }
  const checks = [];
  let failure;
  for (let index = 0; index < Object.keys(files).length; index += 4) {
    const results = await Promise.allSettled(
      Object.entries(files)
        .slice(index, index + 4)
        .map(async ([name, expectedFile]) => {
          const large = expectedFile.size > smallLimit;
          const response = await rt.request(url + encodeURIComponent(name), { range: large });
          if (large) {
            requireValue(
              response.contentRange === `bytes 0-0/${expectedFile.size}` &&
                response.body.length === 1,
              `Range/size mismatch: ${name}`,
            );
          } else {
            requireValue(
              response.body.length === expectedFile.size &&
                hash(response.body) === expectedFile.sha256,
              `Mirror hash/size mismatch: ${name}`,
            );
          }
          return {
            name,
            size: expectedFile.size,
            sha256: expectedFile.sha256,
            verification: large ? "range-and-size" : "full-sha256",
          };
        }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") checks.push(result.value);
      else failure ??= result.reason;
    }
    if (failure) break;
  }
  const after = await rt.request(url + provenanceName);
  if (hash(after.body) !== hash(before.body)) pending("Mirror changed during verification");
  if (failure) throw failure;
  return checks;
}

export async function prepareRelease(input, deps = {}) {
  const rt = runtime(deps);
  requireValue(versionPattern.test(input.version), "Invalid release version");
  requireValue(
    commitPattern.test(input.desktopRef) && commitPattern.test(input.agentRef),
    "Expected immutable source commits",
  );
  requireValue(typeof input.windowsArm64 === "boolean", "windowsArm64 must be boolean");
  requireValue(
    rt.env.GITHUB_REPOSITORY === repository &&
      /^\d+$/.test(rt.env.GITHUB_RUN_ID ?? "") &&
      commitPattern.test(rt.env.GITHUB_SHA ?? ""),
    "Missing immutable GitHub build context",
  );
  const expectedBuild = {
    repository,
    runId: rt.env.GITHUB_RUN_ID,
    buildUrl: `https://github.com/${repository}/actions/runs/${rt.env.GITHUB_RUN_ID}`,
    toolingCommit: rt.env.GITHUB_SHA,
  };
  const build = await rt.json(`/actions/runs/${expectedBuild.runId}`);
  requireValue(
    String(build.id) === expectedBuild.runId && build.head_sha === expectedBuild.toolingCommit,
    "Build/tooling identity mismatch",
  );
  const releases = await rt.catalog();
  requireValue(
    !(await rt.json(`/releases/tags/v${input.version}`, true)),
    "Release version already exists",
  );
  const stableRelease = await rt.json("/releases/latest");
  requireValue(
    stableRelease && compatible(stableRelease, "stable") && !stableRelease.draft,
    "Missing public stable baseline",
  );
  requireValue(
    compareVersions(input.version, versionOf(stableRelease)) > 0,
    "Release must be newer than stable",
  );
  const channel = input.version.includes("-") ? "dev" : "stable";
  const mirrorChannel = channel === "dev" ? "dev" : "latest";
  const currentChannel = releases.find((release) => compatible(release, channel));
  requireValue(
    !currentChannel || compareVersions(input.version, versionOf(currentChannel)) > 0,
    "Release must be newer than the current channel target",
  );
  const snapshots = {};
  const load = async (release) => {
    if (!snapshots[release.tag_name])
      snapshots[release.tag_name] = snapshot(release, await rt.rawProvenance(release));
    return snapshots[release.tag_name];
  };
  const armCandidate = async (forChannel, beforeVersion) => {
    const candidates = releases.filter(
      (release) =>
        compatible(release, forChannel) &&
        compareVersions(versionOf(release), beforeVersion) < 0 &&
        completeArch(release, "arm64"),
    );
    const mirrored = await rt.request(
      `${rt.mirror}/${forChannel === "dev" ? "dev" : "latest"}/${armProvenanceName}`,
      { optional: true },
    );
    if (mirrored) {
      const value = JSON.parse(mirrored.body);
      requireValue(versionPattern.test(value.version), "Invalid retained ARM provenance version");
      if (
        compareVersions(value.version, beforeVersion) < 0 &&
        (forChannel === "dev" || !value.version.includes("-"))
      ) {
        const original = await rt.json(`/releases/tags/v${value.version}`);
        requireValue(
          original &&
            !original.draft &&
            compatible(original, forChannel) &&
            completeArch(original, "arm64"),
          "Retained ARM origin is not a compatible public release",
        );
        const source = await load(original);
        requireValue(
          source.provenance.sha256 === hash(mirrored.body),
          "Retained ARM provenance does not match original GitHub bytes",
        );
        if (!candidates.some((release) => release.tag_name === original.tag_name))
          candidates.push(original);
      }
    }
    candidates.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
    return candidates[0] ? load(candidates[0]) : null;
  };
  const requiredArches = input.windowsArm64 ? ["x64", "arm64"] : ["x64"];
  const previous = {};
  for (const arch of requiredArches) {
    const release = releases.find(
      (candidate) =>
        compatible(candidate, channel) &&
        compareVersions(versionOf(candidate), input.version) < 0 &&
        completeArch(candidate, arch),
    );
    const source =
      arch === "arm64"
        ? await armCandidate(channel, input.version)
        : release && (await load(release));
    requireValue(
      source && windowsNames(source.version, arch).every((name) => source.assets[name]),
      `No complete public previous ${arch} release; cannot certify a fabricated upgrade`,
    );
    previous[arch] = { version: source.version, tag: source.tag };
  }
  const retainedArm = input.windowsArm64 ? null : await armCandidate(channel, input.version);
  const history = {};
  for (const release of historyReleases(releases, input.version, channel, stableRelease)) {
    const source = await load(release);
    for (const arch of ["x64", "arm64"]) {
      const name = `PowerAI-${source.version}-win-${arch}.exe.blockmap`;
      if (release.assets.some((asset) => asset.name === name)) {
        requireValue(source.assets[name], `Missing historical blockmap digest: ${name}`);
        history[name] = source.assets[name];
      }
    }
  }
  const stable = await load(stableRelease);
  const stableFiles = descriptors(stable);
  for (const release of historyReleases(releases, stable.version, "stable", stableRelease)) {
    const source = await load(release);
    for (const arch of ["x64", "arm64"]) {
      const name = `PowerAI-${source.version}-win-${arch}.exe.blockmap`;
      if (release.assets.some((asset) => asset.name === name)) {
        requireValue(source.assets[name], `Missing stable history digest: ${name}`);
        stableFiles[name] = source.assets[name];
      }
    }
  }
  const stableArm = completeArch(stableRelease, "arm64")
    ? stable
    : await armCandidate("stable", stable.version);
  if (stableArm) Object.assign(stableFiles, retainedDescriptors(stableArm));
  const stableChecks = await checkMirror(rt, "latest", stable, stableFiles, { strict: true });
  // Freeze the feed users currently see, including a catalog-external ARM source.
  if (retainedArm) {
    const current = releases.find((release) => compatible(release, channel));
    requireValue(current, "Missing current mirror source");
    await checkMirror(rt, mirrorChannel, await load(current), {
      [armProvenanceName]: {
        sha256: retainedArm.provenance.sha256,
        size: Buffer.byteLength(retainedArm.provenance.raw),
      },
      ...Object.fromEntries(
        windowsNames(retainedArm.version, "arm64").map((name) => [name, retainedArm.assets[name]]),
      ),
    });
  }
  return {
    schemaVersion: 1,
    status: "prepared",
    preparedAt: new Date(rt.now()).toISOString(),
    version: input.version,
    desktopRef: input.desktopRef,
    agentRef: input.agentRef,
    expectedBuild,
    channel,
    mirrorChannel,
    requiredArches,
    previous,
    stableTag: stable.tag,
    stableFiles,
    retainedArmTag: retainedArm?.tag ?? null,
    history,
    snapshots,
    baselineChecks: stableChecks,
  };
}

function retainedDescriptors(source) {
  const files = Object.fromEntries(
    windowsNames(source.version, "arm64").map((name) => {
      requireValue(source.assets[name], `Incomplete retained ARM feed: ${name}`);
      return [name, source.assets[name]];
    }),
  );
  return {
    ...files,
    [armProvenanceName]: {
      sha256: source.provenance.sha256,
      size: Buffer.byteLength(source.provenance.raw),
      version: source.version,
    },
  };
}

function validatePlan(plan) {
  requireValue(
    plan.schemaVersion === 1 &&
      versionPattern.test(plan.version) &&
      commitPattern.test(plan.desktopRef) &&
      commitPattern.test(plan.agentRef),
    "Invalid readiness plan",
  );
  requireValue(
    plan.channel === (plan.version.includes("-") ? "dev" : "stable") &&
      plan.mirrorChannel === (plan.channel === "dev" ? "dev" : "latest"),
    "Invalid plan channel",
  );
  requireValue(
    plan.expectedBuild.repository === repository &&
      /^\d+$/.test(plan.expectedBuild.runId) &&
      plan.expectedBuild.buildUrl ===
        `https://github.com/${repository}/actions/runs/${plan.expectedBuild.runId}` &&
      commitPattern.test(plan.expectedBuild.toolingCommit),
    "Invalid plan build identity",
  );
  requireValue(
    JSON.stringify(plan.requiredArches) === '["x64"]' ||
      JSON.stringify(plan.requiredArches) === '["x64","arm64"]',
    "Invalid required architectures",
  );
  for (const [tag, source] of Object.entries(plan.snapshots)) {
    requireValue(
      versionPattern.test(source.version) &&
        tag === `v${source.version}` &&
        source.tag === tag &&
        compareVersions(source.version, plan.version) < 0,
      "Invalid plan source identity",
    );
    requireValue(
      hash(source.provenance.raw) === source.provenance.sha256,
      "Plan provenance anchor changed",
    );
    const provenance = parseProvenance(source.provenance.raw, source.version);
    requireValue(
      JSON.stringify(Object.keys(source.assets).sort()) ===
        JSON.stringify(Object.keys(provenance.assets).sort()),
      "Incomplete plan provenance assets",
    );
    for (const [name, asset] of Object.entries(source.assets))
      requireValue(
        asset.sha256 === provenance.assets[name] &&
          asset.version === source.version &&
          Number.isSafeInteger(asset.size) &&
          asset.size > 0,
        `Invalid plan asset anchor: ${name}`,
      );
  }
  const assertSource = (tag, arch) => {
    const source = plan.snapshots[tag];
    requireValue(
      source && (plan.channel === "dev" || !source.version.includes("-")),
      "Invalid plan architecture source",
    );
    requireValue(
      windowsNames(source.version, arch).every((name) => source.assets[name]),
      "Incomplete plan architecture source",
    );
    return source;
  };
  for (const arch of plan.requiredArches)
    requireValue(
      assertSource(plan.previous[arch]?.tag, arch).version === plan.previous[arch].version,
      "Invalid plan previous version",
    );
  if (plan.retainedArmTag) {
    requireValue(!plan.requiredArches.includes("arm64"), "Unexpected retained ARM plan source");
    assertSource(plan.retainedArmTag, "arm64");
  }
  const stable = plan.snapshots[plan.stableTag];
  requireValue(stable && !stable.version.includes("-"), "Invalid plan stable source");
  const equalAsset = (left, right) =>
    left &&
    right &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.version === right.version;
  for (const [name, asset] of Object.entries(descriptors(stable)))
    requireValue(equalAsset(plan.stableFiles[name], asset), `Incomplete stable baseline: ${name}`);
  for (const [name, asset] of Object.entries(plan.history)) {
    const source = plan.snapshots[`v${asset.version}`];
    requireValue(
      source &&
        (plan.channel === "dev" || !source.version.includes("-")) &&
        ["x64", "arm64"].some(
          (arch) => name === `PowerAI-${source.version}-win-${arch}.exe.blockmap`,
        ) &&
        equalAsset(asset, source.assets[name]),
      `Invalid historical asset anchor: ${name}`,
    );
  }
  for (const [name, asset] of Object.entries(plan.stableFiles)) {
    const source = plan.snapshots[`v${asset.version}`];
    requireValue(
      source &&
        !source.version.includes("-") &&
        compareVersions(source.version, stable.version) <= 0,
      `Invalid stable asset source: ${name}`,
    );
    const expected =
      name === armProvenanceName
        ? {
            sha256: source.provenance.sha256,
            size: Buffer.byteLength(source.provenance.raw),
            version: source.version,
          }
        : descriptors(source)[name];
    requireValue(equalAsset(asset, expected), `Invalid stable asset anchor: ${name}`);
  }
}

function releaseSignature(release) {
  requireValue(Array.isArray(release.assets), "Release assets are missing");
  const assets = [...release.assets]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((asset) => [
      asset.id,
      asset.name,
      asset.size,
      asset.digest,
      asset.state,
      asset.updated_at,
    ]);
  return JSON.stringify([release.id, release.tag_name, release.draft, release.prerelease, assets]);
}

async function checkReady(plan, phase, rt) {
  const release = await rt.json(`/releases/tags/v${plan.version}`);
  if (release.draft || !release.published_at) pending("Release is not public yet");
  requireValue(
    release.tag_name === `v${plan.version}` && release.prerelease === (plan.channel === "dev"),
    "Published channel identity mismatch",
  );
  if (release.assets?.some((asset) => asset.state && asset.state !== "uploaded"))
    pending("Release assets are still uploading");
  const assets = assetMap(release);
  const requiredWindows = plan.requiredArches.flatMap((arch) => windowsNames(plan.version, arch));
  const mac = macNames(plan.version);
  if (!requiredWindows.every((name) => assets[name]) || !assets[provenanceName])
    pending("Windows assets are not complete");
  if (!plan.requiredArches.includes("arm64"))
    requireValue(
      !windowsNames(plan.version, "arm64").some((name) => assets[name]),
      "Unexpected Windows ARM assets in omitted-architecture release",
    );
  const macComplete = mac.every((name) => assets[name]);
  if (mac.some((name) => assets[name]) && !macComplete) pending("Mac assets are being appended");
  if (phase === "complete" && (!macComplete || assets["notary-state.json"]))
    pending("Mac notarization/assets are still pending");
  const raw = await rt.rawProvenance(release);
  const again = await rt.rawProvenance(release);
  const after = await rt.json(`/releases/tags/v${plan.version}`);
  if (raw !== again || releaseSignature(release) !== releaseSignature(after))
    pending("GitHub release changed during provenance snapshot");
  const source = snapshot(release, raw);
  const value = parseProvenance(raw, plan.version);
  requireValue(
    value.schemaVersion === 1 &&
      value.desktopCommit === plan.desktopRef &&
      value.agentCommit === plan.agentRef &&
      value.workflowRun === plan.expectedBuild.buildUrl,
    "Release source/build identity mismatch",
  );
  requireValue(
    value.platform ===
      (plan.requiredArches.includes("arm64") ? "windows-x64-arm64" : "windows-x64"),
    "Release architecture identity mismatch",
  );
  const required = [...requiredWindows, ...(macComplete ? mac : [])].sort();
  if (macComplete && !mac.every((name) => value.assets[name]))
    pending("Mac provenance is being appended");
  requireValue(
    JSON.stringify(Object.keys(value.assets).sort()) === JSON.stringify(required),
    "Unexpected provenance asset set",
  );
  requireValue(
    Object.keys(assets).every(
      (name) => required.includes(name) || [provenanceName, "notary-state.json"].includes(name),
    ),
    "Unexpected published asset",
  );
  const build = await rt.json(`/actions/runs/${plan.expectedBuild.runId}`);
  requireValue(
    String(build.id) === plan.expectedBuild.runId &&
      build.head_sha === plan.expectedBuild.toolingCommit,
    "Published build/tooling identity mismatch",
  );
  const releases = await rt.catalog();
  requireValue(
    releases.find((candidate) => compatible(candidate, plan.channel))?.tag_name ===
      release.tag_name,
    "Release was superseded as current channel target",
  );
  if (plan.channel === "dev") {
    const stable = await rt.json("/releases/latest");
    requireValue(
      stable.tag_name === plan.stableTag && compatible(stable, "stable"),
      "Stable release changed during dev publication",
    );
    requireValue(
      (await rt.rawProvenance(stable)) === plan.snapshots[plan.stableTag].provenance.raw,
      "Stable original provenance changed",
    );
  }
  const files = { ...descriptors(source), ...plan.history };
  const arm = plan.requiredArches.includes("arm64")
    ? source
    : plan.retainedArmTag && plan.snapshots[plan.retainedArmTag];
  if (arm) Object.assign(files, retainedDescriptors(arm));
  if (assets["notary-state.json"]) {
    const marker = await rt.request(assets["notary-state.json"].browser_download_url);
    if (assets["notary-state.json"].digest)
      requireValue(
        assets["notary-state.json"].digest === `sha256:${hash(marker.body)}`,
        "Notary marker hash mismatch",
      );
    files["notary-state.json"] = { size: marker.body.length, sha256: hash(marker.body) };
  }
  const mirrorChecks = await checkMirror(rt, plan.mirrorChannel, source, files);
  const stableChecks =
    plan.channel === "dev"
      ? await checkMirror(rt, "latest", plan.snapshots[plan.stableTag], plan.stableFiles, {
          strict: true,
        })
      : [];
  const finalRelease = await rt.json(`/releases/tags/v${plan.version}`);
  if (
    releaseSignature(finalRelease) !== releaseSignature(release) ||
    (await rt.rawProvenance(finalRelease)) !== raw
  )
    pending("GitHub release changed while checking the mirror");
  return {
    status: "passed",
    phase,
    version: plan.version,
    checkedAt: new Date(rt.now()).toISOString(),
    desktopRef: plan.desktopRef,
    agentRef: plan.agentRef,
    expectedBuild: plan.expectedBuild,
    channel: plan.channel,
    macComplete: macComplete && !assets["notary-state.json"],
    publishedAssets: Object.keys(assets).length,
    provenanceAssets: required.length,
    provenanceSha256: source.provenance.sha256,
    retainedArmVersion: arm?.version ?? null,
    mirrorChecks,
    stableChecks,
    boundary:
      "Small public files are fully SHA256 checked. Large public payloads are checked by HTTP Range and exact full size; installed/package acceptance supplies separate payload and behavior evidence.",
  };
}

export async function waitForRelease(plan, options, deps = {}) {
  validatePlan(plan);
  requireValue(
    ["windows", "complete"].includes(options.phase) && Number(options.timeoutSeconds) > 0,
    "Invalid wait phase/timeout",
  );
  const start = (deps.now ?? Date.now)();
  const deadline = start + Number(options.timeoutSeconds) * 1000;
  const rt = runtime({ ...deps, deadline });
  let attempts = 0;
  let lastReason = "No readiness snapshot";
  while (rt.now() < deadline) {
    attempts += 1;
    try {
      return { ...(await checkReady(plan, options.phase, rt)), attempts };
    } catch (error) {
      if (!(error instanceof ReadinessError) || !error.retryable) {
        error.report = {
          status: "failed",
          phase: options.phase,
          version: plan.version,
          attempts,
          reason: error.message,
        };
        throw error;
      }
      lastReason = error.message;
      deps.onPending?.({ attempts, reason: lastReason });
    }
    const remaining = deadline - rt.now();
    if (remaining > 0) await rt.sleep(Math.min(deps.pollIntervalMs ?? 60000, remaining));
  }
  const error = new ReadinessError(`Readiness timed out: ${lastReason}`);
  error.report = {
    status: "failed",
    phase: options.phase,
    version: plan.version,
    attempts,
    reason: error.message,
  };
  throw error;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < arguments_.length; i += 2) {
    requireValue(
      arguments_[i]?.startsWith("--") && arguments_[i + 1] !== undefined,
      "Expected --name value arguments",
    );
    const name = arguments_[i].slice(2);
    const allowed =
      command === "prepare"
        ? ["version", "desktop-ref", "agent-ref", "windows-arm64", "output"]
        : ["plan", "phase", "output", "timeout-seconds"];
    requireValue(
      allowed.includes(name) && !Object.hasOwn(args, name),
      `Unknown or duplicate argument: ${name}`,
    );
    args[name] = arguments_[i + 1];
  }
  requireValue(args.output, "--output is required");
  let result;
  try {
    if (command === "prepare") {
      requireValue(
        ["true", "false"].includes(args["windows-arm64"]),
        "--windows-arm64 must be true or false",
      );
      result = await prepareRelease({
        version: args.version,
        desktopRef: args["desktop-ref"],
        agentRef: args["agent-ref"],
        windowsArm64: args["windows-arm64"] === "true",
      });
      if (process.env.GITHUB_OUTPUT) {
        const matrix = {
          include: result.requiredArches.map((arch) => ({
            arch,
            from_version: result.previous[arch].version,
          })),
        };
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `channel=${result.channel}\nfrom_x64=${result.previous.x64.version}\nfrom_arm64=${result.previous.arm64?.version ?? ""}\nwindows_matrix=${JSON.stringify(matrix)}\n`,
        );
      }
    } else if (command === "wait") {
      result = await waitForRelease(
        JSON.parse(fs.readFileSync(args.plan, "utf8")),
        { phase: args.phase, timeoutSeconds: Number(args["timeout-seconds"]) },
        { onPending: (state) => console.log(JSON.stringify({ status: "pending", ...state })) },
      );
    } else throw new ReadinessError("Expected prepare or wait");
  } catch (error) {
    result = error.report ?? { status: "failed", reason: error.message };
    process.exitCode = 1;
  }
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: result.status ?? "prepared",
      version: result.version,
      output: path.resolve(args.output),
      reason: result.reason,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
