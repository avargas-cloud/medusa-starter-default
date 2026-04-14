#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import * as fs from "fs";

/**
 * analyze-qb-products-migration.ts  v2
 *
 * DRY RUN ONLY — No writes. No DB changes.
 *
 * Groups QB unmatched items into SINGLE vs VARIANT families.
 *
 * Grouping rules (two validations in addition to prefix match):
 *  1. Suffix type consistency: all suffixes must be same type
 *     NUM (27,30), ALPHA (BN,WT,RG), NUM_UNIT (27K,30W)
 *     → Rejects: AMZ-COB4-20-27 (NUM) + AMZ-COB4-20-RG (ALPHA)
 *     → Rejects: suffix 27K + suffix RG (NUM_UNIT vs ALPHA)
 *  2. Description overlap: all descriptions must share ≥1 meaningful word
 *     → Rejects: E01AMPT003 "socket adapter" + E01AMPT006 "project box"
 */

const QB_DATA_FILE = "/tmp/qb-active-products.json";
const OUTPUT_TXT_FILE = "/tmp/qb-migration-analysis.txt";
const OUTPUT_JSON_FILE = "/tmp/qb-migration-analysis.json";

// ── HTML decode ───────────────────────────────────────────────────────────────
function decode(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'");
}

// ── Suffix type ───────────────────────────────────────────────────────────────
type SuffixType = "NUM" | "ALPHA" | "NUM_UNIT" | "ALPHA_NUM" | "OTHER";

function classifySuffix(rawSuffix: string): SuffixType {
  const clean = rawSuffix.replace(/^[-_\s]+/, "");
  if (!clean) return "OTHER";
  if (/^\d+$/.test(clean)) return "NUM"; // 27 30 003 007
  if (/^[A-Za-z]+$/.test(clean)) return "ALPHA"; // BN WT RG BK AL
  if (/^\d+[A-Za-z]+$/.test(clean)) return "NUM_UNIT"; // 27K 30W 40K 2700K
  if (/^[A-Za-z]+\d+$/.test(clean)) return "ALPHA_NUM"; // AL2 (rare)
  return "OTHER";
}

function hasSuffixTypeConsistency(items: QBItem[], baseSku: string): boolean {
  const types = new Set<SuffixType>();
  for (const item of items) {
    const suffix = item.sku.slice(baseSku.length);
    types.add(classifySuffix(suffix));
  }
  return types.size === 1;
}

// ── Description overlap ───────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "are",
  "has",
  "not",
  "led",
  "light",
  "lighting",
  "finish",
  "color",
  "size",
  "base",
  "each",
]);

function hasDescriptionOverlap(items: QBItem[]): boolean {
  const withDesc = items.filter(
    (i) => i.description && i.description.length > 5
  );
  if (withDesc.length < 2) return true; // no descriptions to compare → allow

  const tokenize = (desc: string): Set<string> =>
    new Set(
      desc
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    );

  let common: Set<string> | null = null;
  for (const item of withDesc) {
    const words = tokenize(item.description);
    common =
      common === null
        ? words
        : new Set([...common].filter((w) => words.has(w)));
  }
  return (common?.size ?? 0) > 0;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface QBItem {
  sku: string;
  description: string;
  price: number | string;
  type: string;
}

interface VariantGroup {
  baseSku: string;
  suffixLen: number;
  items: QBItem[];
}

interface Rejected {
  prefix: string;
  reason: string;
  count: number;
}

// ── Variant detection ─────────────────────────────────────────────────────────
const EXCLUDED_PREFIXES = [
  "E01",
  "ECNA",
  "ET",
  "EG",
  "FI",
  "GL",
  "EU",
  "KUZ",
  "LUX-L",
  "MAX",
  "SAT",
  "SID",
  "SUN",
  "VAX",
  "SUP-AP-IP-RM1-",
  "SUP-AP-IP-SM1-",
  "TS-Mirror-",
  "WE-LOV-",
  "WE-LPSRFC2",
];

function detectVariantGroups(items: QBItem[]): {
  singles: QBItem[];
  groups: VariantGroup[];
  rejected: Rejected[];
} {
  const buildPrefixMap = (
    items: QBItem[],
    trimLen: number
  ): Map<string, QBItem[]> => {
    const map = new Map<string, QBItem[]>();
    for (const item of items) {
      if (EXCLUDED_PREFIXES.some((px) => item.sku.startsWith(px))) continue;
      // Minimum prefix length is 7 letters before being considered
      if (item.sku.length < trimLen + 7) continue;

      const prefix = item.sku.slice(0, -trimLen);
      if (!map.has(prefix)) map.set(prefix, []);
      map.get(prefix)!.push(item);
    }
    return map;
  };

  const candidates2 = new Map(
    [...buildPrefixMap(items, 2)].filter(([, v]) => v.length >= 2)
  );
  const candidates3 = new Map(
    [...buildPrefixMap(items, 3)].filter(([, v]) => v.length >= 2)
  );

  const assignedSkus = new Set<string>();
  const finalGroups: VariantGroup[] = [];
  const rejected: Rejected[] = [];

  const tryAddGroup = (
    base: string,
    groupItems: QBItem[],
    suffixLen: number
  ): boolean => {
    const unassigned = groupItems.filter((i) => !assignedSkus.has(i.sku));
    if (unassigned.length < 2) return false;

    // Rule 1: suffix type consistency
    if (!hasSuffixTypeConsistency(unassigned, base)) {
      rejected.push({
        prefix: base,
        reason: "mixed suffix types (NUM vs ALPHA vs NUM_UNIT)",
        count: unassigned.length,
      });
      return false;
    }

    // Rule 2: description overlap
    if (!hasDescriptionOverlap(unassigned)) {
      rejected.push({
        prefix: base,
        reason: "descriptions share no common words — unrelated products",
        count: unassigned.length,
      });
      return false;
    }

    finalGroups.push({ baseSku: base, suffixLen, items: unassigned });
    unassigned.forEach((i) => assignedSkus.add(i.sku));
    return true;
  };

  // Checking 2-char suffixes FIRST as requested
  for (const [base, groupItems] of candidates2) {
    tryAddGroup(base, groupItems, 2);
  }

  // Checking 3-char suffixes SECOND
  for (const [base, groupItems] of candidates3) {
    const unassigned = groupItems.filter((i) => !assignedSkus.has(i.sku));
    const alreadyCovered = finalGroups.some(
      (g) => g.baseSku.startsWith(base) || base.startsWith(g.baseSku)
    );
    if (!alreadyCovered && unassigned.length >= 2) {
      tryAddGroup(base, unassigned, 3);
    }
  }

  finalGroups.sort((a, b) => a.baseSku.localeCompare(b.baseSku));
  const singles = items
    .filter((i) => !assignedSkus.has(i.sku))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return { singles, groups: finalGroups, rejected };
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function analyzeQbProductsMigration({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("=".repeat(70));
  logger.info("🔍 QB → Medusa Migration Analysis  v2  [DRY RUN — no writes]");
  logger.info("=".repeat(70));

  if (!fs.existsSync(QB_DATA_FILE)) {
    logger.error(`❌ File not found: ${QB_DATA_FILE}`);
    return;
  }

  const qbRaw = JSON.parse(fs.readFileSync(QB_DATA_FILE, "utf8"));
  const qbAll: any[] = qbRaw.products || [];
  const qbInventory: QBItem[] = qbAll
    .filter((p) => p.type === "ItemInventory" && p.sku)
    .map((p) => ({
      sku: p.sku.trim(),
      description: decode((p.description || "").trim()),
      price: p.price,
      type: p.type,
    }));

  logger.info(
    `📦 QB Inventory items: ${qbInventory.length}  (${qbAll.length} total)`
  );

  logger.info("\n🔍 Fetching existing Medusa variant SKUs...");
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku"],
  });
  const existingSkus = new Set(
    variants.filter((v: any) => v.sku).map((v: any) => v.sku.trim())
  );
  logger.info(`   Medusa variants with SKU: ${existingSkus.size}`);

  const unmatched: QBItem[] = qbInventory.filter(
    (item) => !existingSkus.has(item.sku)
  );
  const alreadyInMedusa = qbInventory.length - unmatched.length;
  logger.info(`   Already in Medusa (skip):  ${alreadyInMedusa}`);
  logger.info(`   Missing from Medusa:       ${unmatched.length}`);

  logger.info("\n🧩 Detecting variant families with improved rules...");
  const { singles, groups, rejected } = detectVariantGroups(unmatched);

  const totalVariantsInGroups = groups.reduce(
    (sum, g) => sum + g.items.length,
    0
  );
  const totalProductsToCreate = singles.length + groups.length;

  // ── Build output ────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("=".repeat(70));
  lines.push("QB → MEDUSA MIGRATION ANALYSIS  v2  [DRY RUN — no writes]");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("=".repeat(70));
  lines.push("");

  lines.push(
    `━━━ SINGLE PRODUCTS (${singles.length}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
  lines.push(
    "  (No variant siblings detected — 1 product + 1 default variant each)"
  );
  lines.push("");
  singles.forEach((item, i) => {
    lines.push(
      `  - Product ${i + 1}: ${item.sku}  (Default, SKU: ${item.sku})`
    );
    if (item.description)
      lines.push(
        `    Description: ${item.description.slice(0, 80)}${item.description.length > 80 ? "..." : ""}`
      );
    if (item.price) lines.push(`    Price: $${item.price}`);
  });
  lines.push("");

  lines.push(
    `━━━ VARIANT PRODUCTS (${groups.length} groups, ${totalVariantsInGroups} items) ━━━━━━━━━━━━━━━━`
  );
  lines.push(
    "  (Shared SKU prefix + consistent suffix type + description overlap)"
  );
  lines.push("");
  groups.forEach((group, i) => {
    lines.push(
      `  - Product ${i + 1}: ${group.baseSku}  [${group.items.length} variants, suffix -${group.suffixLen}]`
    );
    group.items.forEach((item, j) => {
      lines.push(`      --- Variant ${j + 1}: ${item.sku}   ($${item.price})`);
      if (item.description)
        lines.push(
          `               ${item.description.slice(0, 70)}${item.description.length > 70 ? "..." : ""}`
        );
    });
  });
  lines.push("");

  lines.push(
    `━━━ REJECTED CANDIDATE GROUPS (${rejected.length}) ━━━━━━━━━━━━━━━━━━━━━━`
  );
  lines.push("  (These looked like variant families but failed validation)");
  lines.push("");
  rejected.forEach((r, i) => {
    lines.push(
      `  - Rejected ${i + 1}: prefix="${r.prefix}"  [${r.count} items]`
    );
    lines.push(`    Reason: ${r.reason}`);
  });
  lines.push("");

  lines.push("━".repeat(70));
  lines.push("RESUMEN");
  lines.push("━".repeat(70));
  lines.push(
    `  Productos totales en QuickBooks (inventory):    ${qbInventory.length}`
  );
  lines.push(
    `  Ya en Medusa (skip):                           ${alreadyInMedusa}`
  );
  lines.push(
    `  Items faltantes por procesar:                  ${unmatched.length}`
  );
  lines.push("");
  lines.push(
    `  Productos por crear en Medusa:                 ${totalProductsToCreate}`
  );
  lines.push(
    `    → Productos individuales (single):           ${singles.length}`
  );
  lines.push(
    `    → Grupos variantes:                         ${groups.length}`
  );
  lines.push(
    `    → Variantes totales a crear:                ${singles.length + totalVariantsInGroups}`
  );
  lines.push(
    `    → Grupos rechazados (bad grouping):         ${rejected.length}`
  );
  lines.push("━".repeat(70));

  fs.writeFileSync(OUTPUT_TXT_FILE, lines.join("\n"), "utf8");

  const outputJson = {
    generatedAt: new Date().toISOString(),
    summary: {
      qbInventoryTotal: qbInventory.length,
      alreadyInMedusa,
      missingFromMedusa: unmatched.length,
      productsToCreate: totalProductsToCreate,
      singleProducts: singles.length,
      variantGroups: groups.length,
      variantsTotal: singles.length + totalVariantsInGroups,
      rejectedGroups: rejected.length,
    },
    singles: singles.map((s) => ({
      sku: s.sku,
      description: s.description,
      price: s.price,
    })),
    groups: groups.map((g) => ({
      baseSku: g.baseSku,
      suffixLen: g.suffixLen,
      variants: g.items.map((v) => ({
        sku: v.sku,
        description: v.description,
        price: v.price,
      })),
    })),
    rejected,
  };
  fs.writeFileSync(
    OUTPUT_JSON_FILE,
    JSON.stringify(outputJson, null, 2),
    "utf8"
  );

  logger.info(`\n━━━ RESUMEN ━━━`);
  logger.info(`  QB inventory items:       ${qbInventory.length}`);
  logger.info(`  Ya en Medusa (skip):      ${alreadyInMedusa}`);
  logger.info(`  Faltantes:                ${unmatched.length}`);
  logger.info(`  Productos a crear:        ${totalProductsToCreate}`);
  logger.info(`    → Singles:              ${singles.length}`);
  logger.info(`    → Variant groups:       ${groups.length}`);
  logger.info(
    `    → Variantes totales:    ${singles.length + totalVariantsInGroups}`
  );
  logger.info(`    → Grupos rechazados:    ${rejected.length}`);
  logger.info(`\n📄 Full report: ${OUTPUT_TXT_FILE}`);
  logger.info(`📄 JSON data:   ${OUTPUT_JSON_FILE}`);
}
