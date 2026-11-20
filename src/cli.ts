import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderMorningReport } from "./morning-report.js";
import { parseNightRecord } from "./night-record.js";

/**
 * `npm run report -- <path-to-record.json> [--force] [--dry-run]`
 *
 * Validates the record, prints the morning report, and writes it to
 * reports/<date>.md. On any problem it prints what is wrong, writes nothing,
 * and exits with code 1.
 *
 * - An existing report is never replaced unless `--force` is given: the run
 *   names the file, exits 1, and leaves the file unchanged.
 * - `--dry-run` prints the report and writes nothing, and says what a real run
 *   would have done. It wins over `--force`, so adding `--dry-run` to any
 *   command is always a safe preview.
 */

const USAGE = "Usage: npm run report -- <path-to-record.json> [--force] [--dry-run]\n";

type Options = { recordPath: string; force: boolean; dryRun: boolean };

/** Parse CLI arguments, or return a readable error message. */
function parseOptions(args: string[]): Options | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { force: { type: "boolean" }, "dry-run": { type: "boolean" } },
    });
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    const option = /'(-[^']*)'/.exec(message)?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return { error: `Unknown option: ${option}. Known options: --force, --dry-run.\n${USAGE}` };
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return { error: `Option ${option} does not take a value.\n${USAGE}` };
    }
    return { error: `${message}\n${USAGE}` };
  }

  const [recordPath, ...extra] = parsed.positionals;
  if (!recordPath || extra.length > 0) return { error: USAGE };
  return {
    recordPath,
    force: parsed.values.force === true,
    dryRun: parsed.values["dry-run"] === true,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function runReport(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  if ("error" in options) {
    io.err(options.error);
    return 1;
  }
  const { recordPath, force, dryRun } = options;

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
  const reportName = `reports/${parsed.record.date}.md`;
  const reportsDir = resolve(io.cwd, "reports");
  const reportPath = resolve(reportsDir, `${parsed.record.date}.md`);

  if (dryRun) {
    const alreadyThere = await exists(reportPath);
    const realRun = !alreadyThere
      ? `would write ${reportName}`
      : force
        ? `would replace ${reportName} (--force)`
        : `would refuse: ${reportName} already exists (use --force to replace it)`;
    io.out(report);
    io.err(`\nDry run: nothing was written. A real run ${realRun}.\n`);
    return 0;
  }

  await mkdir(reportsDir, { recursive: true });
  const replacing = force && (await exists(reportPath));
  try {
    // "wx" creates the file only if it does not exist, in one step, so an
    // existing report is never opened for writing without --force.
    await writeFile(reportPath, report, { encoding: "utf8", flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    io.err(
      `${reportName} already exists, so it was not overwritten.\n` +
        "Use --force to replace it, or --dry-run to print the report without writing.\n",
    );
    return 1;
  }

  io.out(report);
  io.err(`\n${replacing ? "Replaced" : "Wrote"} ${reportName}\n`);
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
