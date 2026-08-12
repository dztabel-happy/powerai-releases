import fs from "node:fs";

const shaPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function validate(value) {
  if (value.schemaVersion !== 1) fail("Unsupported release state schema");
  if (!versionPattern.test(value.version)) fail("Invalid release version");
  if (!shaPattern.test(value.desktopCommit)) fail("Invalid desktop commit");
  if (!shaPattern.test(value.agentCommit)) fail("Invalid agent commit");
  if (!/^[0-9a-f-]{36}$/.test(value.submissionId))
    fail("Invalid notarization submission id");
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(
      value.buildUrl,
    )
  ) {
    fail("Invalid build URL");
  }
  return value;
}

const [command, file, ...args] = process.argv.slice(2);

if (command === "create") {
  const [version, desktopCommit, agentCommit, submissionId, buildUrl] = args;
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      validate({
        schemaVersion: 1,
        version,
        desktopCommit,
        agentCommit,
        submissionId,
        buildUrl,
      }),
      null,
      2,
    )}\n`,
  );
} else if (command === "verify") {
  validate(JSON.parse(fs.readFileSync(file, "utf8")));
} else if (command === "get") {
  const value = validate(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!Object.hasOwn(value, args[0])) fail("Unknown release state field");
  process.stdout.write(String(value[args[0]]));
} else {
  fail("Usage: release-state.mjs <create|verify|get> <file> [arguments]");
}
