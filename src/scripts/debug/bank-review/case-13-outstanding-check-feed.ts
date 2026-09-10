/**
 * Case 13 · Partida pendiente (cheque en tránsito).
 *
 * El cheque 1042 ($1,000, emitido el 08-28) quedó en la apertura de Chase como
 * "outstanding": ya está descontado en libros pero el banco todavía no lo pagó.
 * El día que el banco lo pague, el feed trae un débito EXACTO de $1,000. Este
 * caso deja ese débito en el feed (fixture propia, misma cuenta base) y verifica
 * que el sistema lo ofrece como candidato para *clear* — y sólo a él:
 *
 *   · fixture A: "CHECK 1042" · 1,000.00 · 2026-09-05  → candidato
 *   · fixture B: "CHECK 1043" ·   999.99 · 2026-09-05  → NO candidato (control negativo: el monto tiene que ser exacto)
 *
 * Nada se contabiliza: el ítem sigue outstanding y bank_journal_entry no cambia.
 * Idempotente: los fixtures se insertan con ON CONFLICT DO NOTHING.
 */
import assert from "node:assert/strict";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

const FIXTURES = [
  { id: "btxn_review_case13_chk1042", amount: "1000.0000", name: "CHECK 1042", day: "2026-09-05" },
  { id: "btxn_review_case13_chk1043", amount: "999.9900", name: "CHECK 1043", day: "2026-09-05" },
];

void run("case-13", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const journalBefore = await journalCount(pool);

  // Feed fixtures on the operator's base account (Plaid convention: positive amount = money OUT).
  for (const f of FIXTURES) {
    await pool.query(
      `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,transaction_date,name,source_data,first_seen_at,last_seen_at)
       VALUES($1,$2,$3,$1,$4,'USD','posted',$5,$6,'{"fixture":"case-13"}'::jsonb,now(),now()) ON CONFLICT (id) DO NOTHING`,
      [f.id, base.connection_id, base.id, f.amount, f.day, f.name]);
  }

  // The adopted Chase opening and its outstanding check.
  const openings = ((await api.get("/admin/banking/accounting/openings")).openings as Json[] ?? []).map(c => record(c.opening));
  const adopted = openings.find(o => o?.kind === "bank" && o?.bank_account_id === base.id && o?.status === "adopted");
  assert(adopted, "BANK_OPENING_NOT_ADOPTED — run case-11 first");
  const context = await api.get(`/admin/banking/accounting/openings/${adopted.id}`);
  const item = ((context.items as Json[]) ?? []).find(i => i.external_key === "chk-1042");
  assert(item, "ITEM_CHK_1042_MISSING");

  const candidates = (await api.get(`/admin/banking/accounting/openings/items/${item.id}/candidates`)).transactions as Json[] ?? [];
  const ids = candidates.map(c => c.id);

  // ── Aserciones ─────────────────────────────────────────────────────────────
  assert.equal(item.clear_id ?? null, null, "el cheque sigue OUTSTANDING: nadie lo marcó como cobrado todavía");
  assert.ok(ids.includes(FIXTURES[0]!.id), `el débito exacto de 1,000.00 tiene que ofrecerse como candidato. Vino: ${JSON.stringify(candidates)}`);
  assert.ok(!ids.includes(FIXTURES[1]!.id), "999.99 NO es el cheque: un monto distinto jamás se ofrece (control negativo)");
  assert.equal(candidates.length, 1, `exactamente UN candidato (los 2 movimientos originales no son de 1,000). Vino: ${ids.join(",")}`);
  assert.equal(await journalCount(pool), journalBefore, "mirar candidatos no contabiliza nada");

  block("Qué hice", {
    script: "src/scripts/debug/bank-review/case-13-outstanding-check-feed.ts",
    cuenta: `${base.name ?? "EPT Sandbox checking"} (${base.id})`,
    feed: FIXTURES.map(f => `${f.name} · ${f.amount} · ${f.day}`),
    consulta: `GET /admin/banking/accounting/openings/items/${item.id}/candidates`,
  });
  block("Qué esperamos", {
    item: { reference: item.reference, amount_cents: item.amount_cents, status: item.clear_id ? "cleared" : "outstanding" },
    candidatos: candidates.map(c => ({ id: c.id, name: c.name, day: c.day, amount_cents: c.amount_cents })),
    control_negativo: { "CHECK 1043 (999.99)": ids.includes(FIXTURES[1]!.id) ? "OFRECIDO (mal)" : "no ofrecido (bien)" },
    bank_journal_entry: { antes: journalBefore, despues: await journalCount(pool) },
  });
  block("Mirá", `http://localhost:3099/accounting/banks/openings?opening_id=${adopted.id} → Check 1042 sigue 'Outstanding'; al abrir 'Clear against bank movement' aparece UN solo movimiento: CHECK 1042 · $1,000.00 · 2026-09-05. En el feed (Banks) también se ven CHECK 1042 y CHECK 1043 como movimientos a revisar.`);
});
