import { loadGlDocumentAddFacts, type GlDocumentDb } from "../gl-documents/facts";

/**
 * qb-other-names-picker-20260916 — un Other Name de QuickBooks enlazado en un
 * asiento o un cheque viaja como EntityRef / PayeeEntityRef con el ListID de
 * `qb_other_name`; un enlace roto es estructural (nunca "se manda igual"), y
 * una línea A/R–A/P no acepta un Other Name (QB lo rechaza con 3140).
 *
 * `GlDocumentDb.raw` se stubbea por forma de la consulta: el spec no toca
 * Postgres. Las consultas reales viven en `facts.ts`; si cambian de tabla, el
 * router de abajo falla en vez de contestar vacío.
 */

const AMERANT = { id: "qbon_amerant", qb_list_id: "800000BB-1359671733", name: "Amerant Bank" };
const TD = "8000017B-TD";
const INTEREST = "8000015F-INTEREST";
const AR = "80000002-AR";

type Row = Record<string, unknown>;

function stubDb(opts: {
  journal?: Row;
  journalLines?: Row[];
  check?: Row;
  checkLines?: Row[];
  otherNames?: Array<{ id: string; qb_list_id: string }>;
}): GlDocumentDb {
  const accounts: Row[] = [
    { qb_list_id: TD, account_type: "Bank" },
    { qb_list_id: INTEREST, account_type: "Expense" },
    { qb_list_id: AR, account_type: "AccountsReceivable" },
  ];
  return {
    raw: async (sql: string, bindings?: unknown[]) => {
      if (sql.includes("FROM qb_account")) {
        const ids = (bindings?.[0] as string[]) ?? [];
        return { rows: accounts.filter((a) => ids.includes(a.qb_list_id as string)) };
      }
      if (sql.includes("FROM qb_other_name")) {
        const id = bindings?.[0];
        const hit = (opts.otherNames ?? [AMERANT]).find((o) => o.id === id);
        return { rows: hit ? [{ qb_list_id: hit.qb_list_id }] : [] };
      }
      if (sql.includes("FROM gl_journal_entry_line")) return { rows: opts.journalLines ?? [] };
      if (sql.includes("FROM gl_journal_entry ")) return { rows: opts.journal ? [opts.journal] : [] };
      if (sql.includes("FROM gl_check_line")) return { rows: opts.checkLines ?? [] };
      if (sql.includes("FROM gl_check ")) return { rows: opts.check ? [opts.check] : [] };
      throw new Error(`unexpected query in stub: ${sql.slice(0, 80)}`);
    },
  };
}

const journal = { id: "gje_1", number: "JE-0028", day: "2026-09-15", memo: "Account 140109363 ACH", status: "posted", qb_txn_id: null };
const bankLine = (entity: Partial<Row>): Row => ({
  account_list_id: TD,
  debit_cents: "0",
  credit_cents: "72202",
  memo: "Account 140109363 ACH",
  entity_type: null,
  entity_id: null,
  entity_name: null,
  ...entity,
});
const expenseLine: Row = { account_list_id: INTEREST, debit_cents: "72202", credit_cents: "0", memo: null, entity_type: null, entity_id: null, entity_name: null };

describe("journal entry with an Other Name line", () => {
  it("sends EntityRef with the qb_other_name ListID on that line only", async () => {
    const db = stubDb({
      journal,
      journalLines: [bankLine({ entity_type: "other_name", entity_id: AMERANT.id, entity_name: AMERANT.name }), expenseLine],
    });
    const facts = await loadGlDocumentAddFacts(db, "gl_journal_entry", "gje_1");
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbTxnType).toBe("JournalEntry");
    const credit = facts.qbxml.slice(facts.qbxml.indexOf("<JournalCreditLine>"));
    expect(credit).toContain(`<EntityRef><ListID>${AMERANT.qb_list_id}</ListID></EntityRef>`);
    const debit = facts.qbxml.slice(facts.qbxml.indexOf("<JournalDebitLine>"), facts.qbxml.indexOf("<JournalCreditLine>"));
    expect(debit).not.toContain("<EntityRef>");
  });

  it("free text (entity_type null + entity_name) sends no EntityRef", async () => {
    const db = stubDb({ journal, journalLines: [bankLine({ entity_name: "Amerant bank" }), expenseLine] });
    const facts = await loadGlDocumentAddFacts(db, "gl_journal_entry", "gje_1");
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbxml).not.toContain("<EntityRef>");
  });

  it("a broken link (other_name id without a row) is structural, not sent", async () => {
    const db = stubDb({
      journal,
      journalLines: [bankLine({ entity_type: "other_name", entity_id: "qbon_gone", entity_name: "Gone" }), expenseLine],
      otherNames: [],
    });
    const facts = await loadGlDocumentAddFacts(db, "gl_journal_entry", "gje_1");
    expect(facts.ready).toBe(false);
    if (facts.ready) return;
    expect(facts.reason).toMatch(/other_name_not_in_quickbooks/);
    expect(facts.blockingReferenceIds).toEqual([]);
  });

  it("an Other Name on an A/R line is structural (QB wants a customer/vendor there)", async () => {
    const db = stubDb({
      journal,
      journalLines: [
        { ...bankLine({}), account_list_id: AR, entity_type: "other_name", entity_id: AMERANT.id, entity_name: AMERANT.name },
        expenseLine,
      ],
    });
    const facts = await loadGlDocumentAddFacts(db, "gl_journal_entry", "gje_1");
    expect(facts.ready).toBe(false);
    if (facts.ready) return;
    expect(facts.reason).toMatch(/other_name_on_ar_ap_line/);
  });
});

describe("check paid to an Other Name", () => {
  const check = {
    id: "gchk_1",
    doc_number: "CHK-0990",
    number: null,
    kind: "expense",
    day: "2026-09-15",
    bank_account_list_id: TD,
    payee_type: "other_name",
    payee_id: AMERANT.id,
    payee_name: AMERANT.name,
    memo: "Account 140109363 ACH",
    to_be_printed: false,
    status: "posted",
    qb_txn_id: null,
  };
  const lines = [{ account_list_id: INTEREST, amount_cents: "72202", memo: "Account 140109363 ACH", customer_id: null, billable: false }];

  it("sends PayeeEntityRef with the ListID and leaves the memo as written", async () => {
    const facts = await loadGlDocumentAddFacts(stubDb({ check, checkLines: lines }), "gl_check", "gchk_1");
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbTxnType).toBe("Check");
    expect(facts.qbxml).toContain(`<PayeeEntityRef><ListID>${AMERANT.qb_list_id}</ListID></PayeeEntityRef>`);
    expect(facts.qbxml).not.toContain("Payee: Amerant Bank");
  });

  it("payee_type other (free text) keeps today's behaviour: name in the memo, no PayeeEntityRef", async () => {
    const facts = await loadGlDocumentAddFacts(
      stubDb({ check: { ...check, payee_type: "other", payee_id: null }, checkLines: lines }),
      "gl_check",
      "gchk_1"
    );
    expect(facts.ready).toBe(true);
    if (!facts.ready) return;
    expect(facts.qbxml).not.toContain("<PayeeEntityRef>");
    expect(facts.qbxml).toContain("Payee: Amerant Bank");
  });

  it("other_name without a row is structural", async () => {
    const facts = await loadGlDocumentAddFacts(
      stubDb({ check: { ...check, payee_id: "qbon_gone" }, checkLines: lines, otherNames: [] }),
      "gl_check",
      "gchk_1"
    );
    expect(facts.ready).toBe(false);
    if (facts.ready) return;
    expect(facts.reason).toMatch(/other_name_not_in_quickbooks/);
  });
});
