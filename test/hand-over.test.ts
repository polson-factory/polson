// Tests .github/polson/hand-over.sh, which makes sure a ticket never stays in
// agent-working. Two places run it:
//   agent  the agent job's last step (always runs). After candidate-done it leaves
//          the ticket to the verify-qodo job; otherwise it hands over as before.
//   final  the hand-over job, after verify-qodo (always runs). If verify-qodo did not
//          start, failed or was cancelled, the ticket is still agent-working: hand it
//          over.
// Issue: https://github.com/shrooms08/polson/issues/26
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HAND_OVER = resolve(import.meta.dirname, "../.github/polson/hand-over.sh");

const STUB_GH = `#!/usr/bin/env bash
case "$*" in
  "issue view 9 --json labels --jq "*) printf '%s\\n' "\${STUB_LABELS:-agent-working}"; exit 0 ;;
  "issue comment 9 --body "*) { echo "COMMENT"; printf '%s\\n' "$5"; echo "END"; } >> "$STUB_LOG"; exit 0 ;;
  "issue edit 9 "*) echo "EDIT \${*:4}" >> "$STUB_LOG"; exit 0 ;;
esac
echo "stand-in gh: unexpected call: $*" >&2
exit 99
`;

describe("hand-over.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-hand-over-"));
    writeFileSync(join(dir, "gh"), STUB_GH);
    chmodSync(join(dir, "gh"), 0o755);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function handOver(stage: "agent" | "final", env: Record<string, string>) {
    const log = join(dir, "issue.log");
    writeFileSync(log, "");
    const result = spawnSync("bash", [HAND_OVER, stage, "9"], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GH_REPO: "shrooms08/polson",
        RUN_URL: "https://example.invalid/run",
        STUB_LOG: log,
        ...env,
      },
    });
    const issueLog = readFileSync(log, "utf8");
    return {
      status: result.status,
      stderr: result.stderr,
      issueLog,
      comments: [...issueLog.matchAll(/^COMMENT\n([\s\S]*?)\nEND$/gm)].map((m) => m[1]),
      edits: issueLog.split("\n").filter((line) => line.startsWith("EDIT ")),
    };
  }

  const NEEDS_HUMAN = "EDIT --remove-label agent-working --add-label needs-human";
  const STEPS = "build: success, resolve round 1: success, resolve round 2: not run";

  it("agent job, candidate-done: leaves the ticket to verify-qodo", () => {
    const r = handOver("agent", { JOB_STATUS: "success", CANDIDATE: "true", STEPS });

    expect(r.status, r.stderr).toBe(0);
    expect(r.issueLog).toBe("");
  });

  it("agent job failed: comments, then needs-human (as before)", () => {
    const r = handOver("agent", { JOB_STATUS: "failure", CANDIDATE: "", STEPS });

    expect(r.status, r.stderr).toBe(0);
    expect(r.edits).toEqual([NEEDS_HUMAN]);
    expect(r.comments[0]).toContain("The agent job ended with status `failure`");
    expect(r.issueLog.indexOf("COMMENT")).toBeLessThan(r.issueLog.indexOf("EDIT"));
  });

  it.each(["skipped", "failure", "cancelled"])(
    "verify-qodo %s, ticket still agent-working: the final job hands it over",
    (result) => {
      const r = handOver("final", { VERIFY_RESULT: result });

      expect(r.status, r.stderr).toBe(0);
      expect(r.edits).toEqual([NEEDS_HUMAN]);
      expect(r.comments).toHaveLength(1);
      expect(r.comments[0]).toContain(`The verify-qodo job did not finish (result: \`${result}\`)`);
      expect(r.issueLog.indexOf("COMMENT")).toBeLessThan(r.issueLog.indexOf("EDIT"));
    },
  );

  it.each(["agent", "final"] as const)("%s: a ticket no longer agent-working is left alone", (stage) => {
    const r = handOver(stage, { STUB_LABELS: "agent-done", JOB_STATUS: "failure", VERIFY_RESULT: "failure", STEPS });

    expect(r.status, r.stderr).toBe(0);
    expect(r.issueLog).toBe("");
  });
});
