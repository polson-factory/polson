// Tests `phase.sh finish`, the agent job's last scripted gate. Since issue #26 it no
// longer sets agent-done: when every check passed it reports candidate-done, with the
// PR, head commit and issue as outputs, and the verify-qodo job decides. Its
// escalations are unchanged. Issue: https://github.com/shrooms08/polson/issues/26
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PHASE = resolve(import.meta.dirname, "../.github/polson/phase.sh");
const HEAD = "6f8be2ca1c3504bfe619e9df9083c276c93eba78";

const STUB_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$*" in
  "issue view 9 --json labels --jq "*) echo agent-working; exit 0 ;;
  "pr view 27 --json state,headRefOid --jq "*) echo "OPEN ${HEAD}"; exit 0 ;;
  "issue comment 9 --body "*|"issue edit 9 "*) exit 0 ;;
esac
echo "stand-in gh: unexpected call: $*" >&2
exit 99
`;

const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
exec "$@"
`;

describe("phase.sh finish", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-finish-"));
    for (const [name, body] of [
      ["gh", STUB_GH],
      ["timeout", STUB_TIMEOUT],
    ] as const) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function finish(env: Record<string, string>) {
    const outputs = join(dir, "github-output");
    const log = join(dir, "gh.log");
    writeFileSync(outputs, "");
    writeFileSync(log, "");
    const result = spawnSync("bash", [PHASE, "finish", "9"], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GH_REPO: "shrooms08/polson",
        GITHUB_OUTPUT: outputs,
        RUN_URL: "https://example.invalid/run",
        STUB_LOG: log,
        PR: "27",
        HEAD_SHA: HEAD,
        CI: "success",
        CI_DETAIL: "Node 24=success, Node 20.19.0=success",
        QODO: "finished",
        QODO_OPEN: "0",
        FIXED1: "true",
        FIXED2: "",
        ...env,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      outputs: readFileSync(outputs, "utf8"),
      ghCalls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  }

  it("every check passed: candidate-done outputs, no label and no comment", () => {
    const r = finish({});

    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toBe(
      [
        "candidate=true",
        "pr=27",
        `head_sha=${HEAD}`,
        "ci_detail=Node 24=success, Node 20.19.0=success",
        "rounds=1",
        "",
      ].join("\n"),
    );
    expect(r.ghCalls.some((call) => call.startsWith("gh issue edit"))).toBe(false);
    expect(r.ghCalls.some((call) => call.startsWith("gh issue comment"))).toBe(false);
  });

  it("an open High or Medium finding: escalates to needs-human, no candidate", () => {
    const r = finish({ QODO_OPEN: "1" });

    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toBe("next=stop\n");
    expect(r.ghCalls.some((call) => call.startsWith("gh issue comment 9"))).toBe(true);
    expect(r.ghCalls).toContain("gh issue edit 9 --remove-label agent-working --add-label needs-human");
  });
});
