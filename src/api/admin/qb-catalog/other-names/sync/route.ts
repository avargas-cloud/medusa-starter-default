import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ulid } from "ulid";

import { accessFailure, assertOwner } from "../../../../../lib/pos/access-level";
import { bridgeFetch, pollBridgeStatus } from "../../../../../lib/quickbooks/bridge-fetch";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/qb-catalog/other-names/sync — trae la lista **Other Names** de
 * QuickBooks (OtherNameQueryRq, activos e inactivos) y la upsertea en
 * `qb_other_name` por ListID (plan qb-other-names-picker-20260916). Mismo
 * botón de Settings que trae el Chart of Accounts; owner-only como aquél.
 *
 * Sólo LECTURA de QB: el POS nunca crea, edita ni borra un nombre allá. Un
 * nombre que desaparece de QB queda `is_active=false` acá (no se borra: los
 * documentos que lo enlazan conservan su snapshot y su id).
 *
 * → { success, total, created, updated, deactivated }
 */

type OtherNameRet = {
  ListID?: string;
  Name?: string;
  IsActive?: boolean | string;
  EditSequence?: string;
  CompanyName?: string;
};

const QBXML =
  `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>` +
  `<QBXML><QBXMLMsgsRq onError="stopOnError"><OtherNameQueryRq>` +
  `<ActiveStatus>All</ActiveStatus></OtherNameQueryRq></QBXMLMsgsRq></QBXML>`;

async function fetchOtherNames(): Promise<OtherNameRet[]> {
  const submitted = await bridgeFetch<{ operationId?: string; operation_id?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml: QBXML }, timeoutMs: 30_000 }
  );
  const opId = submitted?.operationId ?? submitted?.operation_id;
  if (!opId) throw new Error("Bridge did not return operationId");

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const polled = await pollBridgeStatus(opId);
    if (polled.status === "expired") throw new Error(`QB op ${opId} expired`);
    if (polled.status === "failed") {
      const op = polled.data.operation as { error?: unknown } | undefined;
      if (op?.error) throw new Error(`QB op ${opId} failed: ${JSON.stringify(op.error)}`);
    }
    if (polled.status !== "completed") continue;
    const op = polled.data.operation as
      | { result?: { QBXML?: { QBXMLMsgsRs?: { OtherNameQueryRs?: { $?: { statusCode?: string; statusMessage?: string }; OtherNameRet?: OtherNameRet | OtherNameRet[] } } } } }
      | undefined;
    const rs = op?.result?.QBXML?.QBXMLMsgsRs?.OtherNameQueryRs;
    if (!rs) throw new Error("QB response has no OtherNameQueryRs");
    const code = rs.$?.statusCode;
    if (code === "1") return []; // sin resultados — no es error
    if (code !== "0") throw new Error(`QB rejected OtherNameQueryRs: ${code} ${rs.$?.statusMessage ?? ""}`);
    const raw = rs.OtherNameRet ?? [];
    return Array.isArray(raw) ? raw : [raw];
  }
  throw new Error(`QB op ${opId} timed out`);
}

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const logger = req.scope.resolve("logger");
  try {
    const names = await fetchOtherNames();
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    const pool = getDbPool();
    for (const n of names) {
      const listId = n.ListID?.trim();
      const name = n.Name?.trim();
      if (!listId || !name) continue;
      seen.add(listId);
      const isActive = n.IsActive !== false && String(n.IsActive).toLowerCase() !== "false";
      const { rows } = await pool.query<{ inserted: boolean }>(
        `INSERT INTO qb_other_name (id, qb_list_id, name, is_active, edit_sequence, company_name, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (qb_list_id) DO UPDATE
           SET name = EXCLUDED.name, is_active = EXCLUDED.is_active, edit_sequence = EXCLUDED.edit_sequence,
               company_name = EXCLUDED.company_name, last_synced_at = now(), updated_at = now(), deleted_at = NULL
         RETURNING (xmax = 0) AS inserted`,
        [`qbon_${ulid()}`, listId, name, isActive, n.EditSequence ?? null, n.CompanyName?.trim() || null]
      );
      if (rows[0]?.inserted) created += 1;
      else updated += 1;
    }
    // Lo que QB ya no lista se apaga; nunca se borra (los documentos lo enlazan por id).
    const gone = await pool.query(
      `UPDATE qb_other_name SET is_active = false, updated_at = now()
        WHERE deleted_at IS NULL AND is_active = true AND NOT (qb_list_id = ANY($1::text[]))`,
      [[...seen]]
    );
    logger.info(`[qb-other-names] synced ${seen.size}: +${created} ~${updated} off:${gone.rowCount ?? 0}`);
    return res.json({ success: true, total: seen.size, created, updated, deactivated: gone.rowCount ?? 0 });
  } catch (error) {
    logger.error(`[qb-other-names] sync failed: ${(error as Error).message}`);
    return res.status(502).json({ success: false, error: (error as Error).message });
  }
};
