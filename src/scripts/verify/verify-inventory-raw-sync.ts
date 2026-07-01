/**
 * src/scripts/verify/verify-inventory-raw-sync.ts
 *
 * Static regression guard. Fails (exit 1) if any runtime source file issues a
 * raw-SQL `UPDATE inventory_level` that sets a numeric quantity column
 * (stocked_quantity / reserved_quantity / incoming_quantity) WITHOUT also
 * writing its `raw_*` BigNumber mirror in the same statement. That exact omission
 * caused the China-stock / MeiliSearch desync incident.
 *
 * Run:
 *   npx tsx src/scripts/verify/verify-inventory-raw-sync.ts
 * (add to CI / pre-push alongside `yarn type-check`).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..", "..");
// Scripts that legitimately repair/normalize are excluded from the scan.
const EXCLUDE_DIRS = [
  "scripts/verify",
  "scripts/tests",
  "scripts/checks",
  "scripts/debug",
  "scripts/diagnostics",
];
const PAIRS = [
  { numeric: "stocked_quantity", raw: "raw_stocked_quantity" },
  { numeric: "reserved_quantity", raw: "raw_reserved_quantity" },
  { numeric: "incoming_quantity", raw: "raw_incoming_quantity" },
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDE_DIRS.some((ex) => full.includes(ex))) continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

interface Violation {
  file: string;
  column: string;
}

function scan(): Violation[] {
  const files: string[] = [];
  walk(SRC, files);
  const violations: Violation[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!/UPDATE\s+inventory_level/i.test(text)) continue;

    // Split into UPDATE inventory_level statements (up to the next ; or template
    // close) and check each for numeric-without-raw.
    const stmts = text.split(/UPDATE\s+inventory_level/i).slice(1);
    for (const stmt of stmts) {
      const body = stmt.split(/`|;/)[0]; // stop at end of the SQL string
      for (const pair of PAIRS) {
        const setsNumeric = new RegExp(`\\b${pair.numeric}\\s*=`).test(body);
        const setsRaw = body.includes(pair.raw);
        if (setsNumeric && !setsRaw) {
          violations.push({ file, column: pair.numeric });
        }
      }
    }
  }
  return violations;
}

const violations = scan();
if (violations.length > 0) {
  console.error(
    `\n❌ verify-inventory-raw-sync: ${violations.length} raw-SQL UPDATE(s) mutate a numeric inventory column without its raw_* mirror:\n`
  );
  for (const v of violations) {
    console.error(`  - ${v.column.padEnd(20)} ${v.file.replace(SRC, "src")}`);
  }
  console.error(
    `\nEvery numeric inventory column write MUST also set its raw_* BigNumber (Medusa reads the raw_* column). See lib/inventory-transfer-link.ts moveChinaStock() for the pattern.\n`
  );
  process.exit(1);
}
console.log("✅ verify-inventory-raw-sync: all inventory_level writes keep raw_* in sync.");
