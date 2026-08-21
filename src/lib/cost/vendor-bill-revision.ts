import { createHash } from "crypto";

import type { TrxLike } from "./restatement/apply-plan";

export interface VendorBillRevisionSnapshot {
  header: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  inputHash: string;
}

export async function loadVendorBillRevisionSnapshot(
  db: TrxLike,
  vendorBillId: string
): Promise<VendorBillRevisionSnapshot> {
  const [headerResult, linesResult] = await Promise.all([
    db.raw(`SELECT * FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`, [
      vendorBillId,
    ]),
    db.raw(
      `SELECT * FROM vendor_bill_line
        WHERE vendor_bill_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
      [vendorBillId]
    ),
  ]);
  const header = headerResult.rows[0] as Record<string, unknown> | undefined;
  if (!header) throw new Error("Vendor bill not found");
  const lines = linesResult.rows as Array<Record<string, unknown>>;
  const stable = JSON.stringify({
    header: stableHeader(header),
    lines: lines.map(stableLine),
  });
  return {
    header,
    lines,
    inputHash: createHash("sha256").update(stable).digest("hex"),
  };
}

function stableHeader(
  header: Record<string, unknown>
): Record<string, unknown> {
  const {
    updated_at: _updatedAt,
    confirmed_at: _confirmedAt,
    confirmed_by_user_id: _confirmedBy,
    active_revision_id: _activeRevision,
    draft_revision_number: _draftRevision,
    ...stable
  } = header;
  return stable;
}

function stableLine(line: Record<string, unknown>): Record<string, unknown> {
  const {
    updated_at: _updatedAt,
    commission_per_unit_cents: _commission,
    freight_per_unit_cents: _freight,
    tariff_per_unit_cents: _tariff,
    landed_unit_cost_cents: _landed,
    landed_total_cents: _landedTotal,
    ...stable
  } = line;
  return stable;
}

export async function writeConfirmedVendorBillRevision(
  trx: TrxLike,
  vendorBillId: string,
  userId: string | null,
  expectedHash?: string | null
): Promise<{ revisionId: string; revisionNumber: number; inputHash: string }> {
  const snapshot = await loadVendorBillRevisionSnapshot(trx, vendorBillId);
  if (expectedHash && snapshot.inputHash !== expectedHash) {
    throw new Error("preview_stale");
  }
  const revisionResult = await trx.raw(
    `SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS next
       FROM vendor_bill_revision
      WHERE vendor_bill_id = ?`,
    [vendorBillId]
  );
  const revisionNumber = Number(
    (revisionResult.rows[0] as { next: number | string }).next
  );
  const revisionId = `vbr_${vendorBillId.slice(-12)}_${revisionNumber}`;
  await trx.raw(
    `UPDATE vendor_bill_revision
        SET status = 'superseded', superseded_at = NOW(), updated_at = NOW()
      WHERE vendor_bill_id = ? AND status = 'confirmed'`,
    [vendorBillId]
  );
  await trx.raw(
    `INSERT INTO vendor_bill_revision
       (id, vendor_bill_id, revision_number, status, input_hash,
        header_snapshot, lines_snapshot, confirmed_by_user_id, confirmed_at)
     VALUES (?, ?, ?, 'confirmed', ?, ?::jsonb, ?::jsonb, ?, NOW())`,
    [
      revisionId,
      vendorBillId,
      revisionNumber,
      snapshot.inputHash,
      JSON.stringify(snapshot.header),
      JSON.stringify(snapshot.lines),
      userId,
    ]
  );
  await trx.raw(
    `UPDATE vendor_bill
        SET active_revision_id = ?, draft_revision_number = NULL
      WHERE id = ?`,
    [revisionId, vendorBillId]
  );
  return { revisionId, revisionNumber, inputHash: snapshot.inputHash };
}
