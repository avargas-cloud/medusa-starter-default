import { postCreditMemo } from "../documents/credit-memo";

/**
 * gl-core-v1 fase 5 — un CM marcado `is_internal_adjustment`/`never_sync_to_qb`
 * es una corrección fuera de libros: no debe llegar nunca a `postDocumentJournal`.
 * El fake client explota si se le pide cualquier query más allá del header, así
 * que este test también prueba que `postCreditMemo` corta temprano.
 */
function fakeClientWithHeader(metadata: Record<string, unknown> | null) {
  const header = {
    id: "cm_1",
    credit_memo_number: "CM-1001",
    status: "completed",
    total: "100.00",
    subtotal: "100.00",
    discount: "0.00",
    shipping: "0.00",
    tax: "0.00",
    completed_at: "2026-05-01T00:00:00.000Z",
    voided_at: null,
    metadata,
  };
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("FROM pos_credit_memo")) return { rows: [header] };
      throw new Error(`unexpected query beyond header load: ${sql}`);
    }),
  };
}

describe("postCreditMemo — internal adjustment skip", () => {
  it("returns skipped/internal_adjustment for is_internal_adjustment=true and never queries further", async () => {
    const client = fakeClientWithHeader({ is_internal_adjustment: "true" });
    const result = await postCreditMemo(client as never, "cm_1", "actor_1");
    expect(result).toEqual({ status: "skipped", reason: "internal_adjustment" });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("returns skipped/internal_adjustment for never_sync_to_qb=true and never queries further", async () => {
    const client = fakeClientWithHeader({ never_sync_to_qb: "true" });
    const result = await postCreditMemo(client as never, "cm_1", "actor_1");
    expect(result).toEqual({ status: "skipped", reason: "internal_adjustment" });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip a normal completed CM (proceeds past the header load)", async () => {
    const client = fakeClientWithHeader({});
    await expect(postCreditMemo(client as never, "cm_1", "actor_1")).rejects.toThrow(
      "unexpected query beyond header load"
    );
    expect((client.query as jest.Mock).mock.calls.length).toBeGreaterThan(1);
  });
});
