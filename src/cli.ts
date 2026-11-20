import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderMorningReport } from "./morning-report.js";
import { parseNightRecord } from "./night-record.js";

/**
 * `npm run report -- <path-to-record.json>`
 *
 * Validates the record, prints the morning report, and writes it to
 * reports/<date>.md. On any problem it prints what is wrong, writes nothing,
 * and exits with code 1.
 */

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function runReport(args: string[], io: CliIo): Promise<number> {
  const recordPath = args[0];
  if (!recordPath || args.length > 1) {
    io.err("Usage: npm run report -- <path-to-record.json>\n");
    return 1;
  }

  let raw: string;
  try {
    raw = await readFile(resolve(io.cwd, recordPath), "utf8");
  } catch (error) {
    io.err(`Could not read ${recordPath}: ${(error as Error).message}\n`);
    return 1;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    io.err(`${recordPath} is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  const parsed = parseNightRecord(json);
  if (!parsed.ok) {
    io.err(
      `${recordPath} is not a valid night record. Problems:\n` +
        parsed.problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nNo report was written.\n",
    );
    return 1;
  }

  const report = renderMorningReport(parsed.record);
  const reportsDir = resolve(io.cwd, "reports");
  const reportPath = resolve(reportsDir, `${parsed.record.date}.md`);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, report, "utf8");

  io.out(report);
  io.err(`\nWrote reports/${parsed.record.date}.md\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runReport(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
