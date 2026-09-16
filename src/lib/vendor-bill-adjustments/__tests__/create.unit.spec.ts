import {
  createVendorBillAdjustment,
  VendorBillAdjustmentError,
} from "../create";
import { maybeAutoWriteOffRounding } from "../auto";

type Handler = {
  match: string;
  rows: unknown[] | ((params: unknown[]) => unknown[]);
};

function fakeClient(handlers: Handler[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) return { rows: [] };
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler)
        throw new Error(`No fake handler for SQL: ${sql.slice(0, 80)}`);
      return {
        rows:
          typeof handler.rows === "function"
            ? handler.rows(params)
            : handler.rows,
      };
    }),
  };
}

const CONFIG = {
  match: "FROM store LIMIT 1",
  rows: [{ rounding: "ROUND-1", variance: "VAR-1", tolerance: "50" }],
};
const NO_EXISTING = {
  match:
    "FROM vendor_bill_adjustment\n      WHERE vendor_bill_id = $1 AND kind",
  rows: [],
};
const BILL = {
  match: "FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
  rows: [{ id: "vb_1", status: "synced" }],
};
const PERIOD_LOCK = { match: "pg_advisory_xact_lock", rows: [] };
const PERIOD_OPEN = { match: "FROM accounting_period_close", rows: [] };
const INSERT = {
  match: "INSERT INTO vendor_bill_adjustment",
  rows: (params: unknown[]) => [
    {
      id: params[0],
      vendor_bill_id: params[1],
      kind: params[2],
      direction: params[3],
      amount_cents: params[4],
      account_list_id: params[5],
      adjustment_date: params[6],
      source_fingerprint: params[7],
      evidence: {},
      memo: params[9],
      created_by: params[10],
      created_at: "2026-09-16",
      voided_at: null,
      voided_by: null,
      voided_reason: null,
    },
  ],
};

const base = () =>
  fakeClient([CONFIG, NO_EXISTING, BILL, PERIOD_LOCK, PERIOD_OPEN, INSERT]);
const input = (
  residual: number,
  kind: "rounding" | "price_variance" = "rounding"
) => ({
  vendor_bill_id: "vb_1",
  kind,
  residual_cents: residual,
  adjustment_date: "2026-09-12",
  source_fingerprint: "test",
  actor_id: "user_1",
});

describe("createVendorBillAdjustment (ap-rounding-cleanup-20260916)", () => {
  it("14¢ owed → decrease_ap on the rounding account", async () => {
    const { adjustment, created } = await createVendorBillAdjustment(
      base() as never,
      input(14)
    );
    expect(created).toBe(true);
    expect(adjustment).toMatchObject({
      direction: "decrease_ap",
      amount_cents: 14,
      account_list_id: "ROUND-1",
    });
  });

  it("−7¢ (overpaid) → increase_ap, absolute amount", async () => {
    const { adjustment } = await createVendorBillAdjustment(
      base() as never,
      input(-7)
    );
    expect(adjustment).toMatchObject({
      direction: "increase_ap",
      amount_cents: 7,
    });
  });

  it("50¢ passes the tolerance, 51¢ is refused (absolute, never a %)", async () => {
    await expect(
      createVendorBillAdjustment(base() as never, input(50))
    ).resolves.toMatchObject({ created: true });
    await expect(
      createVendorBillAdjustment(base() as never, input(51))
    ).rejects.toMatchObject({ code: "above_tolerance" });
  });

  it("price_variance uses its own account and ignores the tolerance", async () => {
    const { adjustment } = await createVendorBillAdjustment(base() as never, {
      ...input(307, "price_variance"),
      ignore_tolerance: true,
    });
    expect(adjustment).toMatchObject({
      kind: "price_variance",
      amount_cents: 307,
      account_list_id: "VAR-1",
    });
  });

  it("is idempotent by fingerprint: the existing row comes back, nothing is inserted", async () => {
    const client = fakeClient([
      CONFIG,
      {
        match: NO_EXISTING.match,
        rows: [{ id: "vba_existing", amount_cents: 14 }],
      },
      BILL,
      PERIOD_LOCK,
      PERIOD_OPEN,
      INSERT,
    ]);
    const { adjustment, created } = await createVendorBillAdjustment(
      client as never,
      input(14)
    );
    expect(created).toBe(false);
    expect(adjustment.id).toBe("vba_existing");
    expect(client.calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("refuses 2025 dates and a missing account, and never writes in either case", async () => {
    await expect(
      createVendorBillAdjustment(base() as never, {
        ...input(14),
        adjustment_date: "2025-12-31",
      })
    ).rejects.toMatchObject({ code: "period_closed" });
    const noAccount = fakeClient([
      {
        match: "FROM store LIMIT 1",
        rows: [{ rounding: null, variance: null, tolerance: null }],
      },
    ]);
    await expect(
      createVendorBillAdjustment(noAccount as never, input(14))
    ).rejects.toBeInstanceOf(VendorBillAdjustmentError);
    expect(noAccount.calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(
      false
    );
  });
});

describe("maybeAutoWriteOffRounding", () => {
  const balance = (lineTotal: number, paid: number) => [
    {
      match: "FROM vendor_bill vb",
      rows: [
        {
          id: "vb_1",
          status: "synced",
          qb_source: "owned",
          qb_amount_due_cents: null,
          line_count: "1",
          line_total: lineTotal,
        },
      ],
    },
    {
      match: "FROM vendor_bill_payment_allocation a",
      rows: [{ vendor_bill_id: "vb_1", paid }],
    },
    { match: "FROM vendor_credit_application ca", rows: [] },
    {
      match: "FROM vendor_bill_adjustment\n      WHERE vendor_bill_id = ANY",
      rows: [],
    },
  ];

  it("absorbs a 14¢ residual left by the payment", async () => {
    const client = fakeClient([
      ...balance(205_034, 205_020),
      CONFIG,
      NO_EXISTING,
      BILL,
      PERIOD_LOCK,
      PERIOD_OPEN,
      INSERT,
    ]);
    const out = await maybeAutoWriteOffRounding(client as never, {
      vendor_bill_id: "vb_1",
      trigger: "payment",
      trigger_id: "vbp_1",
      actor_id: "u",
      day: "2026-09-16",
    });
    expect(out).toMatchObject({ created: true, residual_cents: 14 });
    expect(
      client.calls.some((c) => c.sql.startsWith("RELEASE SAVEPOINT"))
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: 51¢ is not absorbed — the residual stays visible and the transaction survives", async () => {
    const client = fakeClient([
      ...balance(205_071, 205_020),
      CONFIG,
      NO_EXISTING,
      BILL,
      PERIOD_LOCK,
      PERIOD_OPEN,
      INSERT,
    ]);
    const out = await maybeAutoWriteOffRounding(client as never, {
      vendor_bill_id: "vb_1",
      trigger: "payment",
      trigger_id: "vbp_1",
      actor_id: "u",
    });
    expect(out).toMatchObject({
      created: false,
      reason: "above_tolerance",
      residual_cents: 51,
    });
    expect(client.calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
    expect(
      client.calls.some((c) => c.sql.startsWith("ROLLBACK TO SAVEPOINT"))
    ).toBe(true);
  });

  it("does nothing when the payment closed the bill exactly", async () => {
    const client = fakeClient([...balance(1_000, 1_000), CONFIG]);
    const out = await maybeAutoWriteOffRounding(client as never, {
      vendor_bill_id: "vb_1",
      trigger: "credit",
      trigger_id: "vcap_1",
      actor_id: "u",
    });
    expect(out).toMatchObject({ created: false, reason: "no_residual" });
  });
});
