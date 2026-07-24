import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

interface UndoBody {
  vendor_bill_id?: string;
  supervisor_pin?: string;
  reason?: string;
}

/**
 * POST /admin/quickbooks/bill-match/undo
 *
 * Reverses a bill-match: soft-deletes the LOCAL adopted vendor_bill (+ its
 * lines). Never touches QuickBooks — the QB bill stays exactly as it was. Only
 * adopted bills can be undone here (owned bills go through their own lifecycle).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { vendor_bill_id, supervisor_pin, reason } = (req.body ?? {}) as UndoBody;
  if (!vendor_bill_id) {
    res.status(400).json({ error: "vendor_bill_id is required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    const { rows: storeRows } = await client.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM store WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    );
    const storedPin = storeRows[0]?.metadata?.pos_supervisor_pin as string | undefined;
    if (!storedPin || String(supervisor_pin ?? "") !== String(storedPin)) {
      res.status(403).json({ error: "Invalid supervisor PIN" });
      return;
    }

    const { rows } = await client.query<{ id: string; qb_source: string | null; notes: string | null }>(
      `SELECT id, qb_source, notes FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL`,
      [vendor_bill_id]
    );
    const bill = rows[0];
    if (!bill) {
      res.status(404).json({ error: "vendor_bill not found (or already removed)" });
      return;
    }
    if (bill.qb_source !== "adopted") {
      res.status(409).json({ error: "not_adopted", message: "Only adopted (QB-mirrored) bills can be undone here." });
      return;
    }

    const actor = ((req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id) ?? "system";
    const undoNote =
      `${bill.notes ?? ""} [UNDONE by ${actor} on ${new Date().toISOString()}${reason ? `: ${reason}` : ""}]`;

    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
          WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
        [vendor_bill_id]
      );
      await client.query(
        `UPDATE vendor_bill SET deleted_at = NOW(), updated_at = NOW(), notes = $2 WHERE id = $1`,
        [vendor_bill_id, undoNote]
      );
      await client.query("COMMIT");
    } catch (txErr: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw txErr;
    }

    res.json({ success: true, vendor_bill_id });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to undo bill match";
    console.error(`[QB Bill Match undo ${vendor_bill_id}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
