import { deleteDraftVendorCredit } from "../delete";

function fakeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.trim().split("\n")[0]!.trim(), params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`No fake handler for SQL: ${sql}`);
      return { rows: handler.rows };
    }),
  };
}

describe("deleteDraftVendorCredit", () => {
  it("soft-deletes a draft and its lines in one transaction", async () => {
    const client = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [{ id: "vcr_1", status: "draft" }] },
      { match: "UPDATE vendor_credit_line SET deleted_at", rows: [] },
      { match: "UPDATE vendor_credit SET deleted_at", rows: [] },
    ]);
    await deleteDraftVendorCredit(client as never, "vcr_1");
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => s.includes("UPDATE vendor_credit_line SET deleted_at"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE vendor_credit SET deleted_at"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls.some((s) => s.startsWith("DELETE"))).toBe(false);
  });

  it("refuses a posted credit (void it instead) and a missing one", async () => {
    const posted = fakeClient([
      { match: "SELECT id, status FROM vendor_credit", rows: [{ id: "vcr_1", status: "posted" }] },
    ]);
    await expect(deleteDraftVendorCredit(posted as never, "vcr_1")).rejects.toMatchObject({
      code: "invalid_status",
      status: 409,
    });
    expect(posted.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);

    const missing = fakeClient([{ match: "SELECT id, status FROM vendor_credit", rows: [] }]);
    await expect(deleteDraftVendorCredit(missing as never, "vcr_gone")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
