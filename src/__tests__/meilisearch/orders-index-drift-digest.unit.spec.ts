/**
 * The orders-index drift section of the daily digest.
 *
 * Drift is injected here rather than manufactured against a live index, so the
 * two cases that actually matter are both cheap to assert: a report that names
 * the wrong field and both values, and — the one that silently regresses — a
 * clean index producing NO section and therefore no empty email.
 */
import type { OrderIndexAuditResult } from "../../lib/meilisearch/audit-orders-index";
import { sameIndexedValue } from "../../lib/meilisearch/audit-orders-index";
import {
  MAX_DRIFT_ROWS,
  buildOrderDriftRows,
  renderOrderDriftSection,
  type OrderDriftHistory,
} from "../../jobs/_lib/_order-drift-section";

const ADMIN = "https://admin.example.com/app";

const cleanAudit = (): OrderIndexAuditResult => ({
  ordersInDb: 1524,
  docsInIndex: 1524,
  missing: [],
  orphans: [],
  driftedDocs: 0,
  drifts: [],
  clean: true,
});

const noHistory = new Map<string, OrderDriftHistory>();

describe("orders index drift — clean index", () => {
  it("produces no rows and no HTML, so a clean run cannot send an empty email", () => {
    const audit = cleanAudit();
    const rows = buildOrderDriftRows(audit, noHistory);

    expect(rows).toHaveLength(0);
    // The job adds rows.length to its error total and skips the send at zero.
    // An empty-but-truthy section string is what would break that.
    expect(renderOrderDriftSection(rows, audit, ADMIN)).toBe("");
  });
});

describe("orders index drift — injected drift", () => {
  const audit = (): OrderIndexAuditResult => ({
    ...cleanAudit(),
    driftedDocs: 1,
    clean: false,
    drifts: [
      {
        order_id: "order_01ABC",
        display_id: 2654,
        field: "effective_payment",
        expected: "voided",
        actual: "fully_paid",
      },
    ],
  });

  it("names the order, the field and both sides of the disagreement", () => {
    const a = audit();
    const rows = buildOrderDriftRows(a, noHistory);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: "order_01ABC",
      display_id: 2654,
      field: "effective_payment",
      expected: "voided",
      actual: "fully_paid",
      fixFailed: false,
    });

    const html = renderOrderDriftSection(rows, a, ADMIN);
    expect(html).toContain("#2654");
    expect(html).toContain("effective_payment");
    expect(html).toContain("voided");
    expect(html).toContain("fully_paid");
    expect(html).toContain(ADMIN);
  });

  it("says the reconciler never saw it when there is no drift_log row", () => {
    const rows = buildOrderDriftRows(audit(), noHistory);
    expect(rows[0].reconciler).toMatch(/never seen by the reconciler/i);
    expect(rows[0].first_detected).toBeNull();
  });

  it("flags — and sorts first — drift the reconciler tried and failed to fix", () => {
    const a: OrderIndexAuditResult = {
      ...audit(),
      driftedDocs: 2,
      drifts: [
        {
          order_id: "order_01AAA",
          display_id: 100,
          field: "status",
          expected: "canceled",
          actual: "pending",
        },
        {
          order_id: "order_01ZZZ",
          display_id: 9999,
          field: "total_cents",
          expected: 1234,
          actual: 0,
        },
      ],
    };
    const history = new Map<string, OrderDriftHistory>([
      [
        "order_01ZZZ",
        {
          first_detected: "2026-07-20T10:00:00.000Z",
          last_fix_error: "Meili write rejected: index not found",
        },
      ],
    ]);

    const rows = buildOrderDriftRows(a, history);

    // Higher display_id, but it is the one the sweep could not repair.
    expect(rows[0].display_id).toBe(9999);
    expect(rows[0].fixFailed).toBe(true);
    expect(rows[0].reconciler).toContain("index not found");
    expect(rows[1].display_id).toBe(100);
    expect(rows[1].fixFailed).toBe(false);

    const html = renderOrderDriftSection(rows, a, ADMIN);
    expect(html).toContain("1 row the reconciler tried and failed to fix");
  });

  it("distinguishes a repeat offender from a first sighting", () => {
    const history = new Map<string, OrderDriftHistory>([
      ["order_01ABC", { first_detected: "2026-07-01T00:00:00.000Z", last_fix_error: null }],
    ]);
    const rows = buildOrderDriftRows(audit(), history);
    expect(rows[0].reconciler).toMatch(/drifted again/i);
    expect(rows[0].fixFailed).toBe(false);
  });
});

describe("orders index drift — whole-document problems", () => {
  it("reports an order with no document at all", () => {
    const a: OrderIndexAuditResult = {
      ...cleanAudit(),
      docsInIndex: 1523,
      clean: false,
      missing: [{ order_id: "order_01MISS", display_id: 4242 }],
    };
    const rows = buildOrderDriftRows(a, noHistory);
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toContain("no document");

    const html = renderOrderDriftSection(rows, a, ADMIN);
    expect(html).toContain("#4242");
    expect(html).toContain("1 missing");
  });

  it("reports a document with no order behind it", () => {
    const a: OrderIndexAuditResult = {
      ...cleanAudit(),
      docsInIndex: 1525,
      clean: false,
      orphans: ["order_01GHOST"],
    };
    const rows = buildOrderDriftRows(a, noHistory);
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toContain("orphaned");
    expect(rows[0].display_id).toBeNull();

    const html = renderOrderDriftSection(rows, a, ADMIN);
    expect(html).toContain("order_01GHOST");
    expect(html).toContain("1 orphaned");
  });
});

describe("orders index drift — rendering safety", () => {
  it("states what it truncated instead of dropping it silently", () => {
    const total = MAX_DRIFT_ROWS + 7;
    const a: OrderIndexAuditResult = {
      ...cleanAudit(),
      clean: false,
      driftedDocs: total,
      drifts: Array.from({ length: total }, (_, i) => ({
        order_id: `order_${i}`,
        display_id: 1000 + i,
        field: "status",
        expected: "canceled",
        actual: "pending",
      })),
    };

    const rows = buildOrderDriftRows(a, noHistory);
    expect(rows).toHaveLength(total);

    const html = renderOrderDriftSection(rows, a, ADMIN);
    expect(html).toContain("and 7 more rows not shown");
    expect(html).toContain("#1000");
    // The 41st row onwards is named as dropped, not rendered.
    expect(html).not.toContain("#1040");
  });

  it("escapes values that would otherwise inject markup into the email", () => {
    const a: OrderIndexAuditResult = {
      ...cleanAudit(),
      clean: false,
      driftedDocs: 1,
      drifts: [
        {
          order_id: "order_01XSS",
          display_id: 7,
          field: "customer_name",
          expected: "<script>alert(1)</script>",
          actual: "ok",
        },
      ],
    };
    const html = renderOrderDriftSection(buildOrderDriftRows(a, noHistory), a, ADMIN);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders null and empty-string as distinguishable, not as blank cells", () => {
    const a: OrderIndexAuditResult = {
      ...cleanAudit(),
      clean: false,
      driftedDocs: 1,
      drifts: [
        {
          order_id: "order_01NULL",
          display_id: 8,
          field: "sales_rep_initials",
          expected: "AV",
          actual: null,
        },
      ],
    };
    const rows = buildOrderDriftRows(a, noHistory);
    expect(rows[0].actual).toBe("∅");
  });
});

describe("sameIndexedValue", () => {
  it("does not call a round-trip difference drift", () => {
    // Money and timestamps come back as string/BigNumber from query.graph and as
    // number from Meili. Reporting that as drift is how a report gets ignored.
    expect(sameIndexedValue("1234", 1234)).toBe(true);
    expect(sameIndexedValue(1234.001, 1234)).toBe(true);
    expect(sameIndexedValue("", null)).toBe(true);
    expect(sameIndexedValue(undefined, "")).toBe(true);
  });

  it("still calls a real difference drift", () => {
    expect(sameIndexedValue(1234, 1235)).toBe(false);
    expect(sameIndexedValue("voided", "fully_paid")).toBe(false);
    expect(sameIndexedValue(null, "AV")).toBe(false);
    expect(sameIndexedValue(true, false)).toBe(false);
  });
});
