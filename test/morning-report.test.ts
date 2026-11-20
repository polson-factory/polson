import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMorningReport } from "../src/morning-report.js";
import { loadRecord } from "./fixtures.js";

describe("renderMorningReport", () => {
  it("reports a shipped night", () => {
    const report = renderMorningReport(loadRecord("sample-shipped.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-17");
    expect(report).toContain("**Shipped.** The change passed review and every check that ran.");
    expect(report).toContain("**Show a friendly message when the search returns no results** (SAMPLE-101)");
    expect(lines).toContain('- An empty search shows "No matches yet. Try a shorter query."');
    expect(lines).toContain("- The message is announced to screen readers");
    expect(lines).toContain("- Existing search results render unchanged");
    expect(report).toContain("Approved by independent-reviewer (0 findings).");
    expect(lines).toContain("- PASS typecheck");
    expect(lines).toContain("- PASS unit tests: 142 passed");
    expect(lines).toContain("- PASS acceptance criteria: 3 of 3 met");
    expect(report).toContain("[#101](https://github.com/example/sample-app/pull/101)");
    expect(report).not.toContain("FAIL");
    expect(report).not.toContain("Needs your answer");
    expect(report).not.toContain("Why it was blocked");
  });

  it("reports a blocked night with its reason", () => {
    const report = renderMorningReport(loadRecord("sample-blocked.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-18");
    expect(report).toContain("**Blocked.** Polson stopped and nothing shipped.");
    expect(report).toContain("## Why it was blocked");
    expect(report).toContain(
      "The cache served stale prices after an update, so the second acceptance criterion was not met. Polson did not ship it.",
    );
    expect(report).toContain("**Cache the pricing page for faster loads** (SAMPLE-102)");
    expect(lines).toContain("- Price changes appear within 5 minutes");
    expect(report).toContain("Changes requested by independent-reviewer (2 findings).");
    expect(lines).toContain("- PASS typecheck");
    expect(lines).toContain("- FAIL unit tests: 2 failed: stale price shown after update");
    expect(report).toContain("[#102](https://github.com/example/sample-app/pull/102)");
    expect(report).not.toContain("Needs your answer");
    expect(report).not.toContain("Shipped.");
  });

  it("reports an escalated night with the reason and the question under 'Needs your answer'", () => {
    const report = renderMorningReport(loadRecord("sample-escalated.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-19");
    expect(report).toContain("**Needs you.** Polson stopped and has a question only you can answer.");

    const needsYou = report.indexOf("## Needs your answer");
    const question = report.indexOf(
      "**Question:** When a user deletes their account, should their invoices be kept for 7 years or deleted with everything else?",
    );
    const reason = report.indexOf(
      "**Why Polson stopped:** The retention policy does not say whether invoices must be kept after an account is deleted.",
    );
    const task = report.indexOf("## Task");
    expect(needsYou).toBeGreaterThan(-1);
    // The question and the reason sit under "Needs your answer", before the task details.
    expect(question).toBeGreaterThan(needsYou);
    expect(reason).toBeGreaterThan(needsYou);
    expect(task).toBeGreaterThan(question);
    expect(task).toBeGreaterThan(reason);

    expect(report).toContain("**Let users delete their account from settings** (SAMPLE-103)");
    expect(lines).toContain("- Deletion asks for confirmation first");
    expect(report).toContain("Approved by independent-reviewer (1 finding).");
    expect(lines).toContain("- PASS unit tests: 151 passed");
    // No PR in this record, so no PR section.
    expect(report).not.toContain("## Pull request");
  });

  it("says plainly when no review or checks were recorded", () => {
    const record = { ...loadRecord("sample-shipped.json"), checks: [] };
    delete (record as { review?: unknown }).review;
    const report = renderMorningReport(record);

    expect(report).toContain("No review was recorded.");
    expect(report).toContain("No checks were recorded.");
  });

  describe("determinism", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("renders the same record to the same text, regardless of clock or randomness", () => {
      const record = loadRecord("sample-escalated.json");

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      vi.spyOn(Math, "random").mockReturnValue(0.1);
      const first = renderMorningReport(record);

      vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const second = renderMorningReport(record);
      const fromFreshCopy = renderMorningReport(structuredClone(record));

      expect(second).toBe(first);
      expect(fromFreshCopy).toBe(first);
    });
  });
});
