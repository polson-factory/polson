// Tests .github/polson/keep-transcript.sh, which keeps a summary of an agent step's
// transcript for the failure artifact. This repository is public, so artifacts can
// be downloaded by any signed-in GitHub user: the summary keeps only what the agent
// did (its text, its tool calls, failed or refused calls, the final result) and never
// what tools printed back. Known credential formats are redacted on top.
// The tokens below are made-up strings in real token formats, not real credentials.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEEP = resolve(import.meta.dirname, "../.github/polson/keep-transcript.sh");

const FAKE = {
  githubApp: "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  anthropic: "sk-ant-" + "oat01-abcdefghijklmnopqrstuvwxyz0123456789",
  header: "AUTHORIZATION: basic " + "eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==",
};
// Secrets in formats the redaction does not know: only dropping tool output keeps them out.
const UNKNOWN_FORMAT = {
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\\n-----END OPENSSH PRIVATE KEY-----",
  npmToken: "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  password: "hunter2-correct-horse-battery-staple",
};

/** An execution file as claude-code-action writes it: a JSON array of SDK messages. */
function executionFile(): string {
  return JSON.stringify([
    { type: "system", subtype: "init", tools: ["Read", "Bash"] },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "# Polson builder: issue #29" }] } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: `I will read the config. (token ${FAKE.githubApp})` },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: ".git/config" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false, content: `${UNKNOWN_FORMAT.privateKey}\n${UNKNOWN_FORMAT.npmToken}` },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "rm fixtures/qodo/pr15-no-issues.md" } }] } },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            is_error: true,
            content: [{ type: "text", text: `Permission to use Bash with command rm fixtures/qodo/pr15-no-issues.md has been denied. ${FAKE.header}` }],
          },
        ],
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: false, content: [{ type: "text", text: UNKNOWN_FORMAT.password }] }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 19,
      result: `Done. ${FAKE.anthropic}`,
      permission_denials: [{ tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "rm fixtures/qodo/pr15-no-issues.md" } }],
    },
  ]);
}

describe("keep-transcript.sh", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-keep-"));
    home = join(dir, "home");
    mkdirSync(home);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function keep(name: string, src: string) {
    const r = spawnSync("bash", [KEEP, name, src], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, HOME: home },
    });
    const kept = join(dir, "transcripts", `${name}.json`);
    const note = join(dir, "transcripts", `${name}.missing.txt`);
    return {
      ...r,
      kept: existsSync(kept) ? readFileSync(kept, "utf8") : null,
      note: existsSync(note) ? readFileSync(note, "utf8") : null,
    };
  }

  function writeExecution(content = executionFile()): string {
    const path = join(dir, "claude-execution-output.json");
    writeFileSync(path, content);
    return path;
  }

  describe("keeps what the agent did, never what tools printed", () => {
    it("text, tool calls, errors, the result and its refused calls", () => {
      const r = keep("build", writeExecution());

      expect(r.status, r.stderr).toBe(0);
      const summary = JSON.parse(r.kept ?? "null");
      expect(summary.source).toBe("execution_file");
      expect(r.kept).toContain("I will read the config.");
      expect(r.kept).toContain('"call": "Read"');
      expect(r.kept).toContain("rm fixtures/qodo/pr15-no-issues.md");
      expect(r.kept).toContain("Permission to use Bash with command rm fixtures/qodo/pr15-no-issues.md has been denied.");
      expect(r.kept).toContain('"num_turns": 19');
      expect(summary.result.permission_denials).toHaveLength(1);
    });

    it("drops tool output, so secrets in formats the redaction does not know stay out", () => {
      const r = keep("build", writeExecution());

      for (const secret of Object.values(UNKNOWN_FORMAT)) expect(r.kept).not.toContain(secret);
      expect(r.kept).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(r.kept).not.toContain("private reasoning");
      expect(r.kept).not.toContain("# Polson builder");
    });

    it("redacts known credential formats in what it keeps", () => {
      const r = keep("build", writeExecution());

      for (const secret of Object.values(FAKE)) expect(r.kept).not.toContain(secret);
      expect(r.kept).toContain("[REDACTED]");
    });

    it("a transcript it cannot read is not kept, raw or otherwise", () => {
      const r = keep("build", writeExecution(`not json ${UNKNOWN_FORMAT.password}`));

      expect(r.status, r.stderr).toBe(0);
      expect(r.kept).toBeNull();
      expect(r.note).toContain("could not be read");
      expect(r.note).not.toContain(UNKNOWN_FORMAT.password);
    });
  });

  describe("a step cut off before the action wrote its transcript", () => {
    // claude-code-action writes the execution file only when the session ends.
    // Claude Code's own session log is written as it goes.
    it("falls back to Claude Code's session log, marked partial, then moves it aside", () => {
      const logs = join(home, ".claude", "projects", "-home-runner-work-polson-polson");
      mkdirSync(logs, { recursive: true });
      const lines = (JSON.parse(executionFile()) as object[]).map((m) => JSON.stringify(m)).join("\n");
      writeFileSync(join(logs, "session-1.jsonl"), lines + "\n");
      const r = keep("resolve1", "");

      expect(r.status, r.stderr).toBe(0);
      const summary = JSON.parse(r.kept ?? "null");
      expect(summary.source).toBe("partial session log");
      expect(r.kept).toContain("rm fixtures/qodo/pr15-no-issues.md");
      expect(r.kept).not.toContain(UNKNOWN_FORMAT.npmToken);
      expect(readdirSync(logs)).toEqual([]);
    });

    it("never reuses an earlier step's transcript", () => {
      const first = keep("build", writeExecution());
      expect(first.kept).not.toBeNull();
      expect(existsSync(join(dir, "claude-execution-output.json"))).toBe(false);

      const second = keep("resolve1", "");
      expect(second.kept).toBeNull();
      expect(second.note).toContain("ran but left no transcript");
    });
  });

  it("a step that ran but left no transcript: a warning and a note in the artifact", () => {
    const r = keep("resolve2", "");

    expect(r.status, r.stderr).toBe(0);
    expect(r.kept).toBeNull();
    expect(r.stdout).toContain("::warning::The resolve2 step ran but left no transcript");
    expect(r.note).toContain("ran but left no transcript");
  });

  it("refuses an unknown step name", () => {
    expect(keep("anything", "").status).toBe(2);
  });
});
