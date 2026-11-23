// Tests .github/polson/with-qodo.sh, which installs the pinned Qodo CLI into a
// temporary QODO_HOME for one wait step, runs the wait, and deletes it. A stand-in
// curl serves a stand-in installer, so no network or real CLI is needed; the real
// sha256sum checks it. Issue: https://github.com/shrooms08/polson/issues/26
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WITH_QODO = resolve(import.meta.dirname, "../.github/polson/with-qodo.sh");

// Installs a `qodo` that prints the requested version, after $STUB_INSTALL_SECONDS.
const INSTALLER = `#!/bin/sh
[ "$1" = "--version" ] || exit 3
sleep "\${STUB_INSTALL_SECONDS:-0}"
mkdir -p "$QODO_HOME/bin"
printf '#!/bin/sh\\necho %s\\n' "$2" > "$QODO_HOME/bin/qodo"
chmod +x "$QODO_HOME/bin/qodo"
`;
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER).digest("hex");

// curl -o <file> <url>: copies the stand-in installer for the pinned URL only.
const STUB_CURL = `#!/usr/bin/env bash
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
[ "$url" = "https://example.invalid/install.sh" ] || { echo "stand-in curl: unexpected url $url" >&2; exit 22; }
cp "$STUB_INSTALLER" "$out"
`;

describe("with-qodo.sh", () => {
  let dir: string;
  let runnerTemp: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-with-qodo-"));
    runnerTemp = join(dir, "runner-temp");
    spawnSync("mkdir", ["-p", runnerTemp, join(dir, "bin")]);
    writeFileSync(join(dir, "install.sh"), INSTALLER);
    writeFileSync(join(dir, "bin", "curl"), STUB_CURL);
    chmodSync(join(dir, "bin", "curl"), 0o755);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function withQodo(command: string[], env: Record<string, string> = {}) {
    return spawnSync("bash", [WITH_QODO, ...command], {
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: runnerTemp,
        QODO_INSTALLER_URL: "https://example.invalid/install.sh",
        QODO_INSTALLER_SHA256: INSTALLER_SHA256,
        QODO_CLI_VERSION: "2.4.0",
        STUB_INSTALLER: join(dir, "install.sh"),
        ...env,
      },
    });
  }

  it("runs the command with the pinned CLI, then deletes QODO_HOME", () => {
    const r = withQodo(["bash", "-c", 'echo "home=$QODO_HOME"; qodo --version']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("2.4.0");
    expect(r.stdout).toMatch(new RegExp(`home=${runnerTemp}/qodo-home\\.`));
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  it("refuses an installer whose SHA-256 does not match, and runs nothing", () => {
    const r = withQodo(["bash", "-c", "echo SHOULD-NOT-RUN"], { QODO_INSTALLER_SHA256: "0".repeat(64) });

    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toContain("SHA-256 mismatch");
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  // Local Qodo review of this change: the install runs inside the wait step's
  // time limit, so the wait gets what is left of its budget, not a fresh one.
  it("takes the install time out of the wait's TIMEOUT_SECONDS", () => {
    const r = withQodo(["bash", "-c", 'echo "timeout=$TIMEOUT_SECONDS"'], {
      TIMEOUT_SECONDS: "60",
      STUB_INSTALL_SECONDS: "2",
    });

    expect(r.status, r.stderr).toBe(0);
    const left = Number(r.stdout.match(/timeout=(\d+)/)?.[1]);
    expect(left).toBeGreaterThan(50);
    expect(left).toBeLessThanOrEqual(58);
  }, 15_000);
});
