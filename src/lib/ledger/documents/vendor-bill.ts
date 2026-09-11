import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { buildVendorBillLines } from "../lines/vendor-bill";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerError, PostResult, ReverseResult } from "../types";

import {
  buildSnapshot,
  computeVendorBillSourceHash,
  loadHeader,
  loadLines,
  loadBoundReceipts,
  loadUpdatedAt,
} from "./vendor-bill-snapshot";

export { computeVendorBillSourceHash } from "./vendor-bill-snapshot";

/** §5: terminalidad de vendor_bill para posting. */
const POSTABLE_STATUSES = new Set(["confirmed", "synced"]);
const REVERSIBLE_STATUSES = new Set(["cancelled", "voided"]);

export async function postVendorBill(
  client: PoolClient,
  billId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, billId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { billId });
  if (!POSTABLE_STATUSES.has(header.status))
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });

  const { map, lineRows, receipts, vendorBillSnapshot } = await buildSnapshot(client, header);
  const lines = buildVendorBillLines(vendorBillSnapshot, map);
  if (lines.length === 0) return { status: "skipped", reason: "zero_amount" };

  const day = getBusinessDateString(header.document_date ?? header.confirmed_at);
  const sourceHash = computeVendorBillSourceHash({ header, lineRows, receipts });

  return postDocumentJournal(client, {
    source_kind: "vendor_bill",
    source_id: billId,
    document_number: header.number ?? billId,
    day,
    reference: header.number ?? billId,
    description: `Vendor Bill ${header.number ?? billId} (${header.bill_type})`,
    lines,
    source_snapshot: { header, lineRows, receipts },
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseVendorBill(
  client: PoolClient,
  billId: string,
  actorId: string,
  reason = "vendor bill cancelled or voided",
  /** §5: el drift del reconciler pisa esto con "hoy ET" — cancel/void usan `updated_at`. */
  dayOverride?: string
): Promise<ReverseResult> {
  const header = await loadHeader(client, billId);
  if (!header) return { status: "nothing_to_reverse" };
  const day = dayOverride ?? getBusinessDateString(await loadUpdatedAt(client, billId));
  return reverseDocumentJournal(client, {
    source_kind: "vendor_bill",
    source_id: billId,
    day,
    reason,
    actor_id: actorId,
  });
}

/** §5/§6: para el drift del reconciler — recalcula el hash SIN reconstruir las líneas. */
export async function currentVendorBillSourceHash(
  client: PoolClient,
  billId: string
): Promise<string | null> {
  const header = await loadHeader(client, billId);
  if (!header) return null;
  if (!POSTABLE_STATUSES.has(header.status) && !REVERSIBLE_STATUSES.has(header.status)) return null;
  const lineRows = await loadLines(client, billId);
  const receipts = await loadBoundReceipts(client, billId);
  return computeVendorBillSourceHash({ header, lineRows, receipts });
}

/**
 * §5: los hooks de confirm/reconfirm llaman ACÁ, no a `postVendorBill` a
 * secas — un reconfirm (reopen → editar costos → confirmar de nuevo) escribe
 * una `vendor_bill_revision` nueva y el snapshot cambia, pero
 * `postDocumentJournal` dedupea por `(source_kind, source_id)` sin mirar el
 * hash: llamar `postVendorBill` solo daría `already_posted` con la entrada
 * VIEJA todavía activa. Reversar primero (no-op la primera vez, "nothing to
 * reverse") deja el terreno limpio para que el post de abajo cree la entrada
 * con el snapshot actual — mismo resultado que esperar los 5 min del
 * reconciler, pero inmediato.
 */
export async function postOrRepostVendorBill(
  client: PoolClient,
  billId: string,
  actorId: string
): Promise<PostResult> {
  await reverseVendorBill(client, billId, actorId, "reconfirmed: reposting current snapshot");
  return postVendorBill(client, billId, actorId);
}
