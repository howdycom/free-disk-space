import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const scriptPath = path.join(repoRoot, "free-disk-space.sh");
const actionPath = path.join(repoRoot, "action.yml");

const REMOVED_PATHS = [
  "/opt/ghc",
  "/opt/hostedtoolcache",
  "/usr/local/.ghcup",
  "/usr/local/lib/android",
  "/usr/local/share/boost",
  "/usr/share/dotnet",
  "/usr/share/swift",
];

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /hooks\.slack\.com\/services\/[A-Z0-9]+/,
  /sk_live_[A-Za-z0-9]{8,}/,
  new RegExp("-----BEGIN " + "(?:RSA |OPENSSH |EC |)PRIVATE KEY-----"),
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function assertNoCredentials(text, label) {
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.test(text), false, `${label} matches ${pattern}`);
  }
}

function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function runScript(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "free-disk-space-"));
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "stub.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeStub(
    bin,
    "sudo",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ "$STUB_SUDO_RM_FAIL" = 1 ] && [ "$1" = rm ]; then
  exit 1
fi
if [ "$STUB_SUDO_DOCKER_FAIL" = 1 ] && [ "$1" = docker ]; then
  exit 1
fi
exit 0
`
  );
  writeStub(
    bin,
    "df",
    `#!/bin/sh
printf 'df %s\\n' "$*" >> "$STUB_LOG"
if [ "$STUB_DF_FAIL" = 1 ]; then
  exit 1
fi
echo 'Filesystem Size Used Avail Use% Mounted on'
echo 'stub 100G 1G 99G 1% /'
exit 0
`
  );
  const result = spawnSync("/bin/bash", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      TMPDIR: dir,
      LANG: "C",
      STUB_LOG: log,
      STUB_SUDO_RM_FAIL: "0",
      STUB_SUDO_DOCKER_FAIL: "0",
      STUB_DF_FAIL: "0",
      ...overrides,
    },
  });
  const lines = readText(log)
    .split("\n")
    .filter((line) => line.length > 0);
  return { result, lines };
}

test("action.yml only invokes the cleanup script", () => {
  const action = readText(actionPath);
  assert.match(action, /using: composite/);
  assert.match(action, /bash "\$GITHUB_ACTION_PATH\/free-disk-space\.sh"/);
  assert.equal(action.includes("rm "), false);
  assert.equal(action.includes("sudo"), false);
  assert.equal(action.includes("secrets."), false);
  const dollars = action.match(/\$[A-Za-z_{][A-Za-z0-9_]*/g) ?? [];
  assert.deepEqual(dollars, ["$GITHUB_ACTION_PATH"]);
});

test("script deletes only the documented toolchain paths", () => {
  const script = readText(scriptPath);
  const readme = readText(path.join(repoRoot, "README.md"));
  const documented = [...readme.matchAll(/^\| `(\/[^`]+)` \|/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(documented, REMOVED_PATHS);
  assert.equal(script.includes("$"), false);
  assert.equal(script.includes("`"), false);
  for (const removedPath of REMOVED_PATHS) {
    const pieces = removedPath.split("/").filter((piece) => piece.length > 0);
    assert.ok(pieces.length >= 2, removedPath);
    assert.equal(removedPath.includes(".."), false);
    assert.equal(script.split(removedPath).length, 2, removedPath);
  }
  assert.doesNotMatch(script, /rm\s+-rf\s+\/(\s|$)/);
  assert.doesNotMatch(script, /curl |wget |ssh |nc |eval |base64 /);
});

test("successful run records df, one rm, and best-effort docker prunes", () => {
  const { result, lines } = runScript();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Disk before cleanup:/);
  assert.match(result.stdout, /Disk after cleanup:/);
  assert.deepEqual(lines, [
    "df -h /",
    `rm -rf ${REMOVED_PATHS.join(" ")}`,
    "docker image prune --all --force",
    "docker builder prune --all --force",
    "df -h /",
  ]);
  assertNoCredentials(result.stdout, "stdout");
  assertNoCredentials(result.stderr, "stderr");
});

test("a docker prune failure does not fail the script", () => {
  const { result, lines } = runScript({ STUB_SUDO_DOCKER_FAIL: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Disk after cleanup:/);
  assert.ok(lines.includes("docker image prune --all --force"));
  assert.ok(lines.includes("docker builder prune --all --force"));
});

test("an rm failure stops the script before docker prune", () => {
  const { result, lines } = runScript({ STUB_SUDO_RM_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes("Disk after cleanup:"), false);
  assert.deepEqual(lines, ["df -h /", `rm -rf ${REMOVED_PATHS.join(" ")}`]);
});

test("a df failure stops the script before anything is deleted", () => {
  const { result, lines } = runScript({ STUB_DF_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(lines, ["df -h /"]);
  assert.equal(result.stdout.includes("Disk after cleanup:"), false);
});

test("repository files do not contain credentials or a broader delete", () => {
  const files = walk(repoRoot);
  assert.ok(
    files.some((file) => file.endsWith(`${path.sep}free-disk-space.sh`))
  );
  for (const file of files) {
    const text = readText(file);
    assertNoCredentials(text, file);
    if (file.endsWith(`${path.sep}free-disk-space.sh`)) continue;
    if (file.endsWith(`${path.sep}free-disk-space.test.mjs`)) continue;
    assert.equal(text.includes("rm -rf"), false, file);
  }
});
