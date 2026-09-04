import { ExecArgs } from "@medusajs/framework/types";
import { IProductModuleService } from "@medusajs/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * create-bad-debt-writeoff-product.ts
 *
 * Creates the Medusa product/variant for the "Bad Debt Write-Off / Fraud Loss"
 * QB OtherCharge item, so it can be picked as a Quick Credit line in the POS.
 *
 * ── Why this item exists ────────────────────────────────────────────────────
 * A customer paid with a stolen credit card and the bank charged the payment
 * back. The goods are GONE — they shipped to the scammer — so the credit memo
 * must NOT restock inventory and must NOT reverse COGS: the units really did
 * leave, and their cost is a real loss. Crediting the original product lines
 * would do both of those wrong things.
 *
 * Instead the credit memo carries a single line of THIS item. Because it points
 * at an Expense account in QB, the memo books the classic write-off — debit
 * "Bad Debt / Fraud / Chargeback", credit A/R — while `manage_inventory: false`
 * keeps stock and average cost untouched.
 *
 * QB data (confirmed via ItemOtherChargeQueryRq, 2026-09-04):
 *   - QB Name/FullName: Bad Debt Write-Off / Fraud Loss   (Sublevel 0, no parent)
 *   - QB Type:          ItemOtherChargeRet
 *   - QB ListID:        80001C6E-1788546289
 *   - SalesTaxCodeRef:  Non  (non-taxable)
 *   - AccountRef:       Bad Debt / Fraud / Chargeback (8000018C-1788546064, Expense)
 *   - Price:            0.00 — the amount is typed per credit memo
 *   - IsActive:         true
 *
 * ── How the line reaches QB ─────────────────────────────────────────────────
 * `api/admin/pos/credit_memos/[id]/complete/route.ts` reads the variant
 * metadata: `quickbooks_id` becomes `productId` (the stable ListID, preferred
 * over FullName because a SKU can be renamed in Medusa), and `qb_item_type:
 * "OtherCharge"` is in that route's NON_INVENTORY_QB_TYPES set, so the line
 * automatically gets `noSite: true` (no <InventorySiteRef>, avoids QB error
 * 3140) and `taxable: false` — which matches the item's own "Non" tax code in
 * QB. The legacy `quickbooks_is_service` / `quickbooks_no_site` flags are set
 * too, for parity with the "Adjustement" and "Shipping Adjustment" precedents.
 *
 * SKU is the QB leaf Name verbatim, same convention as both precedents — it is
 * what the handler sends as `productName`, so the bridge's name-matching
 * fallback stays correct if a line ever arrives without a variant.
 *
 * ── Why `product.taxable` is written by hand ────────────────────────────────
 * The QB payload gets `taxable: false` for free (OtherCharge ⇒ isService), but
 * that flag never reaches the POS totals. The POS snapshots its own flag at
 * add-to-cart from `GET /admin/product-taxable/:id`, which reads the `taxable`
 * COLUMN and treats NULL as taxable (`row.taxable !== false`). createProducts()
 * leaves it true, so without this write a $3,000 write-off would pick up 7%
 * Florida tax in the credit memo — money QB never sees, since the item's own
 * SalesTaxCodeRef in QB is "Non". The column is not exposed by the product
 * module (the repo's own POST /admin/product-taxable/:id writes it with raw
 * SQL), so this does the same. Precedent for the value: the "Adjustement" item
 * is `taxable = false` in production; "Shipping Adjustment" is deliberately
 * `true` because freight IS taxable here.
 *
 * knex (`__pg_connection__`) binds with `?`, not `$1` — see CLAUDE.md.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/create-bad-debt-writeoff-product.ts
 */

const QB_LIST_ID = "80001C6E-1788546289";
const QB_FULL_NAME = "Bad Debt Write-Off / Fraud Loss";
const QB_ACCOUNT_LIST_ID = "8000018C-1788546064";
const QB_ACCOUNT_FULL_NAME = "Bad Debt / Fraud / Chargeback";
const SKU = "Bad Debt Write-Off / Fraud Loss";
const TITLE = "Bad Debt Write-Off / Fraud Loss";

export default async function createBadDebtWriteOffProduct({
  container,
}: ExecArgs) {
  const logger = container.resolve("logger");
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data: existing } = await query.graph({
    entity: "variant",
    fields: ["id", "sku"],
    filters: { sku: SKU },
  });
  if (existing.length > 0) {
    logger.info(
      `✅ Variant with SKU "${SKU}" already exists (${existing[0].id}). Nothing to do.`
    );
    return;
  }

  logger.info("═".repeat(60));
  logger.info(`📦 Creating QB OtherCharge item in Medusa: "${TITLE}"`);
  logger.info(`   QB FullName: ${QB_FULL_NAME}`);
  logger.info(`   QB ListID:   ${QB_LIST_ID}`);
  logger.info(`   QB Account:  ${QB_ACCOUNT_FULL_NAME} (${QB_ACCOUNT_LIST_ID})`);
  logger.info("═".repeat(60));

  const [created] = await productModule.createProducts([
    {
      title: TITLE,
      handle: "bad-debt-write-off-fraud-loss",
      status: "published" as const,
      metadata: {
        sales_description:
          "Bad debt write-off / fraud loss — uncollectible balance or chargeback on a fraudulent payment. Does not restock inventory or reverse COGS.",
        qb_item_type: "OtherCharge",
        qb_imported: true,
        qb_import_date: new Date().toISOString().slice(0, 10),
        qb_import_source: "create-bad-debt-writeoff-product",
      },
      variants: [
        {
          title: "Default",
          sku: SKU,
          manage_inventory: false,
          allow_backorder: true,
          prices: [],
          metadata: {
            quickbooks_id: QB_LIST_ID,
            qb_sku: SKU,
            qb_full_name: QB_FULL_NAME,
            qb_item_type: "OtherCharge",
            qb_account_list_id: QB_ACCOUNT_LIST_ID,
            qb_account_full_name: QB_ACCOUNT_FULL_NAME,
            quickbooks_is_service: true,
            quickbooks_no_site: true,
          },
        },
      ],
    } as Parameters<typeof productModule.createProducts>[0][0],
  ]);

  const productId = (created as { id: string }).id;

  // Non-taxable — see the header note. Verified by reading the column back:
  // a silent no-op here is the difference between a clean write-off and one
  // that quietly grows 7%.
  const pg = container.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings: unknown[]
    ) => Promise<{ rows?: { taxable: boolean }[] }>;
  };
  const updated = await pg.raw(
    `UPDATE product SET taxable = ? WHERE id = ? RETURNING taxable`,
    [false, productId]
  );
  const taxableNow = updated.rows?.[0]?.taxable;
  if (taxableNow !== false) {
    throw new Error(
      `Product ${productId} was created but 'taxable' did not persist as false (got ${String(
        taxableNow
      )}). The credit memo would add sales tax to a write-off — fix before using this item.`
    );
  }
  logger.info(`   Taxable: false (verified from the column)`);

  logger.info(`\n✅ Created Medusa product: ${productId}`);
  logger.info(`   Title:   ${TITLE}`);
  logger.info(`   SKU:     ${SKU}`);
  logger.info(`   QB ID:   ${QB_LIST_ID}`);
  logger.info(`   Status:  published`);
  logger.info(`\n   Review at Admin → /app/products/${productId}`);
}
