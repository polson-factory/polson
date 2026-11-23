// Tests .github/polson/keep-transcript.sh, which copies an agent step's transcript
// for the failure artifact with credentials redacted. The tokens below are made-up
// strings in real token formats, not real credentials.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEEP = resolve(import.meta.dirname, "../.github/polson/keep-transcript.sh");

const FAKE = {
  githubApp: "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  githubPat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  anthropic: "sk-ant-" + "oat01-abcdefghijklmnopqrstuvwxyz0123456789",
  jwt: "eyJhbGciOiJSUzI1NiJ9." + "eyJzdWIiOiJyZXBvIn0." + "c2lnbmF0dXJlLXZhbHVl",
  url: "https://x-access-token:" + "ghs_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8" + "@github.com/shrooms08/polson.git",
  header: "AUTHORIZATION: basic " + "eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==",
};

describe("keep-transcript.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-keep-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function keep(name: string, content: string | null) {
    const src = join(dir, "claude-execution-output.json");
    if (content !== null) writeFileSync(src, content);
    const r = spawnSync("bash", [KEEP, name, content === null ? join(dir, "missing.json") : src], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir },
    });
    const kept = join(dir, "transcripts", `${name}.json`);
    return { ...r, kept: existsSync(kept) ? readFileSync(kept, "utf8") : null };
  }

  it("keeps the transcript with every credential format redacted", () => {
    const transcript = JSON.stringify([
      { type: "assistant", text: "Reading .git/config" },
      { type: "tool_result", text: `token ${FAKE.githubApp} and ${FAKE.githubPat}` },
      { type: "tool_result", text: `key ${FAKE.anthropic} jwt ${FAKE.jwt}` },
      { type: "tool_result", text: `remote ${FAKE.url}\n${FAKE.header}` },
    ]);
    const r = keep("build", transcript);

    expect(r.status, r.stderr).toBe(0);
    expect(r.kept).not.toBeNull();
    for (const secret of Object.values(FAKE)) expect(r.kept).not.toContain(secret);
    expect(r.kept).toContain("Reading .git/config");
    expect(r.kept?.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps an ordinary transcript unchanged", () => {
    const transcript = JSON.stringify([{ type: "assistant", text: "npm test: 190 passed" }]);
    const r = keep("resolve1", transcript);

    expect(r.status, r.stderr).toBe(0);
    expect(r.kept).toBe(transcript);
  });

  // The workflow runs this only after the agent step ran, so a missing transcript
  // is an anomaly to report (rule 6), not a silent "nothing to keep". It must not
  // fail the step either: the run's outcome comes from the agent and the scripts.
  it("a step that ran but left no transcript: a warning and a note in the artifact", () => {
    const r = keep("resolve2", null);

    expect(r.status, r.stderr).toBe(0);
    expect(r.kept).toBeNull();
    expect(r.stdout).toContain("::warning::The resolve2 step ran but left no transcript");
    const note = join(dir, "transcripts", "resolve2.missing.txt");
    expect(existsSync(note)).toBe(true);
    expect(readFileSync(note, "utf8")).toContain("ran but left no transcript");
  });

  it("refuses an unknown step name", () => {
    const r = keep("anything", "{}");

    expect(r.status).toBe(2);
  });
});
