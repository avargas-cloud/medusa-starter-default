import * as fs from "fs";
import * as path from "path";

let peakCache: Record<string, number> | null = null;

export function getExcelPeak(): Record<string, number> {
  if (peakCache) return peakCache;
  try {
    const filePath = path.resolve(
      process.cwd(),
      "src/scripts/sync/purchasing-peak-sales.json"
    );
    peakCache = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
      string,
      number
    >;
  } catch {
    peakCache = {};
  }
  return peakCache;
}
