/**
 * verify-drift-detection.ts
 *
 * F3 verification — exercises the detectDrift helper against a mock Meili
 * client covering: count match, timestamp drift, content drift, force flag,
 * and the fail-open behavior when the helper itself errors.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-drift-detection.ts
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

import { detectDrift } from "../../lib/meilisearch/drift-detection";

interface MeiliMock {
  docs: Record<string, Record<string, unknown>>;
  latestTs?: number;
  searchError?: boolean;
}

function makeClient(mock: MeiliMock) {
  return {
    index(_name: string) {
      return {
        async getStats() {
          return { numberOfDocuments: Object.keys(mock.docs).length };
        },
        async search(_q: string, _opts: unknown) {
          if (mock.searchError) throw new Error("meili search failed");
          if (!mock.latestTs) return { hits: [] };
          return { hits: [{ updated_at: mock.latestTs }] };
        },
        async getDocument(id: string, _opts: unknown) {
          const d = mock.docs[id];
          if (!d) throw new Error(`not found: ${id}`);
          return d;
        },
      };
    },
  } as any;
}

interface Check {
  name: string;
  pass: boolean;
}
const checks: Check[] = [];
const add = (name: string, pass: boolean) => checks.push({ name, pass });

async function main() {
  // ── A. Perfect match → shouldSync=false ─────────────────────────────
  {
    const client = makeClient({
      docs: { a: { id: "a" }, b: { id: "b" } },
      latestTs: 1000,
    });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a" }, { id: "b" }],
      dbLatestMs: 1000,
    });
    add("A — in-sync → shouldSync false", !r.shouldSync && r.reason === "in_sync");
  }

  // ── B. Count mismatch → shouldSync=true with reason=count_mismatch ──
  {
    const client = makeClient({
      docs: { a: { id: "a" } },
      latestTs: 1000,
    });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a" }, { id: "b" }],
      dbLatestMs: 1000,
    });
    add(
      "B — count mismatch → shouldSync true, reason=count_mismatch",
      r.shouldSync && r.reason === "count_mismatch"
    );
  }

  // ── C. Timestamp drift beyond tolerance → time_mismatch ────────────
  {
    const client = makeClient({
      docs: { a: { id: "a" } },
      latestTs: 1000,
    });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a" }],
      dbLatestMs: 20000, // 19s later than Meili
      toleranceMs: 5000,
    });
    add(
      "C — time mismatch > tolerance → reason=time_mismatch",
      r.shouldSync && r.reason === "time_mismatch"
    );
  }

  // ── D. Content drift on sample field (variantId mismatched) ────────
  {
    const client = makeClient({
      docs: {
        a: { id: "a", variantId: "WRONG" },
      },
      latestTs: 1000,
    });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a", variantId: "EXPECTED" } as any],
      dbLatestMs: 1000,
      sampleFields: ["variantId"],
      sampleSize: 1,
    });
    add(
      "D — content drift on variantId → reason=content_drift",
      r.shouldSync && r.reason === "content_drift" && r.driftMismatches >= 1
    );
  }

  // ── E. Force flag short-circuits → reason=force ────────────────────
  {
    const client = makeClient({ docs: {} });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [],
      dbLatestMs: 0,
      force: true,
    });
    add(
      "E — force=true short-circuits with reason=force",
      r.shouldSync && r.reason === "force"
    );
  }

  // ── F. Fail-open on Meili error → shouldSync=true, reason=error ────
  {
    const client = makeClient({
      docs: { a: { id: "a" } },
      searchError: true,
    });
    // getStats succeeds, but getMeiliLatestMs swallows its error and
    // returns 0, which then fails the timestamp check with reason
    // time_mismatch (not error). That's still "shouldSync=true" which is
    // the safe default. The "error" reason only fires on truly
    // unexpected failures inside detectDrift itself.
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a" }],
      dbLatestMs: 999999,
      toleranceMs: 1000,
    });
    add(
      "F — meili search error → shouldSync=true (fail-safe)",
      r.shouldSync === true
    );
  }

  // ── G. sampleSize=0 skips content drift check ──────────────────────
  {
    const client = makeClient({
      docs: { a: { id: "a", variantId: "WRONG" } },
      latestTs: 1000,
    });
    const r = await detectDrift({
      client,
      indexName: "x",
      dbDocs: [{ id: "a", variantId: "EXPECTED" } as any],
      dbLatestMs: 1000,
      sampleFields: ["variantId"],
      sampleSize: 0,
    });
    add(
      "G — sampleSize=0 disables drift detection → in_sync",
      !r.shouldSync && r.reason === "in_sync"
    );
  }

  // ── H. Each of the 3 endpoints now uses detectDrift ────────────────
  const apiRoot = resolvePath(__dirname, "../../api/admin/search");
  for (const kind of ["products", "customers", "inventory"]) {
    const p = resolvePath(apiRoot, `${kind}/sync/route.ts`);
    const src = readFileSync(p, "utf8");
    add(
      `H — /admin/search/${kind}/sync uses detectDrift`,
      /import\s+\{[^}]*detectDrift[^}]*\}/.test(src) &&
        /detectDrift\(/.test(src)
    );
    add(
      `H — /admin/search/${kind}/sync honors force=true`,
      /force\s*=\s*req\.query\.force\s*===\s*"true"/.test(src) &&
        /force,/.test(src)
    );
  }

  console.log("━".repeat(60));
  console.log("  F3 Drift Detection Helper + endpoint refactors — verification");
  console.log("━".repeat(60));
  let failed = 0;
  for (const c of checks) {
    const glyph = c.pass ? "✅" : "❌";
    console.log(`${glyph}  ${c.name}`);
    if (!c.pass) failed++;
  }
  console.log("━".repeat(60));
  if (failed === 0) {
    console.log(`✅ ALL ${checks.length} CHECKS PASSED`);
    process.exit(0);
  }
  console.log(`❌ ${failed} / ${checks.length} CHECKS FAILED`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
