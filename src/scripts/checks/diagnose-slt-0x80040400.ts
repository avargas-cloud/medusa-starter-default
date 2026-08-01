import type { MedusaContainer } from "@medusajs/framework/types";
import { buildVendorModQbxml } from "../../lib/quickbooks/qb-vendor-mod";
import { toVendorSnapshot } from "../../lib/vendor-terms/push";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";

/**
 * Isolates a 0x80040400 the way this repo documents: send the SAME XML with a
 * ListID QuickBooks cannot possibly have. If it parses, QB answers 3120 (object
 * not found) and NOTHING is created — so the XML is syntactically fine and the
 * fault is in the data or the reference. If it repeats 0x80040400, the request
 * never parsed and the fault is structural.
 */
async function send(qbxml: string, label: string): Promise<void> {
  const enq = await bridgeFetch<{ operationId?: string }>("/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 });
  const id = enq!.operationId!;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await pollBridgeStatus(id);
    const op = (p.data as Record<string, any>)?.operation;
    if (op?.status === "completed") {
      const rs = op.result?.QBXML?.QBXMLMsgsRs?.VendorModRs;
      console.log(`  ${label}: statusCode=${rs?.statusCode} — ${String(rs?.statusMessage ?? "").slice(0, 90)}`);
      return;
    }
    if (op?.status === "failed") { console.log(`  ${label}: FAILED — ${String(op.error).slice(0, 110)}`); return; }
  }
  console.log(`  ${label}: timeout`);
}

export default async function run({ container }: { container: MedusaContainer }): Promise<void> {
  const knex = container.resolve("__pg_connection__") as { raw: (s: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  const { rows } = await knex.raw(`SELECT * FROM qb_vendor WHERE name LIKE 'SLT Ligthing%' AND deleted_at IS NULL`);
  const v = rows[0] as Record<string, unknown>;
  const snap = toVendorSnapshot(v);
  const FAKE = "80000000-0000000000";

  console.log("\n=== aislando el 0x80040400 de SLT ===\n");
  console.log("1. XML COMPLETO con ListID inexistente (3120 = parsea bien / 0x80040400 = sintaxis)");
  await send(buildVendorModQbxml({ ...snap, qb_list_id: FAKE }, "X"), "completo");

  console.log("\n2. SIN Fax (el unico campo que ningun otro vendor del lote tenia)");
  await send(buildVendorModQbxml({ ...snap, qb_list_id: FAKE, fax: null }, "X"), "sin fax");

  console.log("\n3. SIN la direccion");
  await send(buildVendorModQbxml({ ...snap, qb_list_id: FAKE, address: null }, "X"), "sin address");

  console.log("\n4. MINIMO (solo nombre + termino)");
  await send(buildVendorModQbxml({ qb_list_id: FAKE, name: snap.name, terms_ref_name: snap.terms_ref_name }, "X"), "minimo");
}
