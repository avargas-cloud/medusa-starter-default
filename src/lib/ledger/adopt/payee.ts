/**
 * adopt-qb-bank-documents — payee de cada documento adoptado.
 *
 * Fuente primaria: el `PayeeEntityRef` del documento real en QuickBooks
 * (`bank-queries.ts`, CheckQuery / CreditCardChargeQuery / CreditCardCreditQuery
 * por ventana mensual, cacheado): ListID → `qb_vendor.qb_list_id` (vendor,
 * `payee_id` = `qb_vendor.id`, como un cheque creado en el POS) o
 * `customer.metadata.qb_list_id` (customer, `payee_id` = `customer.id`).
 * Fallback: la columna Name del reporte General Ledger (snapshot) contra
 * `qb_vendor.name` y `customer.company_name` / `metadata.qb_display_name` —
 * QuickBooks exige nombres únicos entre listas, así que un nombre resuelve a
 * una sola entidad. Sin match → `other` con el nombre tal cual (igual que un
 * cheque a un nombre libre en el POS). El bridge también aporta EditSequence,
 * IsToBePrinted y memo/customer/billable por línea.
 */
import type { PoolClient } from "pg";

import { fetchBankDocuments, type QbBankDocument } from "../../qb-backfill/bank-queries";
import type { CheckPayeeType } from "../documents/bank-check-read";

import type { ImportedBankEntry } from "./classify-imported";

export type PayeeSource = "bridge" | "snapshot";

export interface ResolvedPayee {
  payee_type: CheckPayeeType;
  payee_id: string | null;
  payee_name: string;
  /** "bridge" = por ListID del documento real; "name" = por nombre; "none" = sin nombre. */
  resolved_by: "bridge" | "name" | "none";
  edit_sequence: string | null;
  to_be_printed: boolean;
  qb_memo: string | null;
  /** Por línea de QB (mismo orden que las ExpenseLine/ItemLine); vacío si no hubo bridge. */
  qb_lines: Array<{ memo: string | null; customer_id: string | null; billable: boolean }>;
}

interface Directory {
  vendorByListId: Map<string, { id: string; name: string }>;
  vendorByName: Map<string, { id: string; name: string }>;
  customerByListId: Map<string, { id: string; name: string }>;
  customerByName: Map<string, { id: string; name: string }>;
}

async function loadDirectory(client: PoolClient): Promise<Directory> {
  const vendors = (await client.query<{ id: string; qb_list_id: string | null; name: string; full_name: string | null }>(
    `SELECT id, qb_list_id, name, full_name FROM qb_vendor WHERE deleted_at IS NULL`
  )).rows;
  const customers = (await client.query<{ id: string; qb_list_id: string | null; company_name: string | null; display_name: string | null; first_name: string | null; last_name: string | null }>(
    `SELECT id, metadata->>'qb_list_id' AS qb_list_id, company_name, metadata->>'qb_display_name' AS display_name, first_name, last_name
       FROM customer WHERE deleted_at IS NULL AND (metadata->>'qb_list_id') IS NOT NULL`
  )).rows;
  const d: Directory = { vendorByListId: new Map(), vendorByName: new Map(), customerByListId: new Map(), customerByName: new Map() };
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  for (const v of vendors) {
    const entry = { id: v.id, name: v.full_name || v.name };
    if (v.qb_list_id) d.vendorByListId.set(v.qb_list_id, entry);
    for (const n of [v.name, v.full_name]) if (norm(n)) d.vendorByName.set(norm(n), entry);
  }
  for (const c of customers) {
    const name = c.company_name?.trim() || c.display_name?.trim() || `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
    const entry = { id: c.id, name };
    if (c.qb_list_id) d.customerByListId.set(c.qb_list_id, entry);
    for (const n of [c.company_name, c.display_name, `${c.first_name ?? ""} ${c.last_name ?? ""}`]) if (norm(n)) d.customerByName.set(norm(n), entry);
  }
  return d;
}

function resolveOne(entry: ImportedBankEntry, doc: QbBankDocument | undefined, dir: Directory): ResolvedPayee {
  const base = {
    edit_sequence: doc?.edit_sequence ?? null,
    to_be_printed: doc?.is_to_be_printed ?? false,
    qb_memo: doc?.memo ?? null,
    qb_lines: doc ? doc.lines.map((l) => ({ memo: l.memo, customer_id: l.customer_list_id ? (dir.customerByListId.get(l.customer_list_id)?.id ?? null) : null, billable: l.billable })) : [],
  };
  if (doc?.payee_list_id) {
    const v = dir.vendorByListId.get(doc.payee_list_id);
    if (v) return { payee_type: "vendor", payee_id: v.id, payee_name: v.name, resolved_by: "bridge", ...base };
    const c = dir.customerByListId.get(doc.payee_list_id);
    if (c) return { payee_type: "customer", payee_id: c.id, payee_name: c.name, resolved_by: "bridge", ...base };
  }
  const name = (doc?.payee_full_name ?? entry.name ?? "").trim();
  const key = name.toLowerCase();
  if (key) {
    const v = dir.vendorByName.get(key);
    if (v) return { payee_type: "vendor", payee_id: v.id, payee_name: v.name, resolved_by: "name", ...base };
    const c = dir.customerByName.get(key);
    if (c) return { payee_type: "customer", payee_id: c.id, payee_name: c.name, resolved_by: "name", ...base };
    return { payee_type: "other", payee_id: null, payee_name: name, resolved_by: "name", ...base };
  }
  return { payee_type: "other", payee_id: null, payee_name: `QB ${entry.txn_type} ${entry.ref_number ?? entry.txn_id}`, resolved_by: "none", ...base };
}

export async function resolvePayees(
  client: PoolClient,
  entries: ImportedBankEntry[],
  opts: { source: PayeeSource; cacheDir: string; from: string; to: string; log: (line: string) => void }
): Promise<Map<string, ResolvedPayee>> {
  const dir = await loadDirectory(client);
  const docs = opts.source === "bridge"
    ? await fetchBankDocuments({ from: opts.from, to: opts.to, cacheDir: opts.cacheDir, log: opts.log })
    : new Map<string, QbBankDocument>();
  const out = new Map<string, ResolvedPayee>();
  let bridged = 0;
  for (const entry of entries) {
    const doc = docs.get(entry.txn_id);
    if (doc) bridged += 1;
    out.set(entry.txn_id, resolveOne(entry, doc, dir));
  }
  if (opts.source === "bridge") opts.log(`payee por bridge: ${bridged}/${entries.length} documentos encontrados en QuickBooks`);
  return out;
}
