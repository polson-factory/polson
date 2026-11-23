// Tests the Qodo part of .github/polson/wait-for-pr.sh (and the escalation message
// in phase.sh wait) with stand-in `gh`, `qodo`, `timeout` and `git` first on PATH.
// The real bash, jq and qodo-open-findings.sh run, as they do in the workflow.
// Issue: https://github.com/shrooms08/polson/issues/26
//
// Qodo's comment cannot tell a skipped review from a real one (issue #26: on PR #25
// the skipped review's comment was identical to PR #11's real one apart from the
// commit). So Qodo counts as finished only when its own review record says the
// latest run is a complete, non-skipped review of the head commit.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const POLSON = resolve(import.meta.dirname, "../.github/polson");
const REPO = "shrooms08/polson";
const PR = 24;
const HEAD = "c012d32dd221e3ceea7d80ea77c6d9f05afcf3d5";
const OLDER = "ecced4dd964de436dbb17701744cf8e017d66e4e";

// A real Qodo review comment (PR #20: one open Medium), re-pointed at HEAD.
const REVIEW = readFileSync(resolve(import.meta.dirname, "../fixtures/qodo/pr20-open-medium.md"), "utf8").replace(
  /<!-- https:\/\/github\.com\/shrooms08\/polson\/commit\/[0-9a-f]{40} -->/,
  `<!-- https://github.com/${REPO}/commit/${HEAD} -->`,
);

// Answers the reads wait-for-pr.sh makes, and the label read, comment and label
// edit phase.sh makes. Anything else fails, so the real gh is never needed.
const STUB_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$*" in
  "pr view ${PR} --json state,headRefOid --jq "*) echo "OPEN ${HEAD}"; exit 0 ;;
  "api repos/${REPO}/commits/${HEAD}/check-runs?per_page=100 --paginate --jq "*)
    echo '{"id":1,"name":"Node 24","status":"completed","conclusion":"success"}'
    echo '{"id":2,"name":"Node 20.19.0","status":"completed","conclusion":"success"}'
    exit 0 ;;
  "api repos/${REPO}/issues/${PR}/comments?per_page=100 --paginate") cat "$STUB_COMMENTS"; exit 0 ;;
  "issue view 9 --json labels --jq "*) echo agent-working; exit 0 ;;
  "issue comment 9 --body "*) printf '%s' "$5" > "$STUB_ESCALATION"; exit 0 ;;
  "issue edit 9 "*) exit 0 ;;
esac
echo "stand-in gh: unexpected call: $*" >&2
exit 99
`;

// Prints $STUB_QODO_JSON and exits $STUB_QODO_EXIT, but only for the exact read
// the script must make. The real CLI writes a trace line to stderr; so does this.
const STUB_QODO = `#!/usr/bin/env bash
echo "qodo $*" >> "$STUB_LOG"
if [ "$*" != "read pr-review-session findings --pr-url https://github.com/${REPO}/pull/${PR} --extended --json" ]; then
  echo "stand-in qodo: unexpected call: $*" >&2
  exit 99
fi
echo "  trace 0123456789abcdef" >&2
cat "$STUB_QODO_JSON"
exit "\${STUB_QODO_EXIT:-0}"
`;

// The scripts wrap gh and qodo in \`timeout 60\`; this drops the limit.
const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
exec "$@"
`;

// phase.sh wait checks out the PR branch only after Qodo finished. A skip must
// escalate before that, so any git call here is a failure, never a real checkout.
const STUB_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
echo "stand-in git: unexpected call: $*" >&2
exit 97
`;

type Run = {
  run_id: number;
  commit_sha: string;
  status: string;
  review_effort: string | null;
  review_complete: boolean;
};

/** A run of Qodo's review: by default a complete lite review of HEAD. */
const run = (fields: Partial<Run> = {}): Run => ({
  run_id: 2,
  commit_sha: HEAD,
  status: "completed",
  review_effort: "lite",
  review_complete: true,
  ...fields,
});

/** Qodo's review record, as `qodo read pr-review-session findings --extended --json` prints it. */
function record(latest: Run | null): string {
  if (latest === null) return JSON.stringify({ review_session: null, review_runs: [], findings: [], finding_count: 0 });
  const earlier = run({ run_id: 1, commit_sha: OLDER });
  const { run_id, commit_sha, status, review_complete } = latest;
  return JSON.stringify({
    review_session: { run_id, status, commit_sha, review_complete, git_provider: "github" },
    review_runs: [latest, earlier],
    findings: [],
    finding_count: 0,
  });
}

describe("wait-for-pr.sh: Qodo is finished only when its review record shows a real review of the head commit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-wait-"));
    for (const [name, body] of [
      ["gh", STUB_GH],
      ["qodo", STUB_QODO],
      ["timeout", STUB_TIMEOUT],
      ["git", STUB_GIT],
    ] as const) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(
      join(dir, "comments.json"),
      JSON.stringify([{ user: { login: "qodo-code-review[bot]" }, body: REVIEW }]),
    );
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `args` (a script and its arguments) with Qodo's record `qodoJson`. */
  function runScript(args: string[], qodoJson: string, qodoExit = 0, extraEnv: Record<string, string> = {}) {
    const outputs = join(dir, "github-output");
    const log = join(dir, "calls.log");
    const escalation = join(dir, "escalation.txt");
    writeFileSync(join(dir, "qodo.json"), qodoJson);
    writeFileSync(outputs, "");
    writeFileSync(log, "");
    const result = spawnSync("bash", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GH_REPO: REPO,
        GITHUB_OUTPUT: outputs,
        RUN_URL: "https://example.invalid/run",
        POLL_SECONDS: "1",
        TIMEOUT_SECONDS: "2",
        STUB_LOG: log,
        STUB_COMMENTS: join(dir, "comments.json"),
        STUB_QODO_JSON: join(dir, "qodo.json"),
        STUB_QODO_EXIT: String(qodoExit),
        STUB_ESCALATION: escalation,
        ...extraEnv,
      },
    });
    const out = readFileSync(outputs, "utf8");
    const value = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      qodo: value("qodo"),
      qodoOpen: value("qodo_open"),
      polls: result.stdout.split("\n").filter((line) => line.startsWith("poll ")),
      escalation: existsSync(escalation) ? readFileSync(escalation, "utf8") : undefined,
      calls: readFileSync(log, "utf8"),
    };
  }

  // Polls are 1 second apart, and Qodo counts as finished after 2 ready polls in a
  // row. Cases that must not finish give up after 3 seconds and must have polled
  // at least twice, so a wrong "finished" had its chance to happen (see
  // expectNotFinished). A case that must finish gets 10 seconds, so a slow machine
  // still fits its 2 ready polls (it stops as soon as it has them).
  const wait = (qodoJson: string, qodoExit = 0, timeoutSeconds = 3) =>
    runScript([join(POLSON, "wait-for-pr.sh"), String(PR)], qodoJson, qodoExit, {
      TIMEOUT_SECONDS: String(timeoutSeconds),
    });

  function expectNotFinished(r: ReturnType<typeof wait>) {
    expect(r.polls.length, r.stdout).toBeGreaterThanOrEqual(2);
    expect(r.qodo, r.stdout).toBe("not-finished");
    expect(r.qodoOpen).toBe("unknown");
  }

  it("complete at head: finished, with the effort on every poll line", () => {
    const r = wait(record(run()), 0, 10);

    expect(r.status, r.stderr).toBe(0);
    expect(r.qodo, r.stdout + r.stderr).toBe("finished");
    expect(r.qodoOpen).toBe("1");
    expect(r.polls.length).toBeGreaterThan(0);
    for (const line of r.polls) expect(line).toContain("effort=lite");
  }, 15_000);

  it("skip: a skipped review is not a review", () => {
    const r = wait(record(run({ review_effort: "skip", review_complete: false })));

    expect(r.status, r.stderr).toBe(0);
    expectNotFinished(r);
    for (const line of r.polls) expect(line).toContain("effort=skip");
  }, 15_000);

  it("run started: not finished until the run completes", () => {
    const r = wait(record(run({ status: "started", review_effort: null, review_complete: false })));

    expectNotFinished(r);
  }, 15_000);

  it("complete on an older commit: not finished for the head commit", () => {
    const r = wait(record(run({ commit_sha: OLDER })));

    expectNotFinished(r);
  }, 15_000);

  it("CLI error: not finished, never a guess", () => {
    const r = wait('{"error":"MT-AUTH-FORBIDDEN"}', 1);

    expect(r.calls).toContain("qodo read pr-review-session findings");
    expectNotFinished(r);
  }, 15_000);

  // Local Qodo review of this change: jq reads a stream, so a complete record
  // followed by garbage must not print "complete" before failing.
  it("a complete record followed by unreadable output: not finished", () => {
    const r = wait(`${record(run())}\n}{ not json`);

    expectNotFinished(r);
  }, 15_000);

  it("two records in one output: not finished", () => {
    const r = wait(`${record(run())}\n${record(run())}`);

    expectNotFinished(r);
  }, 15_000);

  // Local Qodo review, round 2: a session and a run that both lack run_id must not
  // be matched to each other (null == null).
  it("a record without run ids: not finished", () => {
    const complete = JSON.parse(record(run()));
    delete complete.review_session.run_id;
    for (const r of complete.review_runs) delete r.run_id;
    const r = wait(JSON.stringify(complete));

    expectNotFinished(r);
  }, 15_000);

  it("null session: no review yet, so not finished", () => {
    const r = wait(record(null));

    expectNotFinished(r);
  }, 15_000);

  it('phase.sh wait escalates a skip as "Qodo skipped reviewing <head>"', () => {
    const r = runScript(
      [join(POLSON, "phase.sh"), "wait", "9", "0"],
      record(run({ review_effort: "skip", review_complete: false })),
      0,
      { PR: String(PR), BRANCH: "9-some-ticket" },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.escalation).toContain(`Qodo skipped reviewing ${HEAD.slice(0, 7)}`);
    expect(r.calls).not.toContain("git ");
  }, 15_000);
});
