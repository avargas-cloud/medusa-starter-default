/**
 * handle-vendor-credit-add.ts
 *
 * Confirm handlers for a dispatched `vendor_credit_add` and `vendor_credit_mod`
 * (gl-purchases-v2 §4 · vc-edit-mod). Write back `qb_txn_id` /
 * `qb_edit_sequence` / `qb_synced_at` from the QuickBooks `VendorCreditRet`,
 * and — since the Mod addresses lines by QuickBooks id — each line's
 * `qb_txn_line_id`.
 *
 * Line matching is POSITIONAL within each kind: the QBXML we send lists the
 * credit's expense lines in `sort` order, then its item lines in `sort`
 * order, and QuickBooks returns `ExpenseLineRet`/`ItemLineRet` in that same
 * order. Positional is the only key available on an Add (no TxnLineID yet);
 * on a Mod the same rule holds because the request re-lists every line.
 *
 * PURE-ish: no bridge call, just the DB write — the caller
 * (`poll-submitted-rows.ts`) polls the operation and hands this the parsed Ret.
 */

export interface VendorCreditRetLine {
  TxnLineID?: string;
}

export interface VendorCreditRet {
  TxnID?: string;
  EditSequence?: string;
  ExpenseLineRet?: VendorCreditRetLine | VendorCreditRetLine[];
  ItemLineRet?: VendorCreditRetLine | VendorCreditRetLine[];
}

export interface HandleVendorCreditAddKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number; rows?: unknown[] }>;
}

function asList(v: VendorCreditRetLine | VendorCreditRetLine[] | undefined): VendorCreditRetLine[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Persists the TxnLineIDs of `ret` onto the credit's ACTIVE lines by position
 * within each kind. Never throws on a count mismatch — QuickBooks may collapse
 * or reorder in edge cases; a line left without id is simply re-sent as new
 * (`-1`) on the next Mod, which is safe.
 */
export async function writeBackVendorCreditLineIds(
  knex: HandleVendorCreditAddKnex,
  vendorCreditId: string,
  ret: VendorCreditRet
): Promise<{ matched: number }> {
  const result = await knex.raw(
    `SELECT id, line_type FROM vendor_credit_line
      WHERE credit_id = ? AND deleted_at IS NULL
      ORDER BY sort ASC, created_at ASC`,
    [vendorCreditId]
  );
  const lines = (result.rows ?? []) as Array<{ id: string; line_type: string }>;
  const items = lines.filter((l) => l.line_type === "product");
  const expenses = lines.filter((l) => l.line_type === "qb_account");
  const itemRets = asList(ret.ItemLineRet);
  const expenseRets = asList(ret.ExpenseLineRet);
  let matched = 0;
  const pairs: Array<[string, string]> = [];
  items.forEach((l, i) => {
    const id = itemRets[i]?.TxnLineID;
    if (id) pairs.push([l.id, id]);
  });
  expenses.forEach((l, i) => {
    const id = expenseRets[i]?.TxnLineID;
    if (id) pairs.push([l.id, id]);
  });
  for (const [lineId, txnLineId] of pairs) {
    await knex.raw(
      `UPDATE vendor_credit_line SET qb_txn_line_id = ?, updated_at = NOW() WHERE id = ?`,
      [txnLineId, lineId]
    );
    matched += 1;
  }
  return { matched };
}

export async function handleVendorCreditAddConfirmed(
  knex: HandleVendorCreditAddKnex,
  vendorCreditId: string,
  ret: VendorCreditRet
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  if (!ret.TxnID) {
    return { confirmed: false, reason: "VendorCreditRet has no TxnID" };
  }
  await knex.raw(
    `UPDATE vendor_credit
        SET qb_txn_id = ?, qb_edit_sequence = COALESCE(?, qb_edit_sequence),
            qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [ret.TxnID, ret.EditSequence ?? null, vendorCreditId]
  );
  await writeBackVendorCreditLineIds(knex, vendorCreditId, ret);
  return { confirmed: true };
}

/** A confirmed Mod: fresh EditSequence + line ids (new lines got theirs now). */
export async function handleVendorCreditModConfirmed(
  knex: HandleVendorCreditAddKnex,
  vendorCreditId: string,
  ret: VendorCreditRet
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  if (!ret.EditSequence) {
    return { confirmed: false, reason: "VendorCreditRet has no EditSequence" };
  }
  await knex.raw(
    `UPDATE vendor_credit
        SET qb_edit_sequence = ?, qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [ret.EditSequence, vendorCreditId]
  );
  await writeBackVendorCreditLineIds(knex, vendorCreditId, ret);
  return { confirmed: true };
}
