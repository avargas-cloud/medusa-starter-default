/**
 * Flag a vendor as the China purchasing agent by setting
 * `qb_vendor.metadata.is_china_agent = true`. Defaults to Veetech
 * (qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC), the current buying agent.
 *
 * This lights up the whole "PO to China agent must have an Inventory Transfer"
 * feature (badges + generate-IT prompt + hard receive guard). Idempotent:
 * re-running is a no-op if the flag is already true.
 *
 * Reads existing metadata and merges explicitly (never delete a key — Medusa's
 * JSONB deep-merge would re-hydrate it; see the deep-merge caveat in CLAUDE.md).
 *
 *   cd backend
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/set-vendor-china-agent.ts            # Veetech, set true
 *   env DATABASE_URL=... VENDOR_ID=qbvnd_xxx VALUE=false \
 *     npx medusa exec ./src/scripts/fix/set-vendor-china-agent.ts            # any vendor / clear
 */

const DEFAULT_VENDOR_ID = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC"; // Veetech

interface VendorRow {
  id: string;
  full_name: string | null;
  name: string;
  metadata: Record<string, unknown> | null;
}

interface CatalogLike {
  retrieveQbVendor: (id: string) => Promise<VendorRow | null>;
  updateQbVendors: (d: Record<string, unknown>) => Promise<unknown>;
}

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const vendorId = process.env.VENDOR_ID?.trim() || DEFAULT_VENDOR_ID;
  const value = process.env.VALUE !== "false"; // default true

  const catalog = container.resolve("quickbooks_catalog") as CatalogLike;

  const vendor = await catalog.retrieveQbVendor(vendorId).catch(() => null);
  if (!vendor) {
    console.error(`Vendor ${vendorId} not found.`);
    return;
  }

  const label = vendor.full_name ?? vendor.name ?? vendor.id;
  const current = Boolean(
    (vendor.metadata as Record<string, unknown> | null)?.is_china_agent
  );
  if (current === value) {
    console.log(`${label} already has is_china_agent=${value}. No change.`);
    return;
  }

  const merged = { ...(vendor.metadata ?? {}), is_china_agent: value };
  await catalog.updateQbVendors({ id: vendorId, metadata: merged });

  console.log(`${label}: is_china_agent ${current} -> ${value}. Done.`);
}
