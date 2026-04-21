/**
 * verify-meili-auto-sync-e2e.ts
 *
 * F5 — End-to-end verification that the MeiliSearch auto-sync system works
 * as designed after phases F1–F4.
 *
 * Creates, updates, and deletes a test product and a test customer via the
 * Medusa admin API, then polls the MeiliSearch indexes to confirm each
 * change is reflected within SYNC_DEADLINE_MS without any manual "Check
 * Sync" button click.
 *
 * Requires a running backend and admin credentials. Set:
 *
 *   MEDUSA_BACKEND_URL=http://localhost:9000
 *   MEDUSA_ADMIN_EMAIL=admin@ecopowertech.com
 *   MEDUSA_ADMIN_PASSWORD=...
 *
 * Or provide a pre-minted token:
 *
 *   MEDUSA_ADMIN_TOKEN=<jwt>
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-meili-auto-sync-e2e.ts
 *
 * This script NEVER modifies production data of real customers or real
 * products — test entities use prefix `meili-verify-` and are cleaned up
 * on completion (even when the test fails).
 */

import "dotenv/config";

const BACKEND = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD;
const ADMIN_TOKEN = process.env.MEDUSA_ADMIN_TOKEN;
const MEILI_URL = process.env.MEILISEARCH_HOST!;
const MEILI_KEY = process.env.MEILISEARCH_API_KEY!;

const SYNC_DEADLINE_MS = 10_000;
const POLL_INTERVAL_MS = 500;
const TAG = `meili-verify-${Date.now()}`;

if (!MEILI_URL || !MEILI_KEY) {
  console.error(
    "❌ MEILISEARCH_HOST and MEILISEARCH_API_KEY must be set in env"
  );
  process.exit(2);
}

async function getToken(): Promise<string> {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "Either MEDUSA_ADMIN_TOKEN or (MEDUSA_ADMIN_EMAIL + MEDUSA_ADMIN_PASSWORD) must be set"
    );
  }
  const res = await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`admin auth failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("admin auth returned no token");
  return json.token;
}

async function adminFetch(
  token: string,
  path: string,
  init: RequestInit = {}
) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `admin ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`
    );
  }
  return res.json();
}

async function meiliGetDoc(indexName: string, id: string) {
  const res = await fetch(
    `${MEILI_URL}/indexes/${indexName}/documents/${id}`,
    { headers: { authorization: `Bearer ${MEILI_KEY}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

async function pollFor<T>(
  label: string,
  fn: () => Promise<T | null>
): Promise<T> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const v = await fn();
    if (v) {
      console.log(
        `  ✓ ${label} after ${Date.now() - (deadline - SYNC_DEADLINE_MS)}ms (${attempts} polls)`
      );
      return v;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function pollAbsent(
  label: string,
  fn: () => Promise<unknown | null>
): Promise<void> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v === null || v === undefined) {
      console.log(`  ✓ ${label}`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for absence: ${label}`);
}

type TestResult = { name: string; pass: boolean; err?: string };
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  console.log(`\n▶  ${name}`);
  try {
    await fn();
    console.log(`✅ ${name}`);
    results.push({ name, pass: true });
  } catch (err: any) {
    console.log(`❌ ${name}: ${err.message}`);
    results.push({ name, pass: false, err: err.message });
  }
}

async function main() {
  console.log("━".repeat(60));
  console.log("  F5 End-to-End MeiliSearch Auto-Sync Verification");
  console.log("━".repeat(60));
  console.log(`Backend:       ${BACKEND}`);
  console.log(`Meili:         ${MEILI_URL}`);
  console.log(`Tag:           ${TAG}`);
  console.log(`Sync deadline: ${SYNC_DEADLINE_MS}ms per operation`);

  const token = await getToken();
  let productId: string | null = null;
  let customerId: string | null = null;

  try {
    // ── Test 1: product.created → products index ──────────────────────
    await runTest("product.created → products index auto-sync", async () => {
      const body = {
        title: `${TAG} — test product`,
        handle: TAG,
        status: "draft",
        options: [{ title: "Size", values: ["Default"] }],
        variants: [
          {
            title: "Default",
            sku: `${TAG}-sku`,
            manage_inventory: false,
            options: { Size: "Default" },
            prices: [{ currency_code: "usd", amount: 1 }],
          },
        ],
      };
      const { product } = (await adminFetch(token, "/admin/products", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { product: { id: string } };
      productId = product.id;
      await pollFor("products index has new doc", () =>
        meiliGetDoc("products", productId!)
      );
    });

    // ── Test 2: product.updated → products index upsert ──────────────
    if (productId) {
      await runTest("product.updated → products index refresh", async () => {
        await adminFetch(token, `/admin/products/${productId}`, {
          method: "POST",
          body: JSON.stringify({ title: `${TAG} — updated title` }),
        });
        await pollFor("products index has updated title", async () => {
          const doc = (await meiliGetDoc("products", productId!)) as {
            title?: string;
          } | null;
          return doc?.title?.includes("updated title") ? doc : null;
        });
      });
    }

    // ── Test 3: cascade → inventory index gets a doc ─────────────────
    //    The product we created has manage_inventory=false so it becomes a
    //    synthetic inventory doc keyed by variant.id. The product workflow
    //    cascade from F1.2 should populate it.
    if (productId) {
      await runTest(
        "product cascade → inventory index has synthetic doc",
        async () => {
          // Fetch variant id via admin API.
          const { product } = (await adminFetch(
            token,
            `/admin/products/${productId}`
          )) as { product: { variants: Array<{ id: string }> } };
          const variantId = product.variants[0]!.id;
          await pollFor("inventory index has variant doc", () =>
            meiliGetDoc("inventory", variantId)
          );
        }
      );
    }

    // ── Test 4: product.deleted → both indexes cleaned ───────────────
    if (productId) {
      const pid = productId;
      await runTest(
        "product.deleted → products AND inventory indexes cleaned",
        async () => {
          // Resolve variant id before deletion for the inventory check.
          const { product } = (await adminFetch(
            token,
            `/admin/products/${pid}`
          )) as { product: { variants: Array<{ id: string }> } };
          const variantId = product.variants[0]?.id;
          await adminFetch(token, `/admin/products/${pid}`, {
            method: "DELETE",
          });
          await pollAbsent("products index doc removed", () =>
            meiliGetDoc("products", pid)
          );
          if (variantId) {
            await pollAbsent("inventory index doc removed", () =>
              meiliGetDoc("inventory", variantId)
            );
          }
          productId = null;
        }
      );
    }

    // ── Test 5: customer.created → customers index ───────────────────
    await runTest("customer.created → customers index auto-sync", async () => {
      const email = `${TAG}@verify.local`;
      const { customer } = (await adminFetch(token, "/admin/customers", {
        method: "POST",
        body: JSON.stringify({
          email,
          first_name: "Meili",
          last_name: "Verify",
        }),
      })) as { customer: { id: string } };
      customerId = customer.id;
      await pollFor("customers index has new doc", () =>
        meiliGetDoc("customers", customerId!)
      );
    });

    // ── Test 6: customer.updated → customers index refresh ───────────
    if (customerId) {
      await runTest(
        "customer.updated → customers index refresh",
        async () => {
          await adminFetch(token, `/admin/customers/${customerId}`, {
            method: "POST",
            body: JSON.stringify({ first_name: "Meili-Updated" }),
          });
          await pollFor("customers index has updated first_name", async () => {
            const doc = (await meiliGetDoc(
              "customers",
              customerId!
            )) as { first_name?: string } | null;
            return doc?.first_name === "Meili-Updated" ? doc : null;
          });
        }
      );
    }

    // ── Test 7: customer.deleted → customers index ──────────────────
    if (customerId) {
      const cid = customerId;
      await runTest("customer.deleted → customers index removed", async () => {
        await adminFetch(token, `/admin/customers/${cid}`, {
          method: "DELETE",
        });
        await pollAbsent("customers index doc removed", () =>
          meiliGetDoc("customers", cid)
        );
        customerId = null;
      });
    }
  } finally {
    // Cleanup any leftover test entities (best effort).
    if (productId) {
      try {
        await adminFetch(token, `/admin/products/${productId}`, {
          method: "DELETE",
        });
      } catch {
        /* ignore */
      }
    }
    if (customerId) {
      try {
        await adminFetch(token, `/admin/customers/${customerId}`, {
          method: "DELETE",
        });
      } catch {
        /* ignore */
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────
  console.log("\n" + "━".repeat(60));
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? "✅" : "❌"}  ${r.name}`);
    if (!r.pass && r.err) console.log(`    ${r.err}`);
  }
  console.log("━".repeat(60));
  if (failed.length === 0) {
    console.log(
      `✅ ALL ${results.length} SCENARIOS PASSED — auto-sync is working.`
    );
    process.exit(0);
  }
  console.log(
    `❌ ${failed.length} / ${results.length} SCENARIOS FAILED — auto-sync has gaps.`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
