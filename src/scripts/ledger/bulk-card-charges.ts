/**
 * bulk-card-charges — carga como Card Charges / Expenses del POS (`gl_check`) todas las SALIDAS del
 * feed de UNA cuenta (tarjeta `credit` → kind `card_charge`; banco `depository` → kind `expense`,
 * o `check` si se pasa `--number`) que el libro no tiene, clasificándolas por COMERCIO con un archivo
 * de reglas (regex sobre merchant_name/name → cuenta). Cada documento postea su asiento y viaja a QB
 * por el pipeline (`842eb0c8`): CreditCardChargeAdd para la tarjeta, CheckAdd para el banco.
 *
 * Caso que lo motivó (Amex Plum 5009, 2026-09-14): 226 cargos de 2026 en 71 comercios, 5 en QB; el
 * contador mapeó 11 grupos y el operador no quiere cargarlos a mano. Generalizado a cuentas Bank el
 * 2026-09-15 (plan sep-feed-reconcile): los recurrentes del banco (fees de la procesadora, préstamos,
 * AT&T) van a nacer en el POS, no en QB.
 *
 *   … ./node_modules/.bin/tsx src/scripts/ledger/bulk-card-charges.ts --mask 5009 --from 2026-01-01 --to 2026-08-31 \
 *       --rules amex-rules.json [--number Debit] [--apply]
 *
 * DRY-RUN por default: resume por cuenta, lista lo que ya está en el libro (se saltea: mismo monto a
 * ±3 días, o ya casado en un extracto) y lo que NINGUNA regla cubre (se aborta si hay). Los CRÉDITOS
 * del feed (devoluciones, pagos) no entran: se listan aparte para que se resuelvan por JE/deposito.
 * Idempotente: un cargo ya cargado por este script se reconoce por `memo` = "feed:<bank_transaction.id>"
 * y no se repite.
 */
import { readFileSync } from "node:fs";
import { getDbPool } from "../../api/utils/db-pool";
import { createBankCheck, postBankCheck } from "../../lib/ledger";

type Rules = { _accounts: Record<string, string>; rules: Array<[string, string]> };
function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const money = (c: number): string => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const mask = arg("--mask"), from = arg("--from"), to = arg("--to"), rulesPath = arg("--rules");
  const actorEmail = arg("--actor") ?? "a.vargas@ecopowertech.com", apply = process.argv.includes("--apply");
  const number = arg("--number");
  if (!mask || !from || !to || !rulesPath) throw new Error("usage: --mask <4> --from YYYY-MM-DD --to YYYY-MM-DD --rules file.json [--apply]");
  const rules = JSON.parse(readFileSync(rulesPath, "utf8")) as Rules;
  const compiled = rules.rules.map(([key, re]) => ({ key, account: rules._accounts[key]!, re: new RegExp(re, "i") }));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [actorEmail])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${actorEmail}`);
  const card = (await pool.query<{ id: string; qb_list_id: string; name: string; account_type: string; type: string }>(
    `SELECT a.id,a.qb_list_id,q.name,q.account_type,a.type FROM bank_account a JOIN qb_account q ON q.qb_list_id=a.qb_list_id
      WHERE a.mask=$1 AND a.type IN ('credit','depository') AND a.is_selected AND a.deleted_at IS NULL`, [mask])).rows[0];
  // tarjeta ↔ CreditCard, banco ↔ Bank: es el mismo par que decide `kind` en `deriveBankCheckKind` y el
  // request de QB (CreditCardChargeAdd vs CheckAdd); una cuenta cruzada no llega al libro.
  if (!card || (card.type === "credit" ? card.account_type !== "CreditCard" : card.account_type !== "Bank"))
    throw new Error(`*${mask}: cuenta no mapeada (${card?.type ?? "?"} → ${card?.account_type ?? "?"}); se espera credit→CreditCard o depository→Bank`);
  const isCard = card.type === "credit";
  const names = new Map((await pool.query<{ qb_list_id: string; full_name: string }>(`SELECT qb_list_id,full_name FROM qb_account WHERE qb_list_id = ANY($1::text[])`, [Object.values(rules._accounts)])).rows.map((r) => [r.qb_list_id, r.full_name]));
  for (const [k, id] of Object.entries(rules._accounts)) if (!names.has(id)) throw new Error(`cuenta ${k}=${id} no existe`);
  const charges = (await pool.query<{ id: string; day: string; cents: string; name: string; merchant: string | null }>(
    `SELECT id,transaction_date::text AS day,round(amount::numeric*100)::text AS cents,name,merchant_name AS merchant FROM bank_transaction
      WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND amount::numeric>0 AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date,id`, [card.id, from, to])).rows;
  // Ya en el libro: mismo monto (crédito a la tarjeta) a ±3 días, o cargado antes por este script (memo feed:<id>).
  const book = (await pool.query<{ id: string; day: string; cents: string; memo: string | null }>(
    `SELECT l.id,e.day::text AS day,l.credit_cents::text AS cents,(SELECT memo FROM gl_check c WHERE c.id=e.source_id AND e.source_kind='bank_check') AS memo
       FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
      WHERE l.account_list_id=$1 AND e.kind='document' AND e.deleted_at IS NULL AND l.credit_cents>0 AND e.source_kind<>'opening_balance'
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AND e.day BETWEEN $2 AND $3`, [card.qb_list_id, from, to])).rows;
  // Ya CONCILIADO: una línea del feed casada en un extracto (draft o cerrado) ya tiene su asiento —
  // aunque sea uno agrupado por día que el criterio "mismo monto" no ve (Visa 7914: QB cargó el viaje
  // a China como un doc por día con N líneas; 2026-09-15). Correr reconcile-feed-statement ANTES.
  const reconciled = new Set(
    (await pool.query<{ id: string }>(
      `SELECT DISTINCT sl.transaction_id AS id FROM bank_statement_line sl JOIN bank_statement_match m ON m.statement_line_id=sl.id AND m.deleted_at IS NULL
        JOIN bank_statement s ON s.id=sl.statement_id AND s.deleted_at IS NULL WHERE s.bank_account_id=$1 AND sl.deleted_at IS NULL AND sl.transaction_id IS NOT NULL`, [card.id])).rows.map((r) => r.id)
  );
  const usedBook = new Set<string>();
  const dayDiff = (a: string, b: string): number => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
  const todo: Array<{ c: (typeof charges)[number]; account: string; key: string }> = [], skipped: typeof charges = [], unmatched: typeof charges = [];
  for (const c of charges) {
    if (reconciled.has(c.id)) { skipped.push(c); continue; }
    const byMemo = book.find((b) => b.memo === `feed:${c.id}`);
    const hit = byMemo ?? book.find((b) => !usedBook.has(b.id) && b.cents === c.cents && dayDiff(b.day, c.day) <= 3);
    if (hit) { usedBook.add(hit.id); skipped.push(c); continue; }
    const text = `${c.merchant ?? ""} | ${c.name}`;
    const rule = compiled.find((r) => r.re.test(c.merchant ?? "") || r.re.test(c.name));
    if (!rule) { unmatched.push(c); continue; }
    todo.push({ c, account: rule.account, key: rule.key });
    void text;
  }
  const byAccount = new Map<string, { n: number; cents: number }>();
  for (const t of todo) { const s = byAccount.get(t.account) ?? { n: 0, cents: 0 }; s.n += 1; s.cents += Number(t.c.cents); byAccount.set(t.account, s); }
  const credits = (await pool.query<{ n: string; cents: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(round(amount::numeric*100)),0)::text AS cents FROM bank_transaction
      WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND amount::numeric<0 AND transaction_date BETWEEN $2 AND $3`, [card.id, from, to])).rows[0]!;
  console.log(`${card.name} *${mask} (${isCard ? "tarjeta → card_charge" : number ? "banco → check" : "banco → expense"}) · ${from}..${to} · salidas del feed ${charges.length} · ya en el libro ${skipped.length} · a cargar ${todo.length} · sin regla ${unmatched.length} · créditos del feed (no entran) ${credits.n} ${money(-Number(credits.cents))}`);
  for (const [acct, s] of [...byAccount.entries()].sort((a, b) => b[1].cents - a[1].cents)) console.log(`  ${(names.get(acct) ?? acct).padEnd(58)} ${String(s.n).padStart(4)}  ${money(s.cents).padStart(12)}`);
  if (unmatched.length) {
    console.log("SIN REGLA (agregar al archivo de reglas):");
    for (const c of unmatched) console.log(`  ${c.day} ${money(Number(c.cents)).padStart(10)}  ${c.merchant ?? ""} | ${c.name}`);
    throw new Error(`${unmatched.length} cargos sin regla`);
  }
  if (!apply) { console.log("DRY-RUN: no se escribió nada. Usá --apply."); return; }
  const client = await pool.connect();
  let posted = 0, failed = 0;
  try {
    for (const t of todo) {
      try {
        const check = await createBankCheck(client, {
          day: t.c.day, bank_account_list_id: card.qb_list_id, number: number ?? null, payee_type: "other", payee_name: (t.c.merchant ?? t.c.name).slice(0, 80),
          memo: `feed:${t.c.id}`, to_be_printed: false,
          lines: [{ account_list_id: t.account, amount_cents: BigInt(t.c.cents), memo: t.c.name.slice(0, 200) }],
        }, actor.id);
        const r = await postBankCheck(client, check.id, actor.id);
        posted += 1;
        console.log(`${check.doc_number} ${t.c.day} ${money(Number(t.c.cents)).padStart(10)} ${(t.c.merchant ?? t.c.name).slice(0, 30).padEnd(30)} → ${t.key} · ${r.status} · QB ${(r.qb as { status?: string } | null)?.status ?? "-"}`);
      } catch (e) { failed += 1; console.error(`FALLÓ ${t.c.day} ${t.c.cents} ${t.c.name}: ${e instanceof Error ? e.message : e}`); }
    }
  } finally { client.release(); }
  console.log(`posteados ${posted} · fallaron ${failed}`);
}
main().then(() => process.exit(0)).catch((e: unknown) => { console.error("bulk-card-charges:", e instanceof Error ? e.message : e); process.exit(1); });
