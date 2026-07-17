import { readFile } from "node:fs/promises";
import { parseSquadReportJSON, type SquadReport } from "./shared.ts";

export async function readSquadReport(
  path: string,
): Promise<SquadReport | undefined> {
  try {
    return parseSquadReportJSON(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
