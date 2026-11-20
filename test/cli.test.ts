import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReport } from "../src/cli.js";
import { fixturePath, loadRawFixture } from "./fixtures.js";

describe("report CLI", () => {
  let cwd: string;
  let out: string;
  let err: string;
  const io = () => ({
    cwd,
    out: (text: string) => void (out += text),
    err: (text: string) => void (err += text),
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "polson-cli-"));
    out = "";
    err = "";
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("prints the report and writes it to reports/<date>.md", async () => {
    const code = await runReport([fixturePath("sample-escalated.json")], io());

    expect(code).toBe(0);
    expect(out).toContain("## Needs your answer");
    expect(readFileSync(join(cwd, "reports", "2026-11-19.md"), "utf8")).toBe(out);
  });

  it("lists each problem, exits 1, and writes nothing for an invalid record", async () => {
    const record = loadRawFixture("sample-escalated.json");
    delete record.reason;
    delete record.questionForHuman;
    const recordPath = join(cwd, "bad.json");
    writeFileSync(recordPath, JSON.stringify(record));

    const code = await runReport([recordPath], io());

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain('- reason: is required when outcome is "escalated"');
    expect(err).toContain('- questionForHuman: is required when outcome is "escalated"');
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it("exits 1 with a readable error for a file that is not JSON", async () => {
    const recordPath = join(cwd, "broken.json");
    writeFileSync(recordPath, "{ not json");

    expect(await runReport([recordPath], io())).toBe(1);
    expect(err).toContain("is not valid JSON");
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it("exits 1 with usage help when no path is given", async () => {
    expect(await runReport([], io())).toBe(1);
    expect(err).toContain("Usage: npm run report -- <path-to-record.json>");
  });
});
