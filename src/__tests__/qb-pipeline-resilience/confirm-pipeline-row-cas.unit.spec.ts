// Unit tests for the CAS (compare-and-set) contract of confirmPipelineRow
// (Workstream B1). Two pollers — the consolidator's Phase A and the standalone
// qb-pipeline-submitted-poller — can race the SAME submitted row. The CAS guard
// (`status <> 'confirmed'`) must let exactly one win so dependent side-effects
// (wake-dependents, metadata writes) never run twice.

const query = jest.fn();
jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

import { confirmPipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("confirmPipelineRow — CAS contract", () => {
  it("returns true when the UPDATE matches a row (this caller won the transition)", async () => {
    query.mockResolvedValue({ rows: [{ id: "row-1" }] });

    const won = await confirmPipelineRow("row-1", "TXN-1", "REF-1", {
      ok: true,
    });

    expect(won).toBe(true);
  });

  it("returns false when the row was already confirmed (concurrent run won)", async () => {
    // status <> 'confirmed' guard matched zero rows → RETURNING is empty.
    query.mockResolvedValue({ rows: [] });

    const won = await confirmPipelineRow("row-1", "TXN-1", "REF-1", null);

    expect(won).toBe(false);
  });

  it("guards the UPDATE on `status <> 'confirmed'` and uses RETURNING", async () => {
    query.mockResolvedValue({ rows: [{ id: "row-1" }] });

    await confirmPipelineRow("row-1", "TXN-1", "REF-1", null);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/status\s*<>\s*'confirmed'/);
    expect(sql).toMatch(/RETURNING id/);
  });

  it("passes a stringified qb_result and preserves null result as null", async () => {
    query.mockResolvedValue({ rows: [{ id: "row-1" }] });

    await confirmPipelineRow("row-1", "TXN-1", "REF-1", { foo: "bar" });
    expect(query.mock.calls[0][1][3]).toBe(JSON.stringify({ foo: "bar" }));

    query.mockClear();
    query.mockResolvedValue({ rows: [{ id: "row-1" }] });
    await confirmPipelineRow("row-1", "TXN-1", "REF-1", null);
    expect(query.mock.calls[0][1][3]).toBeNull();
  });
});
