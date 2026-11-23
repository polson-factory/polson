// Checks properties of .github/workflows/polson-agent.yml that keep the unattended
// agents inside their limits. The workflow only runs from the default branch, so
// these are checked as text. Issue context: PR #33 (Qodo: "Builder can push
// protected files") and the agent job's time budget.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(resolve(import.meta.dirname, "../.github/workflows/polson-agent.yml"), "utf8");

/** The text of one step, from its "- name:" line to the next step or job. */
function step(name: string): string {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  expect(start, `step ${name}`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

const AGENT_STEPS = [
  '"Build: the agent implements the ticket and opens a PR"',
  '"Resolve round 1: the agent handles CI and Qodo results"',
  '"Resolve round 2: the agent handles CI and Qodo results"',
];

describe("polson-agent.yml", () => {
  // Claude Code's Write and Edit follow permission rules outside the working
  // directory too, and a bare "Write" allows them; deny rules always win.
  it.each(AGENT_STEPS)("%s: file tools are denied the trusted scripts and .git/", (name) => {
    const denied = step(name).match(/--disallowedTools "([^"]*)"/)?.[1] ?? "";
    for (const rule of [
      "Edit(/${{ runner.temp }}/**)",
      "Write(/${{ runner.temp }}/**)",
      "Edit(./.git/**)",
      "Write(./.git/**)",
      "Edit(./.github/**)",
      "Write(./.github/**)",
    ]) {
      expect(denied.split(","), rule).toContain(rule);
    }
  });

  it("the trusted copy of the scripts is owned by root and read-only", () => {
    const copy = step("Keep a copy of the scripts and prompts");
    expect(copy).toContain('sudo chown -R root:root "${{ runner.temp }}/polson"');
    expect(copy).toContain('sudo chmod -R a-w "${{ runner.temp }}/polson"');
  });

  // Every step has a limit; together they must leave the job's last 5 minutes for
  // setup and post steps, so the hand-over and the transcript upload always run.
  it("the agent job's step limits add up to at most 145 of its 150 minutes", () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf("\n  agent:\n"), WORKFLOW.indexOf("\n  qodo-record:\n"));
    expect(job).toMatch(/\n {4}timeout-minutes: 150\n/);
    const limits = [...job.matchAll(/\n {8}timeout-minutes: (\d+)\n/g)].map((m) => Number(m[1]));
    expect(limits.length).toBeGreaterThan(20);
    expect(limits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(145);
  });
});
