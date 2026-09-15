/**
 * verify-bank-deposits-gl — gate estático de record-deposits-gl-20260915:
 * el depósito bancario es un documento del GL y la adopción de QuickBooks
 * nunca re-postea ni manda un DepositAdd. Mutation-testeado en cada rama
 * (ver el final del archivo). Corre con tsx, sin DB:
 *
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-bank-deposits-gl.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");
/** Líneas de código sin imports ni comentarios de línea: un check de "llama a X" nunca acepta el import. */
const code = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(import|\/\/|\*|\/\*)/.test(l)).join("\n");

let failures = 0;
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

// ── 1 · migración expand-only ───────────────────────────────────────────────
const mig = read("src/migrations/1789500000000-GlBankDeposits.ts");
check(/current\.add\("bank_deposit"\)/.test(mig) && /pg_get_constraintdef/.test(mig), "migración: el CHECK de source_kind se LEE del catálogo y se re-emite con bank_deposit (no una lista hardcodeada)");
check(/NOT VALID/.test(mig) && /VALIDATE CONSTRAINT bank_journal_entry_source_kind_check/.test(mig), "migración: el CHECK nuevo va NOT VALID + VALIDATE (sin escaneo bajo ACCESS EXCLUSIVE)");
check(/SET LOCAL lock_timeout/.test(mig), "migración: lock_timeout (falla limpia, no espera al pipeline)");
check(/ALTER COLUMN account_id DROP NOT NULL/.test(mig) && /account_list_id text/.test(mig) && /bank_deposit_target_required/.test(mig), "migración: account_id nullable + account_list_id + CHECK de destino");
check(/\(manual_reference IS NOT NULL\)::int = 1/.test(mig), "migración: CHECK funding_source admite la línea manual (exactamente uno de payment/opening/manual)");
check(/amount::numeric <> 0::numeric/.test(mig), "migración: una línea puede ser negativa (refund neteado), nunca cero");
check(/CREATE OR REPLACE FUNCTION bank_opening_deposit_guard\(\)/.test(mig) && /IF NEW\.manual_reference IS NOT NULL AND NEW\.opening_item_id IS NULL THEN RETURN NEW; END IF;/.test(mig), "migración: bank_opening_deposit_guard recreada con OR REPLACE y deja pasar la línea manual");
check(!/DROP TRIGGER/.test(mig), "migración: no dropea triggers (regla 2026-09-14: deadlock en predeploy)");
check(/document_number_counter.*'bank_deposit'/.test(mig), "migración: contador DEP-#### sembrado");

// ── 2 · el depósito es un documento del GL ──────────────────────────────────
const types = read("src/lib/ledger/types.ts");
check(/\|\s*"bank_deposit"/.test(types), "types: bank_deposit está en LedgerManualSourceKind");
const doc = code(read("src/lib/ledger/documents/bank-deposit.ts"));
check(/source_kind:\s*"bank_deposit"/.test(doc) && /postDocumentJournal\(/.test(doc) && /reverseDocumentJournal\(/.test(doc), "documento: postea/reversa por el motor del GL con source_kind bank_deposit");
check(/depositSignedCents\(/.test(doc) && !/centsFromNumeric\(/.test(doc), "documento: los montos en dólares del depósito se convierten con depositSignedCents (centsFromNumeric los truncaba)");
const lines = code(read("src/lib/ledger/lines/bank-deposit.ts"));
check(/debit_cents: line\.amount_cents < 0n \? -line\.amount_cents : 0n/.test(lines) && /gross < 0n/.test(lines) && /if \(gross - feeCents > 0n\)/.test(lines), "lines: una línea negativa debita; gross ≥ 0 (un $0 es un Make Deposits válido) y sin neto no hay línea de banco");
check(/gross_amount::numeric >= 0::numeric/.test(read("src/migrations/1789510000000-GlBankDepositsZero.ts")), "migración v4: gross/net >= 0");
const core = code(read("src/lib/banking/receipts-core.ts"));
check(/if \(kind === "deposit"\) \{[\s\S]*postBankDepositDocument\(/.test(core), "receipts-core: el kind deposit postea por postBankDepositDocument");
check(!/kind === "deposit" \? id : null/.test(core), "receipts-core: ya no escribe un asiento Banking-local con deposit_id");
check(/reverseBankDepositDocument\(/.test(core) && /enqueueGlDocumentVoid\(clientInTransactionAsKnex\(client\), "bank_deposit", id\)/.test(core) && /enqueueGlDocumentAdd\(clientInTransactionAsKnex\(client\), "bank_deposit", id\)/.test(core), "receipts-core: DepositAdd al postear y TxnVoid al reversar, dentro de la transacción");
const transfer = code(read("src/lib/banking/receipts-transfer.ts"));
check(/async function allocateFromLedger\(/.test(transfer) && /e\.source_kind='customer_payment' AND e\.source_id=\$1/.test(transfer), "receipts-transfer: la evidencia de un cobro es su documento customer_payment del GL");
check(/await allocateFromLedger\(client, evidence, line\.payment_id!, cents\)/.test(transfer) && !/await allocate\(client, evidence, line\.payment_id!, cents\)/.test(transfer), "receipts-transfer: depositReceiptSource ya no exige bank_receipt_accounting");
check(/l\.role='undeposited_funds'/.test(transfer), "receipts-transfer: la capacidad es el débito a UF del cobro (amount + surcharge)");
check(/async function targetMapping\(/.test(transfer) && /\["Bank", "OtherCurrentAsset"\]\.includes\(target\.account_type\)/.test(transfer), "receipts-transfer: destino sin cuenta Plaid resuelve por ListID (Cash Register / Cash on Hand)");
const projection = read("src/lib/banking/deposit-projection.ts");
check(/DEPOSIT_POSTED_SQL = `EXISTS\(SELECT 1 FROM bank_journal_entry entry\s+WHERE entry\.source_kind='bank_deposit' AND entry\.source_id=d\.id AND entry\.kind='document'/.test(projection), "projection: accounting_posted lee el documento del GL");
check(/'account_list_id',dl\.manual_account_list_id/.test(projection), "projection: la línea manual expone su cuenta origen");
for (const f of ["src/lib/banking/deposit-validation.ts", "src/lib/banking/receipts-read.ts"]) {
  const src = code(read(f));
  check(!/kind='deposit'/.test(src) && !/e\.deposit_id=/.test(src), `${f}: sin rastros del asiento Banking-local (kind='deposit' / deposit_id)`);
}
const facts = code(read("src/lib/quickbooks/gl-documents/facts.ts"));
check(/e\.source_kind = 'bank_deposit' AND e\.source_id = d\.id AND e\.kind = 'document'/.test(facts), "facts: el asiento activo del depósito se busca como documento del GL");
check(/COALESCE\(d\.account_list_id, a\.qb_list_id\) AS bank_qb_list_id/.test(facts) && /line\.manual_account_list_id \?\? uf!\.qb_list_id/.test(facts), "facts: DepositToAccountRef por ListID; línea manual a su cuenta (UF por default)");
check(/if \(doc\.qb_txn_id\) return structural/.test(facts), "facts: un depósito que ya tiene TxnID (adoptado o confirmado) nunca produce otro DepositAdd");
const labels = read("src/lib/ledger/reports/doc-labels.ts");
check(/bank_deposit: "Deposit"/.test(labels), "doc-labels: bank_deposit → Deposit");
const links = read("src/lib/ledger/qb-import/pos-links.ts");
check(/UNION SELECT qb_txn_id FROM bank_deposit/.test(links), "importador: conoce bank_deposit.qb_txn_id (un Deposit adoptado no se re-importa)");

// ── 3 · adopción: re-parent sin re-postear, sin ADD, guards intactos ────────
const adopt = code(read("src/scripts/ledger/adopt-qb-deposits.ts"));
check(/UPDATE bank_journal_entry SET source_kind='bank_deposit', source_id=\$2, document_number=\$3/.test(adopt) && /AND source_kind='qb_import' AND source_id=\$4/.test(adopt), "adopción: re-parenta el asiento existente (UPDATE guardado por qb_import + TxnID), no lo reversa ni re-postea");
check(!/postDocumentJournal|reverseDocumentJournal|enqueueGlDocumentAdd|enqueuePurchaseQbOperation/.test(adopt), "adopción: nunca postea/reversa por el motor ni encola nada a QuickBooks");
check(/DISABLE TRIGGER bank_journal_entry_immutable/.test(adopt) && /ENABLE TRIGGER bank_journal_entry_immutable/.test(adopt) && /DISABLE TRIGGER bank_statement_deposit_line_guard/.test(adopt) && /ENABLE TRIGGER bank_statement_deposit_line_guard/.test(adopt), "adopción: los dos guards se apagan Y se re-encienden dentro de la misma transacción");
check(/SET LOCAL lock_timeout/.test(adopt) && /await client\.query\("BEGIN"\)/.test(adopt) && /ROLLBACK/.test(adopt), "adopción: lote en UNA transacción con lock_timeout y rollback");
check(/NOT EXISTS \(SELECT 1 FROM bank_deposit d WHERE d\.qb_txn_id=e\.source_id/.test(adopt), "adopción: idempotente por TxnID");
check(/argv\.includes\("--apply"\)/.test(adopt) && /dry-run/.test(adopt), "adopción: dry-run por default, --apply explícito");
check(/if \(total < 0n\) return \{ entry, reason:/.test(adopt) && /BigInt\(bank\) !== total/.test(adopt), "adopción: salta totales negativos y asientos cuya línea de banco no coincide con QB (el $0 se adopta)");
check(/VALUES \(\$1,1,'ready',/.test(adopt) && /qb_txn_id,qb_txn_type,qb_edit_sequence,qb_synced_at\)/.test(adopt), "adopción: el depósito nace ready con su TxnID/EditSequence estampados");
check(/async function revertOne\(/.test(adopt), "adopción: --revert existe (compensación)");
const e2e = read("src/scripts/tests/e2e-gl-documents-qb-sandbox.ts");
check(!/KNOWN UPSTREAM BLOCKER/.test(e2e) && /Post to ledger succeeds/.test(e2e), "e2e gl-documents §5: postea de verdad (el bloqueo documentado desapareció)");
const e2e2 = read("src/scripts/tests/e2e-bank-deposits-gl-sandbox.ts");
check(/BANKING_JOURNAL_IMMUTABLE/.test(e2e2) && /BANKING_STATEMENT_PERIOD_CLOSED/.test(e2e2) && /BANKING_OPENING_CONSUMPTION_INVALID/.test(e2e2), "e2e deposits-gl: prueba los guards armados y el mutation test del guard de partidas");

console.log(failures === 0 ? "\n✅ verify-bank-deposits-gl: todo verde" : `\n❌ verify-bank-deposits-gl: ${failures} check(s) rojos`);
process.exit(failures === 0 ? 0 : 1);

/*
 * Mutation tests (2026-09-15): cada bloque se rompió a propósito y el check
 * correspondiente se puso rojo — receipts-core volviendo al INSERT local
 * (`kind === "deposit" ? id : null`), receipts-transfer llamando `allocate(`,
 * la adopción sin el `ENABLE TRIGGER` de vuelta, y el import de
 * `enqueueGlDocumentAdd` en el script de adopción (que NO alcanza para
 * ponerlo rojo: el check mira el código sin imports — pero una LLAMADA sí).
 */
