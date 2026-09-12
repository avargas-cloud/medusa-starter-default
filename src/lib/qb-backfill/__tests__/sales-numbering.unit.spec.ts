import {
  allocateCreditMemoNumber,
  allocateInvoiceNumber,
  allocateOrderDocumentNumber,
  allocatePaymentDisplayId,
  formatHistoricalCreditMemoNumber,
  formatHistoricalInvoiceNumber,
  formatHistoricalOrderNumber,
  isHistoricalSalesDate,
  txManagerFor,
} from "../sales-numbering";
import type { QueryableDb } from "../resolve";

/** Fake DB: responde por patrón de SQL y registra lo que se ejecutó. */
function fakeDb(answers: Array<[RegExp, Record<string, unknown>[]]>): QueryableDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      const hit = answers.find(([re]) => re.test(sql));
      if (!hit) throw new Error(`fakeDb: sin respuesta para ${sql.slice(0, 80)}`);
      return { rows: hit[1] };
    },
  };
}

describe("qb-backfill/sales-numbering", () => {
  it("isHistoricalSalesDate: estricto antes del go-live", () => {
    expect(isHistoricalSalesDate("2026-04-13")).toBe(true);
    expect(isHistoricalSalesDate("2026-04-14")).toBe(false);
    expect(isHistoricalSalesDate("2025-12-31")).toBe(true);
    expect(isHistoricalSalesDate("2026-01-01", "2026-01-01")).toBe(false);
  });

  it("formatea los rangos históricos con el padding de cada tipo", () => {
    expect(formatHistoricalOrderNumber(1)).toBe("S0001");
    expect(formatHistoricalOrderNumber(999)).toBe("S0999");
    expect(formatHistoricalInvoiceNumber(1)).toBe("00001");
    expect(formatHistoricalInvoiceNumber(42)).toBe("00042");
    expect(formatHistoricalCreditMemoNumber(7)).toBe("CM-0007");
  });

  it("orden histórica: max(S0xxx viva)+1 sin tocar custom_order_seq", async () => {
    const db = fakeDb([[/FROM "order"/, [{ n: "3" }]]]);
    await expect(allocateOrderDocumentNumber(db, "2026-02-01")).resolves.toBe("S0003");
    expect(db.calls.join(" ")).toContain("deleted_at IS NULL");
    expect(db.calls.join(" ")).not.toContain("nextval");
  });

  it("orden corriente: nextval('custom_order_seq')", async () => {
    const db = fakeDb([[/nextval\('custom_order_seq'\)/, [{ n: 11432 }]]]);
    await expect(allocateOrderDocumentNumber(db, "2026-05-01")).resolves.toBe("S11432");
  });

  it("factura histórica: 5 dígitos; corriente: counter row medusa_invoice (gapless, no sequence)", async () => {
    const hist = fakeDb([[/FROM pos_invoice/, [{ n: 1 }]]]);
    await expect(allocateInvoiceNumber(hist, "2026-01-15")).resolves.toBe("00001");

    const live = fakeDb([[/UPDATE document_number_counter/, [{ value: "21723" }]]]);
    await expect(allocateInvoiceNumber(live, "2026-09-01")).resolves.toBe("21723");
    expect(live.calls[0]).toContain("$1");
    expect(live.calls[0]).not.toContain("?");
  });

  it("credit memo histórico: CM-0001; corriente: CM-<custom_credit_memo_seq>", async () => {
    const hist = fakeDb([[/FROM pos_credit_memo/, [{ n: 1 }]]]);
    await expect(allocateCreditMemoNumber(hist, "2026-03-31")).resolves.toBe("CM-0001");
    const live = fakeDb([[/nextval\('custom_credit_memo_seq'\)/, [{ n: 1155 }]]]);
    await expect(allocateCreditMemoNumber(live, "2026-04-14")).resolves.toBe("CM-1155");
  });

  it("rango histórico agotado → error, nunca desborda a 5 dígitos (S10006 es del POS)", async () => {
    const db = fakeDb([[/FROM "order"/, [{ n: 10000 }]]]);
    await expect(allocateOrderDocumentNumber(db, "2026-01-01")).rejects.toThrow(/rango histórico/);
  });

  it("1.210 documentos ene–abr caben: S1000 es histórico válido", async () => {
    const db = fakeDb([[/FROM "order"/, [{ n: 1000 }]]]);
    await expect(allocateOrderDocumentNumber(db, "2026-01-01")).resolves.toBe("S1000");
  });

  it("display_id de pago: siempre custom_payment_seq", async () => {
    const db = fakeDb([[/custom_payment_seq/, [{ n: "3772" }]]]);
    await expect(allocatePaymentDisplayId(db)).resolves.toBe(3772);
  });

  it("txManagerFor convierte cada ? en $n y devuelve las filas", async () => {
    const db = fakeDb([[/\$1.*\$2/s, [{ ok: 1 }]]]);
    const rows = await txManagerFor(db).execute<Array<{ ok: number }>>("SELECT ? AS a, ? AS b", [1, 2]);
    expect(rows[0]!.ok).toBe(1);
    expect(db.calls[0]).toBe("SELECT $1 AS a, $2 AS b");
  });
});
