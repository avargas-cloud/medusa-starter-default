/**
 * computeSplits — the COGS pool must be derived from ATTRIBUTED cash only.
 *
 * Fixture = production day 2026-09-14 as it stood on 09/16/2026 (cents, read from
 * prod on 09/17/2026 before the accountant linked both deposits that day):
 *   18 payments, net cash 3,011,694; of that 2,461,008 had no order behind it
 *   (PAY-5010 ACH 2,353,576 + PAY-5014 Zelle 107,432). Sales with an order:
 *   gross 520,645, tax 30,041, COGS china 163,368 / local 80,751.
 *
 * Bug (v1 formula): the pool used net cash INCLUDING the un-ordered deposits
 * with a ratio derived from ordered sales only → pool 1,398,031 (5.7× the real
 * COGS of 244,119). The accountant then assigned the deposits' full face value
 * to China/Local on top of that → Operating −877,386.
 *
 * Type: pure unit test (no DB).
 */
import { computeSplits } from "../../api/admin/accounting/treasury/_lib/compute-splits";

const DAY_2026_09_14 = {
  gross_revenue_pre_tax_cents: 520_645,
  tax_collected_cents: 30_041,
  cogs_china_cents: 163_368,
  cogs_local_cents: 80_751,
  net_cash_received_cents: 3_011_694,
  active_bucket_codes: [
    "china_cogs",
    "local_cogs",
    "tax_holding",
    "operating",
    "reserve",
  ] as const,
};
const UNAPPLIED_2026_09_14 = 2_461_008;
const PICKS_2026_09_14 = 2_353_576 + 107_432; // face value moved out of Operating

const amount = (r: ReturnType<typeof computeSplits>, code: string): number =>
  r.splits.find((s) => s.code === code)?.amount_cents ?? NaN;

describe("computeSplits — un-ordered cash stays out of the COGS pool", () => {
  it("fixture sanity: without unapplied the v1 formula reproduces the prod screen", () => {
    const r = computeSplits(DAY_2026_09_14);
    expect(amount(r, "china_cogs")).toBe(935_582);
    expect(amount(r, "local_cogs")).toBe(462_449);
    expect(amount(r, "operating")).toBe(1_583_622);
    // …and the picks of 09/16 drive Operating negative — the reported bug.
    expect(amount(r, "operating") - PICKS_2026_09_14).toBe(-877_386);
  });

  it("with unapplied cash declared, the pool equals the day's real COGS", () => {
    const r = computeSplits({
      ...DAY_2026_09_14,
      unapplied_cash_cents: UNAPPLIED_2026_09_14,
    });
    expect(amount(r, "china_cogs")).toBe(163_368);
    expect(amount(r, "local_cogs")).toBe(80_751);
    expect(amount(r, "tax_holding")).toBe(30_041);
    expect(amount(r, "operating")).toBe(2_737_534);
    expect(r.reconciliation.delta_cents).toBe(0);
    expect(r.reconciliation.sum_of_splits_cents).toBe(3_011_694);
  });

  it("Operating keeps the whole un-ordered cash, so the 09/16 picks fit", () => {
    const r = computeSplits({
      ...DAY_2026_09_14,
      unapplied_cash_cents: UNAPPLIED_2026_09_14,
    });
    expect(amount(r, "operating") - PICKS_2026_09_14).toBe(276_526);
    expect(amount(r, "operating")).toBeGreaterThanOrEqual(UNAPPLIED_2026_09_14);
  });

  it("all cash un-ordered → pool 0, everything in Operating (minus tax)", () => {
    const r = computeSplits({
      ...DAY_2026_09_14,
      net_cash_received_cents: 100_000,
      unapplied_cash_cents: 100_000,
    });
    expect(amount(r, "china_cogs")).toBe(0);
    expect(amount(r, "local_cogs")).toBe(0);
    expect(amount(r, "operating")).toBe(100_000 - 30_041);
    expect(r.reconciliation.delta_cents).toBe(0);
  });

  it("unapplied larger than net (refund-heavy day) never yields a negative pool", () => {
    const r = computeSplits({
      ...DAY_2026_09_14,
      net_cash_received_cents: 50_000,
      unapplied_cash_cents: 80_000,
    });
    expect(amount(r, "china_cogs")).toBe(0);
    expect(amount(r, "local_cogs")).toBe(0);
    expect(r.reconciliation.delta_cents).toBe(0);
  });

  it("omitting unapplied_cash_cents behaves exactly like 0 (backward compatible)", () => {
    const a = computeSplits(DAY_2026_09_14);
    const b = computeSplits({ ...DAY_2026_09_14, unapplied_cash_cents: 0 });
    expect(b.splits).toEqual(a.splits);
  });
});
