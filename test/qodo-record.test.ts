// Tests .github/polson/qodo-record.sh, which the qodo-record job runs to read Qodo's
// own review record for the head commit the agent job checked. It is the only code
// that runs the Qodo CLI with QODO_API_KEY, and it needs no GitHub access: the job's
// token can only read contents, and the script never calls gh.
// Issue: https://github.com/shrooms08/polson/issues/26
//
// The script runs `qodo` with an allowlist of environment variables, so the stand-in
// `qodo` sees only those: it reads its record from $HOME and dumps its environment
// there.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RECORD = resolve(import.meta.dirname, "../.github/polson/qodo-record.sh");
const REPO = "shrooms08/polson";
const PR = 27;
const HEAD = "6f8be2ca1c3504bfe619e9df9083c276c93eba78";
const OLDER = "ecced4dd964de436dbb17701744cf8e017d66e4e";

const GITHUB_SECRETS = {
  GH_TOKEN: "gh-token-must-not-leak",
  GITHUB_TOKEN: "github-token-must-not-leak",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-must-not-leak",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/must-not-leak",
  ACTIONS_RUNTIME_TOKEN: "runtime-token-must-not-leak",
};

// The record reader must never call GitHub.
const STUB_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$HOME/gh-calls.log"
exit 99
`;

const STUB_QODO = `#!/usr/bin/env bash
env | sort > "$HOME/qodo-env.txt"
echo "qodo" >> "$HOME/qodo-calls.log"
if [ "$*" != "read pr-review-session findings --pr-url https://github.com/${REPO}/pull/${PR} --extended --json" ]; then
  echo "stand-in qodo: unexpected call: $*" >&2
  exit 99
fi
echo "  trace 0123456789abcdef" >&2
cat "$HOME/qodo.json"
exit "$(cat "$HOME/qodo-exit")"
`;

const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
exec "$@"
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

describe("qodo-record.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-record-"));
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

  function read(qodoJson: string, qodoExit = 0, env: Record<string, string> = {}) {
    const outputs = join(dir, "github-output");
    writeFileSync(join(dir, "qodo.json"), qodoJson);
    writeFileSync(join(dir, "qodo-exit"), String(qodoExit));
    writeFileSync(outputs, "");
    const result = spawnSync("bash", [RECORD], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        GH_REPO: REPO,
        PR: String(PR),
        HEAD_SHA: HEAD,
        GITHUB_OUTPUT: outputs,
        QODO_API_KEY: "qodo-key-for-the-cli",
        QODO_BASE_URL: "https://sdk.qodo.invalid",
        VERIFY_ATTEMPTS: "2",
        VERIFY_DELAY_SECONDS: "0",
        ...GITHUB_SECRETS,
        ...env,
      },
    });
    const out = readFileSync(outputs, "utf8");
    const file = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: out,
      qodoCalls: file("qodo-calls.log").split("\n").filter(Boolean).length,
      ghCalls: file("gh-calls.log"),
      qodoEnv: file("qodo-env.txt"),
    };
  }

  describe("Qodo's latest run, as the record shows it", () => {
    it("complete at head: run=complete, with the effort logged", () => {
      const r = read(record(run()));

      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs).toBe("run=complete\neffort=lite\n");
      expect(r.stdout).toContain("run=complete effort=lite");
      expect(r.qodoCalls).toBe(1);
    });

    it("skip: run=skipped, without retrying", () => {
      const r = read(record(run({ review_effort: "skip", review_complete: false })));

      expect(r.outputs).toBe("run=skipped\neffort=skip\n");
      expect(r.qodoCalls).toBe(1);
    });

    it("run started: retried, then reported as started", () => {
      const r = read(record(run({ status: "started", review_effort: null, review_complete: false })));

      expect(r.outputs).toBe("run=started\neffort=-\n");
      expect(r.qodoCalls).toBe(2);
    });

    it.each([
      { name: "complete on an older commit", json: record(run({ commit_sha: OLDER })), exit: 0, state: "older-commit" },
      { name: "CLI error", json: '{"error":"MT-AUTH-FORBIDDEN"}', exit: 1, state: "unknown" },
      { name: "null session", json: record(null), exit: 0, state: "none" },
      { name: "a complete record followed by unreadable output", json: `${record(run())}\n}{ not json`, exit: 0, state: "unknown" },
      { name: "two records in one output", json: `${record(run())}\n${record(run())}`, exit: 0, state: "unknown" },
      { name: "completed but not complete", json: record(run({ review_complete: false })), exit: 0, state: "incomplete" },
      // The shape of Qodo's real runs on PR #27 (f9c4612, 5466a58) and PR #20: not a
      // skip, yet review_complete false. Undocumented, so not a review (rule 6).
      {
        name: "completed extended review with review_complete false (PR #27)",
        json: record(run({ review_effort: "extended", review_complete: false })),
        exit: 0,
        state: "incomplete",
      },
    ])("$name: run=$state", ({ json, exit, state }) => {
      const r = read(json, exit);

      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs).toMatch(new RegExp(`^run=${state}\\n`));
      expect(r.outputs).not.toContain("run=complete");
    });

    it("a record without run ids: run=unknown", () => {
      const complete = JSON.parse(record(run()));
      delete complete.review_session.run_id;
      for (const r of complete.review_runs) delete r.run_id;
      const r = read(JSON.stringify(complete));

      expect(r.outputs).toBe("run=unknown\neffort=-\n");
    });
  });

  describe("isolation from GitHub", () => {
    it("the CLI gets the Qodo key and base URL, never a GitHub token (environment allowlist)", () => {
      const r = read(record(run()));

      expect(r.qodoEnv).toContain("QODO_API_KEY=qodo-key-for-the-cli");
      expect(r.qodoEnv).toContain("QODO_BASE_URL=https://sdk.qodo.invalid");
      for (const [name, value] of Object.entries(GITHUB_SECRETS)) {
        expect(r.qodoEnv).not.toContain(`${name}=`);
        expect(r.qodoEnv).not.toContain(value);
      }
    });

    it("never calls GitHub", () => {
      const r = read(record(run()));

      expect(r.status, r.stderr).toBe(0);
      expect(r.ghCalls).toBe("");
    });
  });

  it("inputs that are not a PR number and a commit SHA: fails without running the CLI", () => {
    const r = read(record(run()), 0, { HEAD_SHA: "not-a-sha" });

    expect(r.status).not.toBe(0);
    expect(r.qodoCalls).toBe(0);
    expect(r.outputs).toBe("");
  });
});
