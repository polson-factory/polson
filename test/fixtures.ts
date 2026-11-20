import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseNightRecord, type NightRecord } from "../src/night-record.js";

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Raw JSON of a fixture, for building invalid variants. */
export function loadRawFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as Record<string, unknown>;
}

/** A fixture that has been validated, ready to render. */
export function loadRecord(name: string): NightRecord {
  const parsed = parseNightRecord(loadRawFixture(name));
  if (!parsed.ok) throw new Error(`${name} is invalid:\n${parsed.problems.join("\n")}`);
  return parsed.record;
}
