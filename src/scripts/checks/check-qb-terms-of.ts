import type { MedusaContainer } from "@medusajs/framework/types";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";
import { escapeXml, qbxmlEnvelope } from "../../lib/quickbooks/qbxml-escape";
export default async function run({ container }: { container: MedusaContainer }): Promise<void> {
  const knex = container.resolve("__pg_connection__") as { raw: (s: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  const names = (process.env.NAMES ?? "").split("|").filter(Boolean);
  for (const n of names) {
    const { rows } = await knex.raw(`SELECT qb_list_id, name, terms_ref_name, sync_status FROM qb_vendor WHERE name = ? AND deleted_at IS NULL`, [n]);
    const v = rows[0] as any;
    if (!v) { console.log(`  ${n}: no existe`); continue; }
    const qbxml = qbxmlEnvelope(`<VendorQueryRq><ListID>${escapeXml(v.qb_list_id)}</ListID></VendorQueryRq>`);
    const enq = await bridgeFetch<{ operationId?: string }>("/api/sync/direct-query", { method: "POST", body: { qbxml }, timeoutMs: 30_000 });
    const id = enq!.operationId!;
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await pollBridgeStatus(id);
      const op = (p.data as any)?.operation;
      if (op?.status === "completed") {
        const ret = op.result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet;
        const r0 = Array.isArray(ret) ? ret[0] : ret;
        console.log(`  ${v.name.padEnd(24)} local=${String(v.terms_ref_name).padEnd(16)} QB=${JSON.stringify(r0?.TermsRef?.FullName ?? null).padEnd(18)} sync=${v.sync_status ?? "-"}`);
        done = true;
      } else if (op?.status === "failed") { console.log(`  ${v.name}: query fallo`); done = true; }
    }
  }
}
