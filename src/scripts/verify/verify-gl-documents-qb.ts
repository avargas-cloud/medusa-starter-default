/**
 * verify-gl-documents-qb.ts — gate del carril "documentos GL bancarios →
 * QuickBooks" (plan gl-docs-to-qb-20260914). Read-only, sin DB.
 *
 * Un step nuevo del `qb_order_pipeline` se registra en VARIOS lugares o queda
 * `pending` para siempre sin error (regla 2026-09-11, VC-1002). Este script
 * afirma cada registro POR NOMBRE, con dos disciplinas que costaron
 * verificadores mentirosos:
 *
 *   - Un check de "llama a X" descarta las líneas de `import` (regla
 *     2026-08-19): importar el helper no es llamarlo.
 *   - Cortar por la etiqueta que abre renglón (`case "…":`), nunca por una
 *     ventana de tamaño fijo (regla 2026-07-29).
 *
 * Y dos checks de COMPORTAMIENTO, no de texto: los builders pliegan a ASCII
 * (QB rechaza 0x80040400 cualquier otro byte) y los facts fallan CERRADO con
 * una cuenta creada en el POS (`pos_…`) sin tocar Postgres (db stub).
 *
 * Correr desde backend/:  ./node_modules/.bin/tsx src/scripts/verify/verify-gl-documents-qb.ts
 * Mutation-testeado 1×1 el 2026-09-14 (ver memoria del plan).
 */
import fs from "node:fs";
import path from "node:path";

import {
  buildCheckAddQbxml,
  buildDepositAddQbxml,
  buildJournalEntryAddQbxml,
} from "../../lib/quickbooks/gl-documents/qbxml-builders";
import { loadGlDocumentAddFacts } from "../../lib/quickbooks/gl-documents/facts";
import { loadGlDocumentModFacts } from "../../lib/quickbooks/gl-documents/facts-mod";

const SRC = path.join(process.cwd(), "src");
const failures: string[] = [];
const notes: string[] = [];
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");
const ok = (label: string): void => {
  notes.push(`✓ ${label}`);
};
const bad = (label: string): void => {
  failures.push(label);
};
const check = (cond: boolean, label: string, why = ""): void => {
  if (cond) ok(label);
  else bad(`${label}${why ? ` — ${why}` : ""}`);
};

/** Líneas que no son `import`/`from` — para checks de "llama a X". */
const codeLines = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+["']/.test(l) && !/^\s*\w[\w, {}]*\bfrom\s+["']/.test(l))
    .join("\n");

const ADD = "gl_document_add";
const VOID = "gl_document_void";
const MOD = "gl_document_mod";

// ── 1 · Registro del step en cada lista que lo necesita ─────────────────────
{
  const types = read("lib/quickbooks/pipeline/types.ts");
  check(types.includes(`| "${ADD}"`) && types.includes(`| "${VOID}"`), "pipeline/types.ts: PipelineStep incluye los dos steps");

  const chain = read("lib/purchase-orders/qb-purchase-dependency-chain.ts");
  check(chain.includes(`| "${ADD}"`) && chain.includes(`| "${VOID}"`), "qb-purchase-dependency-chain.ts: PurchaseQbStep incluye los dos steps");
  for (const kind of ["gl_check", "gl_transfer", "gl_journal_entry", "bank_deposit"]) {
    check(chain.includes(`| "${kind}"`), `qb-purchase-dependency-chain.ts: referenceType admite '${kind}'`);
  }

  const dispatch = read("lib/quickbooks/consolidator/dispatch-pass.ts");
  const whitelist = dispatch.split("\n").find((l) => l.includes("WHERE step IN (") && l.includes("'estimate_cancel'")) ?? "";
  check(whitelist.includes(`'${ADD}'`) && whitelist.includes(`'${VOID}'`), "dispatch-pass.ts: la LISTA BLANCA de runPendingDispatchPass reclama los dos steps",
    "sin esto la fila queda pending hasta que el limpiador la marque failed a los 20 min (VC-1002)");

  const resubmit = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
  const caseAdd = resubmit.indexOf(`case "${ADD}":`);
  const caseVoid = resubmit.indexOf(`case "${VOID}":`);
  check(caseAdd > 0 && caseVoid > 0, "resubmit-by-step.ts: hay un case por step");
  if (caseAdd > 0 && caseVoid > 0) {
    // Cortar por la etiqueta que abre el siguiente `case`, no por una ventana fija.
    const addBody = resubmit.slice(caseAdd, caseVoid);
    const nextCase = resubmit.indexOf("\n      case ", caseVoid + 10);
    const voidBody = resubmit.slice(caseVoid, nextCase > 0 ? nextCase : undefined);
    check(addBody.includes("loadGlDocumentAddFacts(") && addBody.includes("/api/sync/direct-query"),
      "resubmit-by-step.ts: el case ADD re-evalúa los facts y despacha por direct-query");
    check(addBody.includes("deferPipelineRow(") && addBody.includes("failPipelineRow("),
      "resubmit-by-step.ts: el case ADD difiere lo transitorio y falla lo estructural");
    check(addBody.includes("WRITE.sales.skipped"), "resubmit-by-step.ts: el case ADD sabe marcar skipped (deposit con partida de apertura)");
    check(addBody.includes("idempotencyKey: `gl-document-add:${row.id}`"), "resubmit-by-step.ts: Idempotency-Key 1:1 con la fila (gl-document-add:<rowId>)");
    check(voidBody.includes("loadGlDocumentQbLink(") && voidBody.includes("buildTxnVoidQbxml("),
      "resubmit-by-step.ts: el case VOID lee TxnID/tipo del DOCUMENTO y construye TxnVoidRq");
    check(voidBody.includes("deferPipelineRow("), "resubmit-by-step.ts: el case VOID difiere hasta que el ADD confirme");
  }

  const poll = read("lib/quickbooks/consolidator/poll-submitted-rows.ts");
  const branch = poll.indexOf(`row.step === "${ADD}" || row.step === "${VOID}"`);
  check(branch > 0, "poll-submitted-rows.ts: rama de confirmación para los dos steps");
  if (branch > 0) {
    const body = poll.slice(branch, poll.indexOf("gl-purchases-v2 §4: VendorCreditAdd", branch));
    check(body.includes("glQbResponseTag(") && body.includes("glQbRetTag("), "poll-submitted-rows.ts: elige <Tipo>AddRs/<Tipo>Ret por payload.qb_txn_type");
    check(body.includes("handleGlDocumentAddConfirmed(") && body.includes("handleGlDocumentVoidConfirmed("), "poll-submitted-rows.ts: write-back al documento en add y void");
    check(body.includes("statusCode 0 but no"), "poll-submitted-rows.ts: OK sin TxnID NO se confirma (queda failed para readback)");
    check(body.includes("readDirectQueryStatus(glRsNode)"), "poll-submitted-rows.ts: el status del *Rs se lee bajo `$` (xml2js), no plano");
  }
  // La rama hermana (vendor credits / bill payments) tenía la lectura plana:
  // un rechazo de QB pasaba como éxito. Arreglada en el mismo cambio.
  const vcBranch = poll.indexOf("gl-purchases-v2 §4: VendorCreditAdd");
  check(vcBranch > 0 && poll.slice(vcBranch, vcBranch + 2500).includes("readDirectQueryStatus(rsNode)"),
    "poll-submitted-rows.ts: la rama de vendor credits / bill payments también lee el status bajo `$`");
  const failedBranch = poll.indexOf('} else if (op.status === "failed") {');
  const guard = poll.indexOf("decideAddRetrySafety(errMsg)", failedBranch);
  const genericRetry = poll.indexOf("const decision = await failOrRetryPipelineRow(", failedBranch);
  check(failedBranch > 0 && guard > failedBranch && genericRetry > guard,
    "poll-submitted-rows.ts: un ADD con resultado DESCONOCIDO no se auto-reintenta (guard ANTES del failOrRetry genérico)");

  const gate = read("lib/quickbooks/pipeline/retry-gate.ts");
  const gateList = gate.slice(gate.indexOf("ADD_CAPABLE_STEPS"), gate.indexOf("] as const", gate.indexOf("ADD_CAPABLE_STEPS")));
  check(gateList.includes(`"${ADD}"`), "retry-gate.ts: gl_document_add está en ADD_CAPABLE_STEPS");
  check(!gateList.includes(`"${VOID}"`), "retry-gate.ts: gl_document_void NO está en ADD_CAPABLE_STEPS (TxnVoid no duplica)");

  const scope = read("lib/quickbooks/pipeline/sales-pipeline-scope.ts");
  const purchaseList = scope.slice(scope.indexOf("PURCHASE_PIPELINE_STEPS"), scope.indexOf("] as const", scope.indexOf("PURCHASE_PIPELINE_STEPS")));
  check(purchaseList.includes(`"${ADD}"`) && purchaseList.includes(`"${VOID}"`), "sales-pipeline-scope.ts: los dos steps quedan fuera del Sales Pipeline");

  const feed = read("api/admin/purchase-orders/qb-pipeline/_lib/feed-sql.ts");
  check(feed.includes(`WHERE qop.step IN ('${ADD}', '${VOID}', '${MOD}')`), "feed-sql.ts: la UI del pipeline lista los tres steps");
  for (const table of ["gl_check", "gl_transfer", "gl_journal_entry", "bank_deposit"]) {
    check(feed.includes(`FROM ${table} `), `feed-sql.ts: el feed resuelve el documento en ${table}`);
  }
  check(!/--[^\n]*`[^\n]*\n/.test(feed.slice(feed.indexOf("GL bank documents"), feed.indexOf(`WHERE qop.step IN ('${ADD}'`))),
    "feed-sql.ts: ningún backtick dentro de un comentario SQL del bloque (rompe el template literal)");

  for (const route of ["retry", "mark-fixed"]) {
    const src = read(`api/admin/purchase-orders/qb-pipeline/[id]/${route}/route.ts`);
    check(src.includes(`"${ADD}",`) && src.includes(`"${VOID}",`) && src.includes("resolveGlDocumentTable("),
      `qb-pipeline/[id]/${route}: reconoce __gl_document_* y resuelve la tabla por reference_type`);
  }
}

// ── 2 · Todo camino que POSTEA o ANULA encola (descartando imports) ─────────
{
  const docs: Array<[string, string]> = [
    ["lib/ledger/documents/bank-check.ts", "gl_check"],
    ["lib/ledger/documents/bank-transfer.ts", "gl_transfer"],
    ["lib/ledger/documents/journal-entry.ts", "gl_journal_entry"],
  ];
  for (const [rel, kind] of docs) {
    const code = codeLines(read(rel));
    check(code.includes(`enqueueGlDocumentAdd(clientInTransactionAsKnex(client), "${kind}"`), `${rel}: post encola el ADD en la misma transacción`);
    check(code.includes(`enqueueGlDocumentVoid(clientInTransactionAsKnex(client), "${kind}"`), `${rel}: void encola el VOID en la misma transacción`);
  }
  const receipts = codeLines(read("lib/banking/receipts-core.ts"));
  check(receipts.includes('enqueueGlDocumentAdd(clientInTransactionAsKnex(client), "bank_deposit"'), "receipts-core.ts: postear el asiento del depósito encola DepositAdd");
  check(receipts.includes('enqueueGlDocumentVoid(clientInTransactionAsKnex(client), "bank_deposit"'), "receipts-core.ts: reversar el asiento del depósito encola el TxnVoid");
  // Y ninguna RUTA lo hace por su cuenta (un segundo camino de enqueue es un duplicado).
  for (const rel of [
    "api/admin/accounting/checks/route.ts",
    "api/admin/accounting/checks/[id]/post/route.ts",
    "api/admin/accounting/transfers/route.ts",
    "api/admin/accounting/transfers/[id]/post/route.ts",
    "api/admin/accounting/journal-entries/route.ts",
    "api/admin/accounting/journal-entries/[id]/post/route.ts",
    "api/admin/banking/accounting/deposits/[id]/post/route.ts",
  ]) {
    check(!read(rel).includes("enqueueGlDocument"), `${rel}: la ruta NO encola por su cuenta (lo hace la lib, dentro de la transacción)`);
  }
  const confirm = codeLines(read("lib/quickbooks/gl-documents/confirm.ts"));
  check(confirm.includes("isDocumentVoidedInPos(") && confirm.includes("enqueueGlDocumentVoid("),
    "confirm.ts: al confirmar el ADD, un documento ya anulado en el POS encola su void (carrera void-in-flight)");
}

// ── 3 · El importador reconoce lo que el POS escribió ──────────────────────
{
  const links = read("lib/ledger/qb-import/pos-links.ts");
  const steps = links.slice(links.indexOf("GL_POSTED_PIPELINE_STEPS"), links.indexOf("] as const"));
  check(steps.includes(`"${ADD}"`) && steps.includes(`"${VOID}"`), "pos-links.ts: los dos steps cuentan como 'conocido por el POS'");
  for (const table of ["gl_check", "gl_transfer", "gl_journal_entry", "bank_deposit"]) {
    check(links.includes(`UNION SELECT qb_txn_id FROM ${table}`), `pos-links.ts: la UNION lee ${table}.qb_txn_id`);
  }
}

// ── 4 · Migración expand-only ───────────────────────────────────────────────
{
  const dir = path.join(SRC, "migrations");
  const file = fs.readdirSync(dir).find((f) => f.endsWith("-GlDocumentsQbLink.ts"));
  check(!!file, "migrations: existe *-GlDocumentsQbLink.ts");
  if (file) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    check(/^\d{13}-GlDocumentsQbLink\.ts$/.test(file), "migrations: el sufijo tiene 13 dígitos (TypeORM ordena por substr(-13))");
    for (const col of ["qb_txn_id", "qb_txn_type", "qb_edit_sequence", "qb_synced_at"]) {
      check(src.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `migrations: agrega ${col}`);
    }
    // `IS NOT NULL` en el predicado del índice parcial no es una restricción.
    const up = src.replace(/down\([\s\S]*$/, "").replace(/IS NOT NULL/g, "");
    check(!/DROP TABLE|ALTER COLUMN|NOT NULL|DROP COLUMN/.test(up), "migrations: up() es expand-only");
  }
}

// ── 5 · Comportamiento: ASCII y fail-closed ────────────────────────────────
{
  const ASCII = /^[\x20-\x7E]*$/;
  const checkXml = buildCheckAddQbxml({
    bankAccountListId: "80000006-1",
    payeeListId: null,
    refNumber: null,
    txnDate: "2026-09-14",
    memo: "Uber · viaje — ñandú “comillas” 25°",
    isToBePrinted: false,
    lines: [{ accountListId: "80000015-1", amountCents: 615n, memo: "café" }],
  });
  check(ASCII.test(checkXml), "builders: CheckAdd sale en ASCII 7 bits aunque el memo traiga acentos/símbolos");
  const depXml = buildDepositAddQbxml({
    txnDate: "2026-09-14",
    depositToAccountListId: "80000006-1",
    memo: "Depósito ATM — ×2",
    lines: [{ accountListId: "80000048-1", amountCents: 100n, memo: "señal" }],
  });
  check(ASCII.test(depXml), "builders: DepositAdd sale en ASCII 7 bits");
  let unbalancedRejected = false;
  try {
    buildJournalEntryAddQbxml({
      txnDate: "2026-09-14",
      lines: [
        { side: "debit", accountListId: "a", amountCents: 100n },
        { side: "credit", accountListId: "b", amountCents: 99n },
      ],
    });
  } catch {
    unbalancedRejected = true;
  }
  check(unbalancedRejected, "builders: un JournalEntry desbalanceado no se construye");
}

async function factsFailClosed(): Promise<void> {
  // DB stub: contesta por prefijo del SQL, sin Postgres. Un gl_check posteado
  // cuya línea apunta a una cuenta creada en el POS.
  const stub = {
    raw: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("FROM gl_check WHERE")) {
        return {
          rows: [{
            id: "gchk_stub", doc_number: "CHK-0001", number: null, kind: "expense", day: "2026-09-14",
            bank_account_list_id: "80000006-1", payee_type: "other", payee_id: null, payee_name: "X",
            memo: null, to_be_printed: false, status: "posted", qb_txn_id: null,
          }],
        };
      }
      if (sql.includes("FROM gl_check_line")) {
        return { rows: [{ account_list_id: "pos_01ABC", amount_cents: "100", memo: null, customer_id: null, billable: false }] };
      }
      if (sql.includes("FROM qb_account")) {
        // La cuenta pos_ SÍ vive en el espejo qb_account (gl-reports E2 la
        // inserta con ListID pos_<ulid>): sólo el prefijo la distingue de una
        // cuenta real de QuickBooks.
        return { rows: [{ qb_list_id: "80000006-1", account_type: "Bank" }, { qb_list_id: "pos_01ABC", account_type: "Expense" }] };
      }
      return { rows: [] };
    },
  };
  const facts = await loadGlDocumentAddFacts(stub, "gl_check", "gchk_stub");
  check(!facts.ready && !("skip" in facts && facts.skip) && /account_not_in_quickbooks/.test(facts.reason) && facts.blockingReferenceIds.length === 0,
    "facts: una cuenta pos_ es rechazo ESTRUCTURAL (no se manda, no se difiere)",
    JSON.stringify(facts).slice(0, 200));

  // Control positivo del stub: la misma consulta con una cuenta real construye el QBXML.
  const okStub = {
    raw: async (sql: string): Promise<{ rows: unknown[] }> => {
      const r = await stub.raw(sql);
      if (sql.includes("FROM gl_check_line")) {
        return { rows: [{ account_list_id: "80000015-1", amount_cents: "100", memo: null, customer_id: null, billable: false }] };
      }
      if (sql.includes("FROM qb_account")) {
        return { rows: [{ qb_list_id: "80000006-1", account_type: "Bank" }, { qb_list_id: "80000015-1", account_type: "Expense" }] };
      }
      return r;
    },
  };
  const ready = await loadGlDocumentAddFacts(okStub, "gl_check", "gchk_stub");
  check(ready.ready && ready.qbTxnType === "Check" && ready.qbxml.includes("<CheckAddRq>"),
    "facts (control positivo): el mismo documento con cuentas reales construye un CheckAdd");
}


// ── 6 · Other Names de QB (qb-other-names-picker-20260916) ─────────────────
// Un nombre enlazado (`other_name`) se afirma por NOMBRE en cada capa que lo
// tiene que conocer: si una lo olvida, el POS acepta el enlace y QB nunca ve el
// EntityRef — o el CHECK de la base lo rechaza en producción con todo en verde.
{
  const schemas = read("lib/ledger/documents/manual-schemas.ts");
  check(/entity_type:\s*z\.enum\(\["customer",\s*"vendor",\s*"other_name"\]\)/.test(schemas), "manual-schemas: la línea del asiento acepta other_name");
  check(/payee_type:\s*z\.enum\(\["vendor",\s*"customer",\s*"other",\s*"other_name"\]\)/.test(schemas), "manual-schemas: el cheque acepta other_name");
  check(/entity_type === "other_name" && !line\.entity_id/.test(schemas) && /payee_type === "other_name" && !body\.payee_id/.test(schemas),
    "manual-schemas: other_name sin id se rechaza en el body (no es un enlace)");
  const je = codeLines(read("lib/ledger/documents/journal-entry.ts"));
  const chk = codeLines(read("lib/ledger/documents/bank-check.ts"));
  check(je.includes("loadActiveOtherNames(") && chk.includes("loadActiveOtherNames("),
    "journal-entry/bank-check: el nombre viene de qb_other_name (snapshot), nunca del cliente");
  const feed = read("lib/banking/feed-confirm-document.ts");
  check(feed.includes('"other_name"') && feed.includes("FROM qb_other_name"), "feed-confirm-document: Confirm del feed acepta y valida other_name");
  const facts = codeLines(read("lib/quickbooks/gl-documents/facts.ts"));
  check(facts.includes("FROM qb_other_name") && /other_name_on_ar_ap_line/.test(facts), "facts: resuelve qb_other_name → ListID y rechaza Other Name en A/R–A/P");
  const migration = read("migrations/Migration20260916150000-QbOtherNames.ts");
  check(/'customer','vendor','other_name'/.test(migration) && /'vendor','customer','other','other_name'/.test(migration),
    "migración: los dos CHECK (gl_journal_entry_line.entity_type, gl_check.payee_type) incluyen other_name");
  const otherNamesSync = read("api/admin/qb-catalog/other-names/sync/route.ts");
  check(otherNamesSync.includes("OtherNameQueryRq") && !/OtherNameAdd|OtherNameMod|VendorAdd|CustomerAdd/.test(otherNamesSync),
    "other-names/sync: sólo OtherNameQueryRq — el POS nunca crea nombres en QB");
}

async function factsOtherName(): Promise<void> {
  // Comportamiento, no texto: un asiento con la línea del banco enlazada a un
  // Other Name construye el JournalEntryAdd con EntityRef = ListID de la tabla.
  const stub = {
    raw: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("FROM gl_journal_entry_line")) {
        return { rows: [
          { account_list_id: "80000006-1", debit_cents: "0", credit_cents: "72202", memo: "Account 140109363 ACH", entity_type: "other_name", entity_id: "qbon_x", entity_name: "Amerant Bank" },
          { account_list_id: "80000015-1", debit_cents: "72202", credit_cents: "0", memo: null, entity_type: null, entity_id: null, entity_name: null },
        ] };
      }
      if (sql.includes("FROM gl_journal_entry ")) {
        return { rows: [{ id: "gje_stub", number: "JE-0001", day: "2026-09-15", memo: null, status: "posted", qb_txn_id: null }] };
      }
      if (sql.includes("FROM qb_account")) {
        return { rows: [{ qb_list_id: "80000006-1", account_type: "Bank" }, { qb_list_id: "80000015-1", account_type: "Expense" }] };
      }
      if (sql.includes("FROM qb_other_name")) return { rows: [{ qb_list_id: "800000BB-1359671733" }] };
      return { rows: [] };
    },
  };
  const facts = await loadGlDocumentAddFacts(stub, "gl_journal_entry", "gje_stub");
  check(facts.ready && facts.qbxml.includes("<EntityRef><ListID>800000BB-1359671733</ListID></EntityRef>"),
    "facts: la línea other_name del asiento viaja con EntityRef = ListID de qb_other_name",
    JSON.stringify(facts).slice(0, 200));
}


// ── 7 · Revise en el lugar (check-revise-20260918): step gl_document_mod ────
// Mismas disciplinas que §1: cada registro por NOMBRE, "llama a X" sin imports,
// cortes por etiqueta. Y lo que un Mod tiene de distinto: EditSequence FRESCO
// (query antes del Mod), diferir sin esperar, y un revise que reversa en el
// día ORIGINAL y rechaza el cambio de tipo Bank↔CreditCard.
{
  const types = read("lib/quickbooks/pipeline/types.ts");
  check(types.includes(`| "${MOD}"`), "pipeline/types.ts: PipelineStep incluye gl_document_mod");
  const chain = read("lib/purchase-orders/qb-purchase-dependency-chain.ts");
  check(chain.includes(`| "${MOD}"`), "qb-purchase-dependency-chain.ts: PurchaseQbStep incluye gl_document_mod");
  const coalescible = chain.slice(chain.indexOf("COALESCIBLE_STEPS = new Set"), chain.indexOf("]);", chain.indexOf("COALESCIBLE_STEPS = new Set")));
  check(coalescible.includes(`"${MOD}"`), "qb-purchase-dependency-chain.ts: un segundo revise REESCRIBE el Mod sin enviar (COALESCIBLE_STEPS)");
  const statuses = chain.slice(chain.indexOf("COALESCIBLE_STATUSES = new Set"), chain.indexOf("]);", chain.indexOf("COALESCIBLE_STATUSES = new Set")));
  check(statuses.includes("WRITE.sales.blocked") && statuses.includes("WRITE.sales.dispatchable"),
    "qb-purchase-dependency-chain.ts: una fila `blocked` (Mod detrás de su Add) también es coalescible (vocabulario 09/17)");

  const dispatch = read("lib/quickbooks/consolidator/dispatch-pass.ts");
  check(dispatch.includes(`'${MOD}'`), "dispatch-pass.ts: gl_document_mod está en la whitelist del despachador");

  const resubmit = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
  const modCase = resubmit.indexOf(`case "${MOD}": {`);
  check(modCase > 0, "resubmit-by-step.ts: case gl_document_mod");
  if (modCase > 0) {
    const body = codeLines(resubmit.slice(modCase, resubmit.indexOf(`case "${VOID}": {`, modCase)));
    check(body.includes("buildGlDocumentQueryQbxml(") && body.includes("freshEditSequence"),
      "resubmit-by-step.ts (mod): consulta el documento y usa el EditSequence FRESCO, nunca el guardado");
    check(body.includes("loadGlDocumentModFacts(poolAsRawKnex(), row.reference_type, row.reference_id, freshEditSequence)"),
      "resubmit-by-step.ts (mod): los facts se re-evalúan al despachar con ese EditSequence");
    check(body.includes("readDirectQueryStatus(queryRs)"), "resubmit-by-step.ts (mod): el status del QueryRs se lee bajo `$`");
    check(body.includes("deferPipelineRow(") && body.includes("waiting on the add's qb_txn_id"),
      "resubmit-by-step.ts (mod): sin TxnID se DIFIERE (Add en vuelo), no se falla");
    check(!body.includes("pollUntilQbConfirmed("), "resubmit-by-step.ts (mod): tras el submit RETORNA — la confirmación es del poller (regla dd4ce4f9)");
    check(body.includes("failOrRetryPipelineRow("), "resubmit-by-step.ts (mod): un Mod no enviado se reintenta (no crea nada en QB)");
  }

  const poll = read("lib/quickbooks/consolidator/poll-submitted-rows.ts");
  const modBranch = poll.indexOf(`if (row.step === "${MOD}") {`);
  check(modBranch > 0, "poll-submitted-rows.ts: rama de confirmación de gl_document_mod");
  if (modBranch > 0) {
    const body = codeLines(poll.slice(modBranch, poll.indexOf("gl-purchases-v2 §4: VendorCreditAdd", modBranch)));
    check(body.includes("glQbModResponseTag(") && body.includes("readDirectQueryStatus(modRsNode)"),
      "poll-submitted-rows.ts (mod): elige <Tipo>ModRs por payload.qb_txn_type y lee el status bajo `$`");
    check(body.includes("handleGlDocumentModConfirmed("), "poll-submitted-rows.ts (mod): write-back del EditSequence nuevo al documento");
  }
  const confirm = codeLines(read("lib/quickbooks/gl-documents/confirm.ts"));
  const modHandler = confirm.slice(confirm.indexOf("export async function handleGlDocumentModConfirmed"));
  check(modHandler.includes("qb_edit_sequence = COALESCE(") && modHandler.includes("isDocumentVoidedInPos("),
    "confirm.ts: el Mod confirmado guarda el EditSequence nuevo y encola el void si el doc se anuló en vuelo");

  const gate = read("lib/quickbooks/pipeline/retry-gate.ts");
  const gateList = gate.slice(gate.indexOf("ADD_CAPABLE_STEPS"), gate.indexOf("] as const", gate.indexOf("ADD_CAPABLE_STEPS")));
  check(!gateList.includes(`"${MOD}"`), "retry-gate.ts: gl_document_mod NO está en ADD_CAPABLE_STEPS (un Mod no mintea)");

  const scope = read("lib/quickbooks/pipeline/sales-pipeline-scope.ts");
  for (const list of ["PURCHASE_PIPELINE_STEPS", "LEDGER_PIPELINE_STEPS"]) {
    const slice = scope.slice(scope.indexOf(list), scope.indexOf("] as const", scope.indexOf(list)));
    check(slice.includes(`"${MOD}"`), `sales-pipeline-scope.ts: ${list} incluye gl_document_mod`);
  }
  const feed = read("api/admin/purchase-orders/qb-pipeline/_lib/feed-sql.ts");
  check(feed.includes(`WHEN qop.step = '${MOD}' THEN 'mod_gl_document'`) && feed.includes('"mod_gl_document",'),
    "feed-sql.ts: el Mod se etiqueta mod_gl_document en la pestaña Ledger");
  for (const route of ["retry", "mark-fixed"]) {
    check(read(`api/admin/purchase-orders/qb-pipeline/[id]/${route}/route.ts`).includes(`"${MOD}",`),
      `qb-pipeline/[id]/${route}: reconoce __gl_document_mod`);
  }
  const links = read("lib/ledger/qb-import/pos-links.ts");
  check(links.slice(links.indexOf("GL_POSTED_PIPELINE_STEPS"), links.indexOf("] as const")).includes(`"${MOD}"`),
    "pos-links.ts: gl_document_mod cuenta como 'conocido por el POS'");

  // El revise mismo.
  const revise = codeLines(read("lib/ledger/documents/bank-check-revise.ts"));
  check(revise.includes('enqueueGlDocumentMod(clientInTransactionAsKnex(client), "gl_check"'),
    "bank-check-revise.ts: encola el Mod en la MISMA transacción del re-post");
  check(/reverseDocumentJournal\(client,\s*\{[^}]*day:\s*header\.day/.test(revise),
    "bank-check-revise.ts: la reversa se fecha en el DÍA ORIGINAL (el mes queda neto; un extracto cerrado la rechaza)");
  check(revise.includes('invalid("revise_type_change"') && revise.includes('invalid("statement_closed"') && revise.includes('invalid("entry_matched"'),
    "bank-check-revise.ts: rechazos con nombre — tipo Bank↔CreditCard, extracto cerrado, match vivo no trasladable");
  check(revise.includes("postCheckJournal(") && revise.includes("writeHeaderAndLines("),
    "bank-check-revise.ts: reescribe header+líneas y re-postea con el MISMO builder del post inicial");
  const route = read("api/admin/accounting/checks/[id]/revise/route.ts");
  check(codeLines(route).includes("reviseBankCheck(") && codeLines(route).includes("assertAccounting(") && route.includes("REASON_SCHEMA"),
    "checks/[id]/revise: llama a la lib con motivo obligatorio, bajo assertAccounting");
  check(!route.includes("enqueueGlDocument"), "checks/[id]/revise: la ruta NO encola por su cuenta");
  const dir = path.join(SRC, "migrations");
  const file = fs.readdirSync(dir).find((f) => f.endsWith("-GlCheckRevision.ts"));
  check(!!file && /^Migration\d{13}1-GlCheckRevision\.ts$/.test(file), "migrations: existe Migration…1-GlCheckRevision.ts (sufijo distintivo, nunca 000000)");
  if (file) {
    const up = fs.readFileSync(path.join(dir, file), "utf8").replace(/down\([\s\S]*$/, "");
    check(/ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0/.test(up) && !/DROP COLUMN|ALTER COLUMN/.test(up),
      "migrations: GlCheckRevision es expand-only (revision default 0, resto nullable)");
  }
}

async function modFactsFailClosed(): Promise<void> {
  // Comportamiento: un cheque que QuickBooks tiene como Check y que ahora paga
  // con tarjeta NO construye un Mod (revise_type_change), y con la forma intacta
  // construye un CheckMod con el EditSequence dado.
  const rows = {
    check: { id: "gchk_stub", doc_number: "CHK-0941", number: null, kind: "expense", day: "2026-09-01",
      bank_account_list_id: "80000006-1", payee_type: "other", payee_id: null, payee_name: "University Of Mi",
      memo: null, to_be_printed: false, status: "posted", qb_txn_id: "1C8E6D-1", qb_txn_type: "Check", qb_edit_sequence: "5", revision: 1 },
    bankType: "Bank",
  };
  const stub = {
    raw: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("FROM gl_check WHERE")) return { rows: [rows.check] };
      if (sql.includes("FROM gl_check_line")) return { rows: [{ account_list_id: "80000015-1", amount_cents: "6000", memo: "MED*UNIVERSITY", customer_id: null, billable: false }] };
      if (sql.includes("FROM qb_account")) return { rows: [{ qb_list_id: "80000006-1", account_type: rows.bankType }, { qb_list_id: "80000015-1", account_type: "Expense" }] };
      return { rows: [] };
    },
  };
  const ready = await loadGlDocumentModFacts(stub, "gl_check", "gchk_stub", "7");
  check(ready.ready && ready.qbxml.includes("<CheckModRq>") && ready.qbxml.includes("<EditSequence>7</EditSequence>") && ready.qbxml.includes("<Memo>Payee: University Of Mi</Memo>"),
    "facts-mod: forma intacta → CheckMod con el EditSequence recibido y el payee libre en el memo", JSON.stringify(ready).slice(0, 200));
  rows.bankType = "CreditCard";
  const changed = await loadGlDocumentModFacts(stub, "gl_check", "gchk_stub", "7");
  check(!changed.ready && /revise_type_change/.test(changed.reason),
    "facts-mod: QB tiene un Check y el documento ahora es tarjeta → rechazo estructural revise_type_change", JSON.stringify(changed).slice(0, 200));
  check(!ready.qbxml?.includes("ClearExpenseLines") && ready.ready && (ready.qbxml.match(/<TxnLineID>-1<\/TxnLineID>/g) ?? []).length === 1,
    "facts-mod: el Mod NO manda ClearExpenseLines (QB 3151 en CHK-0999) y re-lista las líneas con TxnLineID -1");
  const noSeq = await loadGlDocumentModFacts(stub, "gl_check", "gchk_stub", "");
  check(!noSeq.ready && /EditSequence/.test(noSeq.reason), "facts-mod: sin EditSequence no hay Mod");
  const transfer = await loadGlDocumentModFacts(stub, "gl_transfer", "gtr_x", "7");
  check(!transfer.ready && /void \+ new document/.test(transfer.reason), "facts-mod: un transfer no se corrige en el lugar (void + nuevo)");
}

factsFailClosed()
  .then(factsOtherName)
  .then(modFactsFailClosed)
  .then(() => {
    for (const n of notes) console.log(n);
    if (failures.length) {
      console.error(`\n❌ ${failures.length} invariante(s) rotos:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n✅ gl-documents → QuickBooks: ${notes.length} invariantes verificados`);
  })
  .catch((error) => {
    console.error("verify-gl-documents-qb crashed:", error);
    process.exit(2);
  });
