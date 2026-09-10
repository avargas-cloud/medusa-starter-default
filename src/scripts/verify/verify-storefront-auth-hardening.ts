/**
 * verify-storefront-auth-hardening.ts — static assertions for the
 * storefront-auth-hardening changes (fix/storefront-auth-hardening):
 *
 *   (a) fast-checkout no longer trusts a client-supplied amount, and
 *       reprices before reading the cart total to charge.
 *   (b) legacy-customer activation token is high-entropy random, not
 *       Buffer.from(id:timestamp).
 *   (c) medusa-config.ts throws when JWT_SECRET/COOKIE_SECRET are missing
 *       in production, instead of falling back to "supersecret".
 *   (d) middlewares.ts registers customerAuthThrottle on the 3 customer
 *       auth routes (login, register, reset-password).
 *
 * READ-ONLY. exit 1 on any FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-storefront-auth-hardening.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── (a) fast-checkout/route.ts ─────────────────────────────────────────────
function checkFastCheckout(): void {
  const rel = "src/api/store/fast-checkout/route.ts";
  const file = join(ROOT, rel);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  // No assignment of amountCents from a client-supplied dollar amount.
  const badAssignLineIdx = lines.findIndex((l) =>
    /amountCents\s*=\s*Math\.round\(Number\(\s*frontendAmountDollars/.test(l)
  );
  record(
    "fast-checkout: no client-amount → amountCents assignment",
    badAssignLineIdx === -1,
    badAssignLineIdx === -1
      ? `${rel}: clean`
      : `${rel}:${badAssignLineIdx + 1}: found fallback assignment`
  );

  // frontendAmountDollars must not appear anywhere as a live identifier used
  // to compute the charge (it may still exist only as a comment).
  const usedAsIdentifier = /\bfrontendAmountDollars\b/.test(
    lines.filter((l) => !/^\s*\/\//.test(l.trim())).join("\n")
  );
  record(
    "fast-checkout: frontendAmountDollars not used to compute a charge",
    !usedAsIdentifier,
    usedAsIdentifier
      ? `${rel}: frontendAmountDollars still referenced outside comments`
      : `${rel}: clean`
  );

  // Reprice call present.
  const repriceLineIdx = lines.findIndex((l) =>
    /repriceCart\s*\(/.test(l)
  );
  record(
    "fast-checkout: calls repriceCart(...)",
    repriceLineIdx !== -1,
    repriceLineIdx !== -1
      ? `${rel}:${repriceLineIdx + 1}`
      : `${rel}: no repriceCart(...) call found`
  );

  // The reprice call happens BEFORE the charge is trusted — i.e. before the
  // zero-price guard / completeCartWorkflow's payment step.
  const chargeGuardLineIdx = lines.findIndex((l) =>
    /Could not determine order total/.test(l)
  );
  record(
    "fast-checkout: reprice happens before the charge total is trusted",
    repriceLineIdx !== -1 &&
      chargeGuardLineIdx !== -1 &&
      repriceLineIdx < chargeGuardLineIdx,
    `${rel}: repriceCart@${repriceLineIdx + 1}, charge-guard@${chargeGuardLineIdx + 1}`
  );

  // 502 JSON with the exact required message when the total cannot be derived.
  const has502 = /status\(502\)\.json\(\{\s*error:\s*"Could not determine order total"/.test(
    src
  );
  record(
    "fast-checkout: 502 { error: \"Could not determine order total\" } guard",
    has502,
    has502 ? `${rel}: present` : `${rel}: missing exact 502 guard`
  );
}

// ── (b) case3-legacy-customer.ts ───────────────────────────────────────────
function checkActivationTokenEntropy(): void {
  const rel = "src/api/store/auth/register/case3-legacy-customer.ts";
  const src = readFileSync(join(ROOT, rel), "utf8");
  const usesRandomBytes = /randomBytes\s*\(/.test(src);
  const usesOldForm = /Buffer\.from\(\s*`\$\{[^}]+\}:\$\{Date\.now\(\)\}`/.test(
    src
  );
  record(
    "case3-legacy-customer: activationToken uses randomBytes(",
    usesRandomBytes && !usesOldForm,
    usesRandomBytes && !usesOldForm
      ? `${rel}: randomBytes( present, old id:timestamp form gone`
      : `${rel}: randomBytes=${usesRandomBytes} oldForm=${usesOldForm}`
  );
}

// ── (c) medusa-config.ts ───────────────────────────────────────────────────
function checkConfigFailsClosed(): void {
  const rel = "medusa-config.ts";
  const src = readFileSync(join(ROOT, rel), "utf8");
  const hasThrow =
    /NODE_ENV\s*===\s*["']production["'][\s\S]{0,200}throw new Error\(\s*"JWT_SECRET and COOKIE_SECRET are required in production"/.test(
      src
    ) ||
    /throw new Error\(\s*"JWT_SECRET and COOKIE_SECRET are required in production"/.test(
      src
    );
  record(
    "medusa-config: throws when prod secrets missing",
    hasThrow,
    hasThrow ? `${rel}: throw present` : `${rel}: throw NOT found`
  );
}

// ── (d) middlewares.ts ──────────────────────────────────────────────────────
function checkMiddlewareRegistration(): void {
  const rel = "src/api/middlewares.ts";
  const src = readFileSync(join(ROOT, rel), "utf8");

  const importsThrottle = /import\s*\{\s*customerAuthThrottle\s*\}\s*from/.test(
    src
  );
  record(
    "middlewares: imports customerAuthThrottle",
    importsThrottle,
    importsThrottle ? `${rel}: import present` : `${rel}: import missing`
  );

  const required: Array<{ matcher: string; bucket: string }> = [
    { matcher: "/auth/customer/emailpass", bucket: "login" },
    { matcher: "/store/auth/register", bucket: "register" },
    { matcher: "/store/auth/reset-password", bucket: "reset" },
  ];

  for (const { matcher, bucket } of required) {
    // Find the matcher literal, then confirm customerAuthThrottle({ bucket: "<x>"
    // appears within a small window after it (same route entry).
    const matcherIdx = src.indexOf(`matcher: "${matcher}"`);
    let ok = false;
    if (matcherIdx !== -1) {
      const window = src.slice(matcherIdx, matcherIdx + 400);
      ok =
        /customerAuthThrottle\s*\(\s*\{/.test(window) &&
        window.includes(`bucket: "${bucket}"`);
    }
    record(
      `middlewares: ${matcher} registers customerAuthThrottle(bucket="${bucket}")`,
      ok,
      matcherIdx === -1
        ? `${rel}: matcher "${matcher}" not found`
        : ok
          ? `${rel}: found`
          : `${rel}: matcher found but customerAuthThrottle/bucket not adjacent`
    );
  }
}

function main(): void {
  console.log("── verify-storefront-auth-hardening ─────────────────────────\n");

  checkFastCheckout();
  checkActivationTokenEntropy();
  checkConfigFailsClosed();
  checkMiddlewareRegistration();

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
