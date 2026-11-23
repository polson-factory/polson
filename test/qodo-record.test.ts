// Tests .github/polson/qodo-record.sh, which the qodo-record job runs to read Qodo's
// own review record for the head commit the agent job checked. It is the only code
// that runs the Qodo CLI with QODO_API_KEY, and it needs no GitHub access: the job's
// token can only read contents, and the script never calls gh.
// Issue: https://github.com/shrooms08/polson/issues/26
//
// The script runs `qodo` with an allowlist of environment variables, so the stand-in
// `qodo` sees only those: it reads its record from $HOME and dumps its environment
// there.
//
// The stand-in behaves like Qodo CLI 2.4.0 does with a fresh QODO_HOME, as the job
// runs it (issue #37): `read pr-review-session findings` exists only once the tool
// catalog is cached in $QODO_HOME/catalog.json, and until then the CLI rejects
// --pr-url ("error: unknown option '--pr-url'", run 45156397208). `qodo tools
// --refresh` fetches the catalog and needs the key.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// qodo-calls.log counts reads of the record; qodo-all-calls.log lists every call.
const STUB_QODO = `#!/usr/bin/env bash
env | sort > "$HOME/qodo-env.txt"
echo "$*" >> "$HOME/qodo-all-calls.log"
catalog="\${QODO_HOME:?stand-in qodo: QODO_HOME must be set}/catalog.json"
case "$*" in
  "tools --refresh --json")
    echo "  trace 0123456789abcdef" >&2
    if [ -z "\${QODO_API_KEY:-}" ] || [ "$(cat "$HOME/refresh-exit")" != 0 ]; then
      echo '{"error":{"code":"not_logged_in","message":"Not logged in. Run \`qodo login\`."}}'
      exit 1
    fi
    echo '{"catalog":"stand-in"}' > "$catalog"
    echo '{"kind":"qodo-managed-tool-catalog","tools":[]}'
    ;;
  "tools help pr-review-session findings --json")
    if [ ! -f "$catalog" ]; then
      echo '{"error":{"code":"no_catalog","message":"No tool catalog cached. Run \`qodo login\` or \`qodo tools --refresh\`."}}'
      exit 1
    fi
    cat "$HOME/tool-help.json"
    ;;
  "read pr-review-session findings --pr-url https://github.com/${REPO}/pull/${PR} --extended --json")
    echo "qodo" >> "$HOME/qodo-calls.log"
    if [ ! -f "$catalog" ]; then
      echo "error: unknown option '--pr-url'" >&2
      exit 1
    fi
    echo "  trace 0123456789abcdef" >&2
    cat "$HOME/qodo.json"
    exit "$(cat "$HOME/qodo-exit")"
    ;;
  *)
    echo "stand-in qodo: unexpected call: $*" >&2
    exit 99
    ;;
esac
`;

/** `qodo tools help pr-review-session findings --json`, in the shape Qodo CLI 2.4.0 prints. */
const TOOL_HELP = {
  kind: "qodo-managed-tool-catalog",
  schemaVersion: 1,
  path: ["pr-review-session", "findings"],
  toolCount: 1,
  tools: [
    {
      name: "get-pr-review-findings",
      toolset: "pr_review_session",
      description: "Returns the consolidated Finding.",
      parameters: {
        type: "object",
        properties: { pr_url: { type: "string" }, extended: { type: "boolean" }, git_provider: { type: "string" } },
        required: ["pr_url"],
      },
      mutating: false,
      command: "qodo pr-review-session findings",
      readCommand: "qodo read pr-review-session findings",
      group: "pr-review-session",
      leaf: "findings",
      access: "read",
    },
  ],
};
const toolHelp = (edit: (tool: (typeof TOOL_HELP.tools)[0]) => void = () => {}): string => {
  const help = structuredClone(TOOL_HELP);
  const [tool] = help.tools;
  if (!tool) throw new Error("TOOL_HELP has no tool");
  edit(tool);
  return JSON.stringify(help);
};

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

  /**
   * Runs the script as the job does: a fresh, empty QODO_HOME, auto-updates off, no
   * keychain, CI set. `cli` sets the stand-in's catalog refresh exit code and the
   * findings command's help.
   */
  function read(
    qodoJson: string,
    qodoExit = 0,
    env: Record<string, string> = {},
    cli: { refreshExit?: number; toolHelp?: string } = {},
  ) {
    const outputs = join(dir, "github-output");
    const qodoHome = join(dir, "qodo-home");
    mkdirSync(qodoHome);
    writeFileSync(join(dir, "qodo.json"), qodoJson);
    writeFileSync(join(dir, "qodo-exit"), String(qodoExit));
    writeFileSync(join(dir, "refresh-exit"), String(cli.refreshExit ?? 0));
    writeFileSync(join(dir, "tool-help.json"), cli.toolHelp ?? toolHelp());
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
        QODO_HOME: qodoHome,
        QODO_API_KEY: "qodo-key-for-the-cli",
        QODO_BASE_URL: "https://sdk.qodo.invalid",
        QODO_DISABLE_AUTOUPDATE: "1",
        QODO_DISABLE_SKILLS_AUTOUPDATE: "1",
        QODO_NO_KEYCHAIN: "1",
        CI: "true",
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
      allCalls: file("qodo-all-calls.log").split("\n").filter(Boolean),
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
    expect(r.allCalls).toEqual([]);
    expect(r.outputs).toBe("");
  });

  // Issue #37: in the job's fresh QODO_HOME the CLI had no tool catalog, so it had no
  // findings command and rejected --pr-url on every read (run 45156397208).
  describe("the CLI's tool catalog", () => {
    const REFRESH = "tools --refresh --json";
    const HELP = "tools help pr-review-session findings --json";
    const READ = `read pr-review-session findings --pr-url https://github.com/${REPO}/pull/${PR} --extended --json`;

    it("a fresh QODO_HOME, as the job runs it: fetches the catalog, checks the command, then reads run=complete", () => {
      const r = read(record(run()));

      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain("unknown option");
      expect(r.allCalls).toEqual([REFRESH, HELP, READ]);
      expect(r.outputs).toBe("run=complete\neffort=lite\n");
    });

    it("fetches the catalog once, not again on each retry", () => {
      const r = read(record(run({ status: "started", review_effort: null, review_complete: false })));

      expect(r.allCalls).toEqual([REFRESH, HELP, READ, READ]);
      expect(r.outputs).toBe("run=started\neffort=-\n");
    });

    it.each([
      { name: "the catalog refresh fails", cli: { refreshExit: 1 }, env: {}, cause: "could not fetch its tool catalog" },
      { name: "there is no key to fetch the catalog with", cli: {}, env: { QODO_API_KEY: "" }, cause: "could not fetch its tool catalog" },
      {
        name: "the catalog's findings command has no pr_url parameter",
        cli: { toolHelp: toolHelp((t) => delete (t.parameters.properties as Record<string, unknown>).pr_url) },
        env: {},
        cause: "has no read-only pr-review-session findings command",
      },
      {
        name: "the catalog's findings command is not read-only",
        cli: { toolHelp: toolHelp((t) => (t.access = "write")) },
        env: {},
        cause: "has no read-only pr-review-session findings command",
      },
      {
        name: "the catalog names another tool",
        cli: { toolHelp: toolHelp((t) => (t.name = "get-pr-review-summary")) },
        env: {},
        cause: "has no read-only pr-review-session findings command",
      },
      { name: "the command's help is not JSON", cli: { toolHelp: "Usage: qodo read [options]" }, env: {}, cause: "has no read-only pr-review-session findings command" },
      {
        name: "the command's help is two documents",
        cli: { toolHelp: `${toolHelp()}\n${toolHelp()}` },
        env: {},
        cause: "has no read-only pr-review-session findings command",
      },
    ])("$name: run=unknown, the record is never read, and the log says why", ({ cli, env, cause }) => {
      const r = read(record(run()), 0, env, cli);

      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs).toBe("run=unknown\neffort=-\n");
      expect(r.qodoCalls).toBe(0);
      expect(r.stderr).toContain(cause);
    });
  });
});
