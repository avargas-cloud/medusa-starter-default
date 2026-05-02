/**
 * Seeds Medusa product variants with the metadata.backlighting tag based on
 * the legacy Backlighting catalog (products.json). Reads SKUs by category from
 * the Backlighting backend, looks up matching Medusa variants, and stamps the
 * tag on them. Idempotent — re-running just updates the timestamp.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/admin/data_fixes/seed-backlighting-catalog.ts
 *
 * Set DRY_RUN=1 to print what would change without writing.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PRODUCTS_PATH = path.resolve(
    __dirname,
    "../../../../../backlighting/backend/data_store/products.json"
);

const CATEGORY_MAP: Record<string, string> = {
    modules: "led-modules",
    powerSupplies: "led-drivers",
    controllers: "controllers",
    amplifiers: "amplifiers",
    remotes: "remotes",
    accessories: "accessories",
};

interface LegacyItem {
    sku?: string;
    model?: string;
}

const isLegacyItem = (v: unknown): v is LegacyItem =>
    typeof v === "object" && v !== null && typeof (v as LegacyItem).sku === "string";

/**
 * Generates candidate SKU forms for a given legacy SKU. Tries each candidate
 * against Medusa in order until one matches. Captures these real-world quirks:
 *
 *  - Power supplies have an old `-TRIAC` / `-010V` dimming-type suffix that
 *    Medusa drops (the dimming capability is now a metadata flag on the variant).
 *  - Amplifiers have an old `-CCT` / `-RGB` / `-RGBW` color-system suffix —
 *    Medusa has a single 4-channel variant (`ECTSK-AM3&4C8A`) that covers all.
 *  - Remote SKUs in the legacy catalog use prefix `ECSK-` while Medusa uses
 *    `ECTSK-`, AND the legacy `/` separator is `&` in Medusa, AND there are
 *    white/black colorways: a base remote `ECSK-RM1C1Z` matches Medusa's
 *    `ECTSK-RM1C1ZW` (white default).
 */
const skuCandidates = (legacySku: string): string[] => {
    const set = new Set<string>([legacySku]);
    const stripTrailing = (s: string, suffixes: string[]): string => {
        for (const suf of suffixes) {
            if (s.endsWith(suf)) return s.slice(0, -suf.length);
        }
        return s;
    };

    // Apply transformations cumulatively, adding each intermediate to the set.
    const variants: string[] = [legacySku];

    // Strip dimming-type suffixes
    variants.push(stripTrailing(legacySku, ["-TRIAC", "-010V"]));
    // Strip color-system suffixes
    variants.push(stripTrailing(legacySku, ["-CCT", "-RGBW", "-RGB"]));
    // Combine: strip both
    variants.push(stripTrailing(stripTrailing(legacySku, ["-TRIAC", "-010V"]), ["-CCT", "-RGBW", "-RGB"]));

    // ECSK- → ECTSK- (remotes)
    const ectskVariants = variants.map((s) => (s.startsWith("ECSK-") ? "ECTSK-" + s.slice(5) : s));
    // / → & (remotes)
    const ampVariants = ectskVariants.map((s) => s.replace(/\//g, "&"));

    for (const v of [...variants, ...ectskVariants, ...ampVariants]) set.add(v);

    // Append "W" (white default) for remote-style base SKUs.
    const withW: string[] = [];
    for (const v of set) {
        if (/^EC[T]?SK-RM/.test(v) && !/[WB]$/.test(v)) {
            withW.push(v + "W");
            withW.push(v + "B");
        }
    }
    for (const v of withW) set.add(v);

    return Array.from(set);
};

export default async function seedBacklightingCatalog({ container }: ExecArgs): Promise<void> {
    const dryRun = process.env.DRY_RUN === "1";
    const productsPath = process.env.PRODUCTS_JSON_PATH || DEFAULT_PRODUCTS_PATH;

    if (!fs.existsSync(productsPath)) {
        console.error(`[seed-backlighting] products.json not found at ${productsPath}`);
        process.exit(1);
    }
    const raw = fs.readFileSync(productsPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    const logger = container.resolve("logger");
    const productModuleService = container.resolve("product");

    let totalLooked = 0;
    let totalTagged = 0;
    let totalAlreadyTagged = 0;
    let totalNotFound = 0;
    const notFound: string[] = [];

    for (const [legacyCategory, items] of Object.entries(data)) {
        const targetCategory = CATEGORY_MAP[legacyCategory];
        if (!targetCategory) {
            logger.warn(`[seed-backlighting] Skipping unknown category: ${legacyCategory}`);
            continue;
        }
        if (!Array.isArray(items)) continue;

        logger.info(`[seed-backlighting] Processing "${legacyCategory}" → ${targetCategory} (${items.length} items)`);

        for (const item of items) {
            if (!isLegacyItem(item) || !item.sku) continue;
            totalLooked++;

            // Try each candidate SKU form until one matches a variant in Medusa.
            const candidates = skuCandidates(item.sku);
            let rawVariants: Array<{ id: string; sku: string | null; metadata?: Record<string, unknown> | null }> = [];
            let matchedSku = item.sku;
            for (const candidate of candidates) {
                rawVariants = await productModuleService.listProductVariants(
                    { sku: candidate },
                    { select: ["id", "sku", "metadata"], take: 5 }
                );
                if (rawVariants.length > 0) {
                    matchedSku = candidate;
                    if (candidate !== item.sku) {
                        logger.info(`[seed-backlighting]   resolved ${item.sku} → ${candidate}`);
                    }
                    break;
                }
            }

            // Dedupe by id — listProductVariants occasionally returns duplicates
            // due to internal joins. We must tag each unique variant exactly once.
            const seen = new Set<string>();
            const variants = rawVariants.filter((v) => {
                if (seen.has(v.id)) return false;
                seen.add(v.id);
                return true;
            });

            if (variants.length === 0) {
                totalNotFound++;
                notFound.push(`${legacyCategory}: ${item.sku} (tried ${candidates.length} variants)`);
                continue;
            }

            for (const v of variants) {
                const existingMeta = (v.metadata ?? {}) as Record<string, unknown>;
                const existingTag = existingMeta.backlighting as { category?: string } | undefined;

                if (existingTag?.category === targetCategory) {
                    totalAlreadyTagged++;
                    continue;
                }

                const newMeta = {
                    ...existingMeta,
                    backlighting: {
                        category: targetCategory,
                        addedAt: new Date().toISOString(),
                        addedBy: "seed-script",
                    },
                };

                if (dryRun) {
                    logger.info(`[seed-backlighting] DRY: would tag ${v.sku} (variant ${v.id}) → ${targetCategory}`);
                } else {
                    await productModuleService.updateProductVariants(v.id, { metadata: newMeta });
                    logger.info(`[seed-backlighting] Tagged ${v.sku} (variant ${v.id}) → ${targetCategory}`);
                }
                totalTagged++;
            }
        }
    }

    console.log("\n==== SUMMARY ====");
    console.log(`Looked at:     ${totalLooked} legacy items`);
    console.log(`Tagged:        ${totalTagged}${dryRun ? " (dry-run)" : ""}`);
    console.log(`Already OK:    ${totalAlreadyTagged}`);
    console.log(`SKU not found: ${totalNotFound}`);
    if (notFound.length > 0) {
        console.log(`\nMissing SKUs in Medusa:`);
        for (const sku of notFound) console.log(`  - ${sku}`);
    }
}
