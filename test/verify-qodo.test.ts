// Tests .github/polson/verify-qodo.sh, the verify-qodo job's decision. It runs after
// the qodo-record job read Qodo's review record (QODO_RUN, QODO_EFFORT) and before any
// label changes: it never runs the Qodo CLI or holds the Qodo key, so Qodo's code
// never shares a runner with this job's issue-write token. Right before it writes,
// it reads the labels and the PR head.
// Issue: https://github.com/shrooms08/polson/issues/26
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const VERIFY = resolve(import.meta.dirname, "../.github/polson/verify-qodo.sh");
const REPO = "shrooms08/polson";
const ISSUE = 9;
const PR = 27;
const HEAD = "6f8be2ca1c3504bfe619e9df9083c276c93eba78";
const OLDER = "ecced4dd964de436dbb17701744cf8e017d66e4e";

// Every gh and qodo call goes to one log, in order. The PR's state and head come
// from $STUB_PR; issue #9 is agent-working unless $STUB_LABELS says otherwise.
const STUB_GH = `#!/usr/bin/env bash
case "$*" in
  "pr view ${PR} --json state,headRefOid --jq "*) echo "gh pr view" >> "$HOME/calls.log"; cat "$STUB_PR"; exit 0 ;;
  "issue view ${ISSUE} --json labels --jq "*) echo "gh issue view" >> "$HOME/calls.log"; printf '%s\\n' "\${STUB_LABELS:-agent-working}"; exit 0 ;;
  "issue comment ${ISSUE} --body "*) echo "gh issue comment" >> "$HOME/calls.log"; { echo "COMMENT"; printf '%s\\n' "$5"; echo "END"; } >> "$STUB_LOG"; exit 0 ;;
  "issue edit ${ISSUE} "*) echo "gh issue edit" >> "$HOME/calls.log"; echo "EDIT \${*:4}" >> "$STUB_LOG"; exit 0 ;;
esac
echo "stand-in gh: unexpected call: $*" >&2
exit 99
`;

// The decision must never run the Qodo CLI.
const STUB_QODO = `#!/usr/bin/env bash
echo "qodo" >> "$HOME/calls.log"
exit 99
`;

const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
exec "$@"
`;

describe("verify-qodo.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-verify-"));
    for (const [name, body] of [
      ["gh", STUB_GH],
      ["qodo", STUB_QODO],
      ["timeout", STUB_TIMEOUT],
    ] as const) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  type Options = { prState?: string; prHead?: string; env?: Record<string, string> };

  /** Runs verify-qodo.sh for issue #9 after the qodo-record job reported `run` and `effort`. */
  function verify(run: string, effort: string, { prState = "OPEN", prHead = HEAD, env = {} }: Options = {}) {
    const log = join(dir, "issue.log");
    writeFileSync(join(dir, "pr.txt"), `${prState} ${prHead}\n`);
    writeFileSync(log, "");
    writeFileSync(join(dir, "calls.log"), "");
    const result = spawnSync("bash", [VERIFY, String(ISSUE)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        GH_TOKEN: "issue-write-token",
        GH_REPO: REPO,
        PR: String(PR),
        HEAD_SHA: HEAD,
        CI_DETAIL: "Node 24=success, Node 20.19.0=success",
        ROUNDS: "1",
        RUN_URL: "https://example.invalid/run",
        QODO_RUN: run,
        QODO_EFFORT: effort,
        STUB_PR: join(dir, "pr.txt"),
        STUB_LOG: log,
        ...env,
      },
    });
    const issueLog = readFileSync(log, "utf8");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      issueLog,
      comments: [...issueLog.matchAll(/^COMMENT\n([\s\S]*?)\nEND$/gm)].map((m) => m[1]),
      edits: issueLog.split("\n").filter((line) => line.startsWith("EDIT ")),
      calls: readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
    };
  }

  const AGENT_DONE = "EDIT --remove-label agent-working --add-label agent-done";
  const NEEDS_HUMAN = "EDIT --remove-label agent-working --add-label needs-human";

  /** Not reviewed: exactly one comment, posted before the needs-human label. */
  function expectNeedsHuman(r: ReturnType<typeof verify>, says: string) {
    expect(r.status, r.stderr).toBe(0);
    expect(r.edits).toEqual([NEEDS_HUMAN]);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toContain(says);
    expect(r.issueLog.indexOf("COMMENT")).toBeLessThan(r.issueLog.indexOf("EDIT"));
  }

  describe("the decision", () => {
    it("complete review of the head: the finish comment, then agent-done", () => {
      const r = verify("complete", "extended");

      expect(r.status, r.stderr).toBe(0);
      expect(r.edits).toEqual([AGENT_DONE]);
      expect(r.comments).toHaveLength(1);
      expect(r.comments[0]).toContain("Polson's checks passed");
      expect(r.comments[0]).toContain(`https://github.com/${REPO}/pull/${PR}`);
      expect(r.comments[0]).toContain(HEAD);
      expect(r.comments[0]).toContain("review effort: extended");
      expect(r.issueLog.indexOf("COMMENT")).toBeLessThan(r.issueLog.indexOf("EDIT"));
    });

    it('skip: "Qodo skipped reviewing <head>", then needs-human', () => {
      expectNeedsHuman(verify("skipped", "skip"), `Qodo skipped reviewing ${HEAD.slice(0, 7)}`);
    });

    it.each(["started", "older-commit", "incomplete", "none", "unknown"])("%s: not reviewed", (run) => {
      expectNeedsHuman(verify(run, "-"), "does not show a complete review");
    });

    it.each([
      ["empty", ""],
      ["not a plain word", "complete; agent-done"],
    ])("a record result that is %s: not reviewed", (_case, run) => {
      expectNeedsHuman(verify(run, "lite"), "does not show a complete review");
    });
  });

  describe("right before writing, it reads the labels and the PR head", () => {
    it("head changed since the agent job checked it: needs-human, even with a complete review", () => {
      expectNeedsHuman(verify("complete", "lite", { prHead: OLDER }), `changed after the agent job checked ${HEAD.slice(0, 7)}`);
    });

    it("PR no longer open: needs-human", () => {
      expectNeedsHuman(verify("complete", "lite", { prState: "MERGED" }), "changed after the agent job checked");
    });

    it("ticket no longer agent-working (a person took it): does nothing", () => {
      const r = verify("complete", "lite", { env: { STUB_LABELS: "needs-human" } });

      expect(r.status, r.stderr).toBe(0);
      expect(r.issueLog).toBe("");
    });

    // Local Qodo review of the two-job design: the labels and head were read once,
    // before minutes of polling Qodo, and not again before the label changed.
    it("nothing runs between reading the labels and head and writing the issue", () => {
      const r = verify("complete", "lite");

      expect(r.calls).toEqual(["gh issue view", "gh pr view", "gh issue comment", "gh issue edit"]);
    });
  });

  // Local Qodo review of the two-job design: env -i hides the token from the CLI's
  // environment but not from its same-user parent, so the CLI must not run here.
  it("never runs the Qodo CLI", () => {
    const r = verify("complete", "lite");

    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("qodo");
  });

  it("inputs that are not a PR number and a commit SHA: fails without touching the issue", () => {
    const r = verify("complete", "lite", { env: { HEAD_SHA: "not-a-sha" } });

    expect(r.status).not.toBe(0);
    expect(r.issueLog).toBe("");
  });

  it("CHECK_ONLY prints the decision and never touches the issue", () => {
    const r = verify("skipped", "skip", { env: { CHECK_ONLY: "1" } });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Not reviewed: Qodo skipped reviewing ${HEAD.slice(0, 7)}`);
    expect(r.issueLog).toBe("");
  });
});
