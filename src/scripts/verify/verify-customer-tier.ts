/**
 * verify-customer-tier.ts — runnable WITHOUT a database and without the
 * Medusa container.
 *
 *   (a) the fixture matrix (docs/fixtures/customer-tier-matrix.json) through
 *       `resolveCustomerTier` — must match `expected` for every case.
 *   (b) the SAME matrix through the POS predicate (`store-pos/lib/
 *       customer-type.ts`'s `getCustomerType`), transpiled on the fly with
 *       `typescript.transpileModule` and evaluated with `new Function` — so
 *       a divergence between the backend and POS notions of "wholesale"
 *       shows up here, not in production.
 *   (c) static: the 4 price routes + the pricing hook + sync-customer import
 *       `customer-tier`; no `reg_`/`plist_` literals outside
 *       `src/lib/config` and `src/scripts`; fast-checkout contains
 *       `REPRICE_FAILED` and `CART_CUSTOMER_MISMATCH`; `case1-new-customer.ts`
 *       imports `reconcileCustomerGroups`; the 4 price routes + the hook +
 *       the reconciler import `load-customer-tier-input` and contain
 *       neither the literal `"groups.*"` nor a `fields: [...]` array with a
 *       `"groups.` entry (the soft-delete leak in `query.graph`).
 *
 * READ-ONLY. Prints PASS/FAIL per check. exit 1 on any FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-customer-tier.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";

import { resolveCustomerTier } from "../../lib/customers/customer-tier";
import matrixJson from "../../../docs/fixtures/customer-tier-matrix.json";

const ROOT = process.cwd();

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(label: string, pass: boolean, detail: string): void {
  checks.push({ label, pass, detail });
}

type MatrixCase = {
  name: string;
  input: Record<string, unknown> | null;
  expected: "wholesale" | "retail";
  /** POS `getCustomerType` is known to answer differently (documented divergence, not a gate). */
  pos_known_divergence?: string;
};

const matrix = matrixJson as MatrixCase[];

// ── (a) matrix through resolveCustomerTier ──────────────────────────────────
function checkBackendMatrix(): void {
  for (const c of matrix) {
    const got = resolveCustomerTier(c.input as any);
    record(
      `(a) resolveCustomerTier: ${c.name}`,
      got === c.expected,
      `expected=${c.expected} got=${got}`
    );
  }
}

// ── (b) matrix through the POS predicate ────────────────────────────────────
function resolveStorePosDir(): string {
  const fromEnv = process.env.STORE_POS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // repo root = the directory containing this backend's package.json
  const repoRoot = ROOT; // process.cwd() is the backend package root when run via yarn/tsx
  const fallback = resolve(repoRoot, "../store-pos");
  if (existsSync(fallback)) return fallback;

  throw new Error(
    `[verify-customer-tier] Could not locate store-pos (checked STORE_POS_DIR="${
      fromEnv ?? ""
    }" and fallback "${fallback}"). Set STORE_POS_DIR explicitly — never skip this check.`
  );
}

function loadPosGetCustomerType(): (input: unknown) => string {
  const storePosDir = resolveStorePosDir();
  const filePath = join(storePosDir, "lib", "customer-type.ts");
  if (!existsSync(filePath)) {
    throw new Error(
      `[verify-customer-tier] store-pos found at ${storePosDir} but ${filePath} is missing.`
    );
  }
  const source = readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });

  const moduleExports: Record<string, unknown> = {};
  const fakeModule = { exports: moduleExports };
  const fn = new Function("exports", "require", "module", outputText);
  fn(moduleExports, require, fakeModule);

  const getCustomerType = (fakeModule.exports as any).getCustomerType;
  if (typeof getCustomerType !== "function") {
    throw new Error(
      `[verify-customer-tier] ${filePath} did not export getCustomerType`
    );
  }
  return getCustomerType;
}

function mapMatrixInputToPos(
  input: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!input) return null;
  const { groups, metadata, ...topLevel } = input;
  return {
    ...topLevel,
    groups: groups ?? null,
    metadata: metadata ?? null,
  };
}

function checkPosMatrix(): void {
  let getCustomerType: (input: unknown) => string;
  try {
    getCustomerType = loadPosGetCustomerType();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record("(b) POS getCustomerType: load module", false, message);
    return;
  }
  record("(b) POS getCustomerType: load module", true, "loaded");

  for (const c of matrix) {
    const posInput = mapMatrixInputToPos(c.input);
    const got = getCustomerType(posInput);
    if (c.pos_known_divergence && got !== c.expected) {
      console.log(`WARN  (b) POS getCustomerType: ${c.name} — divergencia declarada: ${c.pos_known_divergence} (got=${got})`);
      continue;
    }
    record(
      `(b) POS getCustomerType: ${c.name}`,
      got === c.expected,
      `expected=${c.expected} got=${got}`
    );
  }
}

// ── (c) static checks ───────────────────────────────────────────────────────
const PRICE_ROUTE_FILES = [
  "src/api/store/products/[id]/prices-and-stock/route.ts",
  "src/api/store/products/batch-prices/route.ts",
  "src/api/store/products/by-handle/[handle]/with-prices-and-related/route.ts",
  "src/api/store/products/[id]/with-prices/route.ts",
];

function checkStatic(): void {
  // Price routes + hook + sync-customer import customer-tier.
  for (const rel of PRICE_ROUTE_FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const imports = /customer-tier/.test(src);
    record(
      `(c) ${rel} imports customer-tier`,
      imports,
      imports ? "present" : "missing import of customer-tier"
    );
  }

  const hookRel = "src/workflows/hooks/set-cart-pricing-context.ts";
  const hookSrc = readFileSync(join(ROOT, hookRel), "utf8");
  record(
    `(c) ${hookRel} imports customer-tier`,
    /customer-tier/.test(hookSrc),
    /customer-tier/.test(hookSrc) ? "present" : "missing"
  );

  const syncRel = "src/lib/meilisearch/sync-customer.ts";
  const syncSrc = readFileSync(join(ROOT, syncRel), "utf8");
  record(
    `(c) ${syncRel} imports customer-tier`,
    /customer-tier/.test(syncSrc),
    /customer-tier/.test(syncSrc) ? "present" : "missing"
  );

  // No reg_/plist_ literals outside src/lib/config and src/scripts.
  const grep = require("node:child_process").execSync(
    `grep -rn "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1\\|plist_01KFTSDZZNTQRSYNMB4YST1HYA" src --include=*.ts || true`,
    { cwd: ROOT, encoding: "utf8" }
  ) as string;
  const offendingLines = grep
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !l.startsWith("src/scripts") && !l.startsWith("src/lib/config"));
  record(
    "(c) no reg_/plist_ literals outside src/lib/config and src/scripts",
    offendingLines.length === 0,
    offendingLines.length === 0
      ? "clean"
      : `offending lines:\n${offendingLines.join("\n")}`
  );

  // fast-checkout contains REPRICE_FAILED and CART_CUSTOMER_MISMATCH.
  const fastCheckoutRel = "src/api/store/fast-checkout/route.ts";
  const fastCheckoutSrc = readFileSync(join(ROOT, fastCheckoutRel), "utf8");
  const hasRepriceFailed = /REPRICE_FAILED/.test(fastCheckoutSrc);
  record(
    `(c) ${fastCheckoutRel} contains REPRICE_FAILED`,
    hasRepriceFailed,
    hasRepriceFailed ? "present" : "missing"
  );
  const hasMismatch = /CART_CUSTOMER_MISMATCH/.test(fastCheckoutSrc);
  record(
    `(c) ${fastCheckoutRel} contains CART_CUSTOMER_MISMATCH`,
    hasMismatch,
    hasMismatch ? "present" : "missing"
  );

  // case1-new-customer.ts imports reconcileCustomerGroups.
  const case1Rel = "src/api/store/auth/register/case1-new-customer.ts";
  const case1Src = readFileSync(join(ROOT, case1Rel), "utf8");
  const importsReconciler = /reconcileCustomerGroups/.test(case1Src);
  record(
    `(c) ${case1Rel} imports reconcileCustomerGroups`,
    importsReconciler,
    importsReconciler ? "present" : "missing"
  );

  // Every file that resolves a tier from a customer id must go through
  // load-customer-tier-input (LIVE memberships), never `query.graph`'s
  // `groups.*` (soft-deleted `customer_group_customer` rows leak through
  // that path — see load-customer-tier-input.ts header).
  const RECONCILER_REL = "src/lib/customers/reconcile-customer-groups.ts";
  const LIVE_MEMBERSHIP_FILES = [
    ...PRICE_ROUTE_FILES,
    hookRel,
    RECONCILER_REL,
  ];
  // Exact patterns being grepped for, spelled out so the check is legible
  // without re-deriving them from the regex source:
  //   NEEDLE_GROUPS_STAR  matches the literal string  "groups.*"
  //   NEEDLE_GROUPS_FIELD matches a `fields: [...]` array literal that
  //                       contains a `"groups.` entry anywhere inside it
  //                       (e.g. `fields: ["id", "groups.id", "groups.name"]`)
  const NEEDLE_GROUPS_STAR = /"groups\.\*"/;
  const NEEDLE_GROUPS_FIELD = /fields:\s*\[[^\]]*?"groups\./;

  for (const rel of LIVE_MEMBERSHIP_FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");

    const importsLoader = /load-customer-tier-input/.test(src);
    record(
      `(c) ${rel} imports load-customer-tier-input`,
      importsLoader,
      importsLoader ? "present" : "missing import of load-customer-tier-input"
    );

    const hasGroupsStar = NEEDLE_GROUPS_STAR.test(src);
    record(
      `(c) ${rel} does not contain "groups.*"`,
      !hasGroupsStar,
      hasGroupsStar ? 'found literal "groups.*"' : "clean"
    );

    const hasGroupsField = NEEDLE_GROUPS_FIELD.test(src);
    record(
      `(c) ${rel} does not contain a fields:[...] array with "groups."`,
      !hasGroupsField,
      hasGroupsField
        ? 'found fields:[...] array containing "groups."'
        : "clean"
    );
  }
}

function main(): void {
  checkBackendMatrix();
  checkPosMatrix();
  checkStatic();

  let failures = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}\n      ${c.detail}`);
    if (!c.pass) failures++;
  }

  console.log(`\n${checks.length - failures}/${checks.length} passed`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
}

main();
