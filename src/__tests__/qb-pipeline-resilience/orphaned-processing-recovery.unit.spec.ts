// Unit test for runOrphanedProcessingRecovery (Workstream B2). Guards that the
// recovery only touches idempotent-step rows orphaned in 'processing' with no
// bridge_op_id, above the 8-minute threshold (> the worst-case MOD snapshot poll
// so a live MOD is never reset), capped at retry_count < 5.

const query = jest.fn();
jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));
jest.mock("../../lib/quickbooks/client/core", () => ({ bridgeFetch: jest.fn() }));
jest.mock("../../lib/quickbooks/client/sales-orders", () => ({
  closeSalesOrderInQb: jest.fn(),
  reopenSalesOrderInQb: jest.fn(),
}));

import { runOrphanedProcessingRecovery } from "../../lib/quickbooks/consolidator/recovery-pass";

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe("runOrphanedProcessingRecovery (B2)", () => {
  it("issues a single guarded UPDATE with the safety predicates", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    await runOrphanedProcessingRecovery(logger);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    const s = String(sql);
    expect(s).toMatch(/status\s*=\s*'processing'/);
    expect(s).toMatch(/bridge_op_id IS NULL/);
    expect(s).toMatch(/INTERVAL '8 minutes'/);
    expect(s).toMatch(/retry_count, 0\) < 5/);
    expect(s).toMatch(/SET[\s\S]*status\s*=\s*'pending'/);
    // idempotent steps only — ADD steps must NOT be in the allow-list
    const steps: string[] = params[0];
    expect(steps).toContain("invoice_update");
    expect(steps).toContain("estimate_deactivate");
    expect(steps).not.toContain("invoice");
    expect(steps).not.toContain("apply_payment");
    expect(steps).not.toContain("sales_receipt");
    expect(steps).not.toContain("estimate");
  });

  it("never throws even if the query fails (logs and returns)", async () => {
    query.mockRejectedValue(new Error("db down"));
    await expect(runOrphanedProcessingRecovery(logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
