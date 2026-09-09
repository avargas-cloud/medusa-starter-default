/**
 * Static gate: no bank_* query may filter or write `environment` with a literal.
 * The only accepted form is `environment=${bankingEnvSql()}` (quoted literal from the
 * validated configuration). A literal 'sandbox' left behind would hide every production
 * row — silently, with everything green. Mutation-tested: reintroducing a literal,
 * dropping the filter or hiding it in a string fragment must each turn this red.
 *
 *   node --import ./node_modules/tsx/dist/loader.mjs src/scripts/verify/verify-banking-environment.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const backend = resolve(__dirname, "../../..");
const roots = ["src/lib/banking", "src/api/admin/banking", "src/api/pub/banking", "src/jobs"].map(p => resolve(backend, p));
/** Fixtures, bootstrap and the sandbox runtime are sandbox-only by contract; migrations are frozen history. */
const allowlist = [/\/modules\/banking\/migrations\//, /sandbox-runtime\.ts$/, /completion-sandbox-/, /bank-completion-/,
  /-sandbox-(adversarial|permissions|periods|api)\.ts$/, /\/scripts\/tests\//, /\/scripts\/verify\//, /\/lib\/banking\/security\.ts$/];
/** Ratchet: the exact number of environment predicates today. Dropping one turns red; adding one is a deliberate update. */
const EXPECTED_PREDICATES = 42;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const problems: string[] = [];
let predicates = 0, files = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    if (allowlist.some(pattern => pattern.test(file))) continue;
    const source = readFileSync(file, "utf8");
    const rel = relative(backend, file);
    files++;
    source.split("\n").forEach((line, index) => {
      const where = `${rel}:${index + 1}`;
      // 1. Any environment literal, in any quoting, in a query-like context.
      if (/environment\s*=\s*'(sandbox|production)'/.test(line)) problems.push(`${where}: environment literal in SQL`);
      if (/'plaid'\s*,\s*'(sandbox|production)'/.test(line)) problems.push(`${where}: environment literal in INSERT`);
      // 2. The accepted form must sit inside a template literal, never in a plain string.
      for (const match of line.matchAll(/environment=\$\{bankingEnvSql\(\)\}/g)) {
        predicates++;
        const before = source.slice(0, source.split("\n").slice(0, index).join("\n").length + match.index!);
        if (before.split("`").length % 2 === 1) problems.push(`${where}: bankingEnvSql() outside a template literal (would be sent verbatim)`);
      }
      // 2b. Any other interpolation or single-quoted literal next to `environment` is a hidden fragment.
      if (/environment\s*=\s*\$\{(?!bankingEnvSql\(\)\})/.test(line)) problems.push(`${where}: environment interpolates something other than bankingEnvSql()`);
      if (/'sandbox'|'production'/.test(line)) problems.push(`${where}: single-quoted environment literal (SQL fragment?)`);
      // 3. Token prefixes and hosts must not name an environment either.
      if (/["'`](public|access|link)-sandbox-/.test(line) && !/prefix/.test(line)) problems.push(`${where}: sandbox token prefix literal`);
      if (/sandbox\.plaid\.com|production\.plaid\.com/.test(line) && !/HOSTS\s*=/.test(line)) problems.push(`${where}: Plaid host literal outside the closed table`);
    });
  }
}
// 4. Exact ratchet: one dropped filter is one hidden production row set.
if (predicates !== EXPECTED_PREDICATES) problems.push(`${predicates} environment predicates found, expected exactly ${EXPECTED_PREDICATES} — a filter was dropped or added without updating EXPECTED_PREDICATES`);

if (problems.length) {
  console.error("FAIL verify-banking-environment:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`PASS verify-banking-environment: ${predicates} environment predicates use bankingEnvSql() across ${files} files; no literals, prefixes or hosts`);
}
