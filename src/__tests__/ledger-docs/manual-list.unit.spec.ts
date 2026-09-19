import type { PoolClient } from "pg";

import { listDocuments, type ListSpec } from "../../lib/ledger/documents/manual-list";

// 09/18/2026: /accounting/checks listed `day ASC` with a page of 50 — "This
// month" (62 checks, 54 through the 15th) showed the OLDEST 50 and hid the
// 16th onward behind a load-more nobody saw. Newest first, keyset descending.

const spec: ListSpec = {
  table: "gl_check",
  columns: "d.id, d.day::text AS day",
  accountClause: "d.bank_account_list_id = {{p}}",
  searchColumns: ["d.payee_name"],
};

type Row = { id: string; day: string };

function fakeClient(rows: Row[]) {
  const query = jest.fn(async () => ({ rows }));
  return { client: { query } as unknown as PoolClient, query };
}

function sql(query: jest.Mock): string {
  const [text] = query.mock.calls[0] as [string, unknown[]];
  return text.replace(/\s+/g, " ");
}

describe("listDocuments — newest first", () => {
  it("orders by (day, id) DESC", async () => {
    const { client, query } = fakeClient([]);
    await listDocuments<Row>(client, spec, { from: "2026-09-01", to: "2026-09-30" });
    expect(sql(query)).toContain("ORDER BY d.day DESC, d.id DESC");
    expect(sql(query)).not.toMatch(/ASC/);
  });

  it("the cursor walks BACKWARDS: rows strictly older than the last one shown", async () => {
    const { client, query } = fakeClient([]);
    await listDocuments<Row>(client, spec, { cursor: "2026-09-15,chk_b" });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql(query)).toMatch(/\(d\.day, d\.id\) < \(\$\d+::date, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["2026-09-15", "chk_b"]));
  });

  it("next_cursor is the LAST (oldest) row of the page when one more exists", async () => {
    const { client } = fakeClient([
      { id: "chk_c", day: "2026-09-17" },
      { id: "chk_b", day: "2026-09-15" },
      { id: "chk_a", day: "2026-09-02" },
    ]);
    const page = await listDocuments<Row>(client, spec, { limit: 2 });
    expect(page.items.map((r) => r.id)).toEqual(["chk_c", "chk_b"]);
    expect(page.next_cursor).toBe("2026-09-15,chk_b");
  });

  it("no next_cursor when the page is not full", async () => {
    const { client } = fakeClient([{ id: "chk_c", day: "2026-09-17" }]);
    const page = await listDocuments<Row>(client, spec, { limit: 2 });
    expect(page.next_cursor).toBeNull();
  });
});
