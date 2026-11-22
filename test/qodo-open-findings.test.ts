// Tests .github/polson/qodo-open-findings.sh on real Qodo review comments saved
// from this repo's PRs (fixtures/qodo/), so its awk counting path runs on the
// CI runner's awk. Issue: https://github.com/shrooms08/polson/issues/23
// The script reads a comment body on stdin and prints the number of open High or
// Medium findings, or "unknown" if the comment cannot be read with confidence.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../.github/polson/qodo-open-findings.sh");
const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "../fixtures/qodo", name), "utf8");

function run(body: string): string {
  const r = spawnSync("bash", [SCRIPT], { input: body, encoding: "utf8" });
  // Fail loudly if bash or awk cannot run: that must not look like "unknown".
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe("qodo-open-findings.sh on real Qodo comments", () => {
  it("counts the open Medium finding (PR #20: 1 open Medium, 1 resolved)", () => {
    expect(run(fixture("pr20-open-medium.md"))).toBe("1");
  });

  it("reports 0 when every finding is resolved (PR #19)", () => {
    expect(run(fixture("pr19-all-resolved.md"))).toBe("0");
  });

  it('reports 0 for "no issues found" (PR #15)', () => {
    expect(run(fixture("pr15-no-issues.md"))).toBe("0");
  });
});

describe("qodo-open-findings.sh fails closed", () => {
  const open = fixture("pr20-open-medium.md");

  it("reports unknown for a comment truncated before the findings", () => {
    const cut = open.slice(0, open.indexOf("<details>\n<summary>  1.  Agent"));
    expect(cut.length).toBeGreaterThan(0);
    expect(run(cut)).toBe("unknown");
  });

  it("reports unknown when the count badge says more findings than are listed", () => {
    expect(run(open.replace("Requirement gaps (1)", "Requirement gaps (2)"))).toBe("unknown");
  });

  it("reports unknown for a resolved-only comment cut before the resolved section", () => {
    const body = fixture("pr19-all-resolved.md");
    expect(run(body.slice(0, body.indexOf("Resolved findings")))).toBe("unknown");
  });

  it("reports unknown for a finding without a severity badge", () => {
    expect(run(open.replace(/<img src="https:\/\/img\.shields\.io[^>]*>/, ""))).toBe("unknown");
  });

  it("reports unknown for empty input", () => {
    expect(run("")).toBe("unknown");
  });

  it("reports unknown for unreadable text that is not a Qodo review", () => {
    expect(run("\u0000\u0001\u0002 not a review")).toBe("unknown");
  });

  it("reports unknown for a comment that is not Qodo's review", () => {
    expect(run(open.replace("Code Review by Qodo", "Something else"))).toBe("unknown");
  });
});
