/**
 * verify-storefront-rebuild-subscriber.ts — static assertions for
 * `src/subscribers/storefront-rebuild-on-catalog-change.ts`:
 *
 *   (a) the subscriber file exists.
 *   (b) it subscribes to at least product.updated and
 *       product-category.updated.
 *   (c) it reads VERCEL_WEB_DEPLOY_HOOK_URL.
 *   (d) it debounces via the "storefront:rebuild:pending" cache key.
 *   (e) it never logs the hook URL.
 *
 * READ-ONLY. exit 1 on any FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-storefront-rebuild-subscriber.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const REL = "src/subscribers/storefront-rebuild-on-catalog-change.ts";
const FILE = join(ROOT, REL);

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(label: string, pass: boolean, detail: string): void {
  checks.push({ label, pass, detail });
}

function main(): void {
  console.log("── verify-storefront-rebuild-subscriber ─────────────────────\n");

  const fileExists = existsSync(FILE);
  record(
    "subscriber file exists",
    fileExists,
    fileExists ? `${REL}: present` : `${REL}: NOT FOUND`
  );

  if (!fileExists) {
    finish();
    return;
  }

  const src = readFileSync(FILE, "utf8");

  // (b) subscribes to at least product.updated and product-category.updated
  // (by exported constant OR string literal — the house pattern in this repo
  // uses literals for product/variant/category workflow events).
  const hasProductUpdated =
    /["']product\.updated["']/.test(src) ||
    /ProductWorkflowEvents\.UPDATED/.test(src);
  record(
    "subscribes to product.updated",
    hasProductUpdated,
    hasProductUpdated ? "found" : "missing literal/constant for product.updated"
  );

  const hasCategoryUpdated =
    /["']product-category\.updated["']/.test(src) ||
    /ProductCategoryWorkflowEvents\.UPDATED/.test(src);
  record(
    "subscribes to product-category.updated",
    hasCategoryUpdated,
    hasCategoryUpdated
      ? "found"
      : "missing literal/constant for product-category.updated"
  );

  // (c) reads the env var that carries the hook URL.
  const readsEnvVar = /process\.env\.VERCEL_WEB_DEPLOY_HOOK_URL/.test(src);
  record(
    "reads process.env.VERCEL_WEB_DEPLOY_HOOK_URL",
    readsEnvVar,
    readsEnvVar ? "found" : "no read of VERCEL_WEB_DEPLOY_HOOK_URL"
  );

  // (d) debounce key literal.
  const hasDebounceKey = /["']storefront:rebuild:pending["']/.test(src);
  record(
    'debounce key literal "storefront:rebuild:pending"',
    hasDebounceKey,
    hasDebounceKey ? "found" : "debounce key literal missing"
  );

  // (e) never logs the hook URL — no logger.*(...) call that interpolates
  // hookUrl or a *_HOOK_URL identifier.
  const leaksUrl = /logger\.\w+\([^)]*\b(hookUrl|HOOK_URL)\b/.test(src);
  record(
    "never logs the hook URL",
    !leaksUrl,
    leaksUrl ? "a logger call appears to interpolate the hook URL" : "clean"
  );

  finish();
}

function finish(): void {
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
