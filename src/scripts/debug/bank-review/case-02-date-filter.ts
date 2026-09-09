/**
 * Case 02 · Select account + date filter (UI is manual; this verifies the server side the presets resolve to).
 * The POS stages the draft and only calls the API with date_from/date_to on Apply (BankDateFilter).
 * Creates nothing.
 */
import assert from "node:assert/strict";
import { run, block, baseAccount, type Json } from "./_lib";

const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

void run("case-02", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const today = etToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const q = async (params: string) => {
    const page = await api.get(`/admin/banking/transactions?account_id=${base.id}&limit=50&offset=0${params}`);
    return { count: page.count, rows: ((page.transactions as Json[]) ?? []).map(t => `${t.date} ${t.name} ${t.amount}`) };
  };
  const results = {
    today: await q(`&date_from=${today}&date_to=${today}`),
    this_month: await q(`&date_from=${monthStart}&date_to=${today}`),
    custom_09_02: await q("&date_from=2026-09-02&date_to=2026-09-02"),
    custom_09_03: await q("&date_from=2026-09-03&date_to=2026-09-03"),
    all_dates: await q(""),
  };
  const inverted = await api.call(`/admin/banking/transactions?account_id=${base.id}&date_from=2026-09-05&date_to=2026-09-01`, { allow: [400] });
  const malformed = await api.call(`/admin/banking/transactions?account_id=${base.id}&date_from=2026-02-30&date_to=2026-03-01`, { allow: [400] });
  const otherAccount = await api.call("/admin/banking/transactions?account_id=bacct_00000000000000000000000000000000&limit=50&offset=0", { allow: [404] });

  assert.equal(results.today.count, 0, "Today (ET) has no movements");
  assert.equal(results.this_month.count, 2, "This month shows both");
  assert.deepEqual(results.custom_09_02.rows, ["2026-09-02 EPT utilities test -125.5"]);
  assert.deepEqual(results.custom_09_03.rows, ["2026-09-03 EPT deposit test 500"]);
  assert.equal(results.all_dates.count, 2);
  assert.equal(inverted.status, 400); assert.equal(inverted.body.code, "BANKING_INVALID_DATE_RANGE");
  assert.equal(malformed.status, 400);
  assert.equal(otherAccount.status, 404); assert.equal(otherAccount.body.code, "BANKING_ACCOUNT_NOT_FOUND");

  block("Qué hice", { account_id: base.id, et_today: today, month_start: monthStart, writes: "none",
    ui_presets: ["All dates", "Custom", "Today", "Yesterday", "This week", "This month", "This quarter", "This year"],
    ui_rule: "draft staged in BankDateFilter; API only receives date_from/date_to on Apply; Reset returns the draft to All dates" });
  block("Qué esperamos", { ...results,
    inverted_range: { status: inverted.status, code: inverted.body.code }, malformed_date: { status: malformed.status, code: malformed.body.code },
    unknown_account: { status: otherAccount.status, code: otherAccount.body.code } });
  block("Mirá", "http://localhost:3099/accounting/banks → botón 'All dates' (Bank date range)");
});
