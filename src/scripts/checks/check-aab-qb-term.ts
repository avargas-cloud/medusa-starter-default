import type { MedusaContainer } from "@medusajs/framework/types";
import { buildVendorEditSequenceQuery } from "../../lib/quickbooks/qb-vendor-mod";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";
import { escapeXml, qbxmlEnvelope } from "../../lib/quickbooks/qbxml-escape";
export default async function run({ container }: { container: MedusaContainer }): Promise<void> {
  const knex = container.resolve("__pg_connection__") as { raw: (s: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  const { rows } = await knex.raw(`SELECT qb_list_id, name FROM qb_vendor WHERE deleted_at IS NULL AND name = 'VEETECH Co., Ltd'`);
  const v = rows[0] as { qb_list_id: string; name: string };
  const qbxml = qbxmlEnvelope(`<VendorQueryRq><ListID>${escapeXml(v.qb_list_id)}</ListID></VendorQueryRq>`);
  const enq = await bridgeFetch<{ operationId?: string }>("/api/sync/direct-query", { method: "POST", body: { qbxml }, timeoutMs: 30_000 });
  const id = enq!.operationId!;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await pollBridgeStatus(id);
    const op = (p.data as Record<string, any>)?.operation;
    if (op?.status === "completed") {
      const ret = op.result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet;
      const r0 = Array.isArray(ret) ? ret[0] : ret;
      console.log(`\nQUICKBOOKS dice para "${v.name}":`);
      console.log(`  TermsRef = ${JSON.stringify(r0?.TermsRef?.FullName ?? "(ninguno)")}`);
      console.log(`  TimeModified = ${r0?.TimeModified}`);
      return;
    }
    if (op?.status === "failed") { console.log("query fallo:", op.error); return; }
  }
  console.log("timeout consultando QB");
}
