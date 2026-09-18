/**
 * probe-check-mod-qbxml — sonda READ-ONLY del esquema de `CheckModRq` /
 * `CreditCardChargeModRq` / `<Tipo>QueryRq` contra QuickBooks REAL
 * (plan check-revise-20260918, checkpoint R3 — el operador aprueba cada corrida).
 *
 * Manda cada request con un TxnID INEXISTENTE (`FFFFFFFF-0000000000`): si el
 * XML respeta el esquema, QuickBooks contesta 3120 "Object … cannot be found"
 * (parseó, buscó, no encontró) y NO muta nada; si el orden de elementos está
 * mal contesta 0x80040400 (parse error). Control negativo: el mismo Mod con
 * TxnDate y RefNumber INVERTIDOS — si el control también da 3120, QuickBooks
 * es laxo con el orden y la sonda no discrimina (se informa, no se esconde).
 *
 * Nunca imprime la URL del bridge ni la API key (los lee `bridgeFetch`).
 *
 *   env QB_BRIDGE_URL=… QB_API_KEY=… DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/tsx src/scripts/debug/probe-check-mod-qbxml.ts
 */
import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";
import { readDirectQueryStatus } from "../../lib/quickbooks/gl-documents/confirm";
import {
  buildCheckModQbxml,
  buildCreditCardChargeModQbxml,
  buildGlDocumentQueryQbxml,
  glQbModResponseTag,
  glQbQueryResponseTag,
} from "../../lib/quickbooks/gl-documents/qbxml-mod-builders";
import type { GlQbTxnType } from "../../lib/quickbooks/gl-documents/qbxml-builders";

const NX = "FFFFFFFF-0000000000";

/** Invierte el par TxnDate/RefNumber en el orden que esté (el builder de Check y el de CC los llevan al revés). */
function swapDateAndRef(xml: string): string {
  const a = xml.replace(/<TxnDate>([^<]+)<\/TxnDate><RefNumber>([^<]+)<\/RefNumber>/, "<RefNumber>$2</RefNumber><TxnDate>$1</TxnDate>");
  if (a !== xml) return a;
  return xml.replace(/<RefNumber>([^<]+)<\/RefNumber><TxnDate>([^<]+)<\/TxnDate>/, "<TxnDate>$2</TxnDate><RefNumber>$1</RefNumber>");
}
const log = (s: string): void => process.stdout.write(`${s}\n`);

async function send(label: string, qbxml: string, rsTag: string): Promise<{ statusCode: string | null; statusMessage: string }> {
  const submitted = (await bridgeFetch("POST", "/api/sync/direct-query", { qbxml })) as { operationId?: string; operation_id?: string } | undefined;
  const opId = submitted?.operationId ?? submitted?.operation_id;
  if (!opId) throw new Error(`${label}: bridge returned no operationId`);
  let raw: Record<string, unknown> | null;
  try {
    raw = (await pollRawOperationResult(opId, () => undefined)) as Record<string, unknown> | null;
  } catch (error) {
    // El poll TIRA cuando la op falló (0x80040400 = parse error): eso ES el veredicto, no un crash.
    const message = error instanceof Error ? error.message : String(error);
    log(`  ${label}: op failed · ${message.slice(0, 160)}`);
    return { statusCode: message, statusMessage: message };
  }
  const result = (raw?.result ?? raw) as Record<string, unknown> | undefined;
  const qbxmlNode = (result?.QBXML ?? result) as Record<string, unknown> | undefined;
  const msgsRs = (qbxmlNode?.QBXMLMsgsRs ?? qbxmlNode) as Record<string, unknown> | undefined;
  const rs = msgsRs?.[rsTag] as Record<string, unknown> | undefined;
  const status = readDirectQueryStatus(rs);
  const errorText = typeof raw?.error === "string" ? raw.error : "";
  log(`  ${label}: ${rsTag} statusCode=${status.statusCode ?? "(none)"} · ${status.statusMessage || errorText || JSON.stringify(raw).slice(0, 160)}`);
  return status.statusCode === null && errorText ? { statusCode: errorText, statusMessage: errorText } : status;
}

async function main(): Promise<void> {
  if (process.env.DISABLE_SCHEDULED_JOBS !== "true") throw new Error("DISABLE_SCHEDULED_JOBS=true es obligatorio");
  const common = {
    txnId: NX,
    editSequence: "0",
    bankAccountListId: "80000006-1317847775", // Chase (existe; QB valida el TxnID antes)
    payeeListId: null,
    txnDate: "2026-09-18",
    refNumber: "PROBE",
    memo: "PROBE check-revise-20260918 - nonexistent TxnID, must not mutate",
    lines: [{ accountListId: "80000015-1317847948", amountCents: 100n, memo: "probe" }],
  };
  const only = process.argv.slice(2).find((a) => a.startsWith("--type="))?.slice(7);
  let failures = 0;
  for (const type of (["Check", "CreditCardCharge"] as GlQbTxnType[]).filter((t) => !only || t === only)) {
    log(`\n── ${type}`);
    const q = await send(`${type}QueryRq by TxnID`, buildGlDocumentQueryQbxml(type, NX), glQbQueryResponseTag(type));
    // Un Query por TxnID inexistente contesta 500 (warn "could not be found") o 3120: parseó.
    const qOk = /(^|[^0-9])(500|3120)([^0-9]|$)/.test(String(q.statusCode)) || ["0", "1"].includes(String(q.statusCode));
    log(`  ${qOk ? "✅" : "⚠️"} ${type}QueryRq parsea`);
    if (!qOk) failures++;

    const full = type === "Check" ? buildCheckModQbxml({ ...common, isToBePrinted: false }) : buildCreditCardChargeModQbxml(common);
    // Variantes para LOCALIZAR qué elemento/orden rechaza el esquema (todas con TxnID inexistente).
    const variants: Array<[string, string]> = [
      ["builder (completo)", full],
      ["sin ClearExpenseLines", full.replace("<ClearExpenseLines>true</ClearExpenseLines>", "")],
      ["sin IsToBePrinted", full.replace(/<IsToBePrinted>[^<]*<\/IsToBePrinted>/, "")],
      ["sin ClearExpenseLines ni IsToBePrinted", full.replace("<ClearExpenseLines>true</ClearExpenseLines>", "").replace(/<IsToBePrinted>[^<]*<\/IsToBePrinted>/, "")],
      ["sin líneas (header only)", full.replace(/<ClearExpenseLines>true<\/ClearExpenseLines>/, "").replace(/<ExpenseLineMod>[\s\S]*<\/ExpenseLineMod>/, "")],
      ["header mínimo (TxnID+EditSequence+TxnDate)", full.replace(/<AccountRef>[\s\S]*?<\/AccountRef>/, "").replace(/<RefNumber>[^<]*<\/RefNumber>/, "").replace(/<Memo>[^<]*<\/Memo>/, "").replace(/<IsToBePrinted>[^<]*<\/IsToBePrinted>/, "").replace(/<ClearExpenseLines>true<\/ClearExpenseLines>/, "").replace(/<ExpenseLineMod>[\s\S]*<\/ExpenseLineMod>/, "")],
      ["control: TxnDate y RefNumber INVERTIDOS respecto del builder", swapDateAndRef(full)],
    ];
    if (variants[variants.length - 1]![1] === full) throw new Error("negative control did not change the XML");
    for (const [name, xml] of variants) {
      const r = await send(`${type}ModRq · ${name}`, xml, glQbModResponseTag(type));
      // 3120 / 500 pueden venir como statusCode del *Rs o dentro del error de la op (el bridge marca failed los 3120).
      const parsed = /(^|[^0-9])(3120|500)([^0-9]|$)/.test(String(r.statusCode));
      log(`  ${parsed ? "✅ parsea" : "❌ NO parsea"} — ${name}`);
      if (name === "builder (completo)" && !parsed) failures++;
    }
  }
  log(failures ? `\n❌ probe-check-mod-qbxml: ${failures} problema(s) — ver qué variante parsea` : "\n✅ probe-check-mod-qbxml: los Mod del builder parsean y no mutan nada (TxnID inexistente)");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
