import { generateEntityId } from "@medusajs/utils";

import { VendorCreditError, type CreateVendorCreditInput, type PgClient } from "./types";

interface VendorRow {
  id: string;
  full_name: string;
  qb_list_id: string;
}

/**
 * Draft creation — no GL, no QB, no period lock (those apply at `post`,
 * plan §3: the number/freeze happens at post, same as `vendor_bill`'s VB
 * number is assigned at confirm). `total_cents` is the live sum of lines;
 * it is NOT frozen until posted.
 *
 * ZERO lines is allowed here on purpose: the POS creates the credit header
 * first (vendor + date), then edits its lines with PATCH — `post` is where
 * "at least one line, total > 0" is actually enforced (`no_lines`, 400).
 */
export async function createDraftVendorCredit(
  client: PgClient,
  input: CreateVendorCreditInput
): Promise<{ id: string }> {
  for (const line of input.lines) {
    if (!(line.amount_cents > 0)) {
      throw new VendorCreditError("invalid_line_amount", "Every line must have amount_cents > 0.");
    }
    if (line.line_type === "qb_account" && !line.qb_account_list_id) {
      throw new VendorCreditError(
        "missing_qb_account",
        "A qb_account line needs qb_account_list_id."
      );
    }
  }

  const { rows: vendorRows } = await client.query(
    `SELECT id, full_name, qb_list_id FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL`,
    [input.vendor_id]
  );
  const vendor = vendorRows[0] as VendorRow | undefined;
  if (!vendor) {
    throw new VendorCreditError("vendor_not_found", "Vendor not found.", 404);
  }

  let accountByListId = new Map<string, { full_name: string; account_type: string }>();
  const accountListIds = input.lines
    .map((l) => l.qb_account_list_id)
    .filter((v): v is string => !!v);
  if (accountListIds.length > 0) {
    const { rows } = await client.query(
      `SELECT qb_list_id, full_name, account_type FROM qb_account
        WHERE qb_list_id = ANY($1::text[]) AND deleted_at IS NULL AND is_active = true`,
      [accountListIds]
    );
    accountByListId = new Map(
      (rows as { qb_list_id: string; full_name: string; account_type: string }[]).map((r) => [
        r.qb_list_id,
        { full_name: r.full_name, account_type: r.account_type },
      ])
    );
    for (const listId of accountListIds) {
      if (!accountByListId.has(listId)) {
        throw new VendorCreditError(
          "account_not_found",
          `QB account ${listId} not found or inactive.`
        );
      }
    }
  }

  const totalCents = input.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  const id = generateEntityId("", "vcr");

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO vendor_credit
         (id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
          credit_date, reason, memo, status, total_cents, applied_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,0)`,
      [
        id,
        vendor.id,
        vendor.full_name,
        vendor.qb_list_id,
        input.credit_date,
        input.reason ?? null,
        input.memo ?? null,
        totalCents,
      ]
    );

    let sort = 0;
    for (const line of input.lines) {
      const lineId = generateEntityId("", "vcrl");
      const account = line.qb_account_list_id ? accountByListId.get(line.qb_account_list_id) : null;
      await client.query(
        `INSERT INTO vendor_credit_line
           (id, credit_id, sort, line_type, variant_id, sku, description, qty,
            unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          lineId,
          id,
          sort++,
          line.line_type,
          line.variant_id ?? null,
          line.sku ?? null,
          line.description ?? null,
          line.qty ?? null,
          line.unit_cost_cents ?? null,
          line.qb_account_list_id ?? null,
          account?.full_name ?? null,
          account?.account_type ?? null,
          line.amount_cents,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  return { id };
}
