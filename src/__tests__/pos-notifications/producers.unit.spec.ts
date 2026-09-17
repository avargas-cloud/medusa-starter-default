// Bandeja de notificaciones del POS — helpers puros de los productores.
// La parte con DB (dedupe, privacidad, rep WEB, PO de hoy, fila QB) vive en
// src/scripts/verify/verify-pos-notifications.ts §4 con ROLLBACK.

import { clampLimit, INBOX_LIMIT_DEFAULT, INBOX_LIMIT_MAX } from "../../lib/notifications/inbox";
import { centsToUsd, customerLabel, methodLabel, truncate } from "../../lib/notifications/producers/format";
import { buildPaymentNotification, PAYMENT_EXCLUDED_METHODS, PAYMENT_EXCLUDED_TYPES } from "../../lib/notifications/producers/payments";
import { buildPoDueNotification, businessHour, isPoDueHour, poDueDedupeKey } from "../../lib/notifications/producers/po-due-today";
import { buildQbFailureNotification, errorFingerprint, qbFailureDedupeKey } from "../../lib/notifications/producers/qb-failures";
import { buildWebOrderNotification, hasSalesRep, isPosCreated, WEB_SALES_REP } from "../../lib/notifications/producers/web-order";

describe("format", () => {
  it("centsToUsd coerciona strings de pg y divide por 100", () => {
    expect(centsToUsd("51779")).toBe("$517.79");
    expect(centsToUsd(100)).toBe("$1.00");
    expect(centsToUsd(null)).toBe("$0.00");
    expect(centsToUsd("garbage")).toBe("$0.00");
  });
  it("methodLabel conoce los métodos del POS y degrada los desconocidos", () => {
    expect(methodLabel("credit_card")).toBe("Credit card");
    expect(methodLabel("wire_transfer")).toBe("wire transfer");
    expect(methodLabel(null)).toBe("Payment");
  });
  it("customerLabel prefiere empresa > persona > email", () => {
    expect(customerLabel({ company_name: "ACME", first_name: "A", last_name: "B", email: "x@y" })).toBe("ACME");
    expect(customerLabel({ company_name: " ", first_name: "Ana", last_name: "G", email: "x@y" })).toBe("Ana G");
    expect(customerLabel({ email: "x@y" })).toBe("x@y");
    expect(customerLabel({})).toBe("Customer");
  });
  it("truncate colapsa espacios y corta con elipsis", () => {
    expect(truncate("a   b\n c", 10)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate(null, 5)).toBeNull();
  });
});

describe("inbox limit", () => {
  it("clampLimit: default, tope y basura", () => {
    expect(clampLimit(undefined)).toBe(INBOX_LIMIT_DEFAULT);
    expect(clampLimit("10")).toBe(10);
    expect(clampLimit("999")).toBe(INBOX_LIMIT_MAX);
    expect(clampLimit("0")).toBe(INBOX_LIMIT_DEFAULT);
    expect(clampLimit("x")).toBe(INBOX_LIMIT_DEFAULT);
  });
});

describe("payments", () => {
  const row = {
    id: "cp_1", display_id: 7, amount: "12345", method: "cash", received_at: "2026-09-17T12:00:00Z", created_at: "2026-09-17T12:00:00Z",
    invoice_id: "inv_1", invoice_number: "21999", order_id: "ord_1", order_display_id: 9, document_number: "S9", rep_initials: "AG",
    company_name: "ACME", first_name: null, last_name: null, email: null,
  };
  it("arma título, cuerpo, link y audiencias admins + rep", () => {
    const n = buildPaymentNotification(row);
    expect(n.title).toBe("Payment received — $123.45 (Cash) · 21999");
    expect(n.body).toBe("ACME · Order S9 · PAY-7");
    // Siempre a la página del PAGO: /invoices/:id del POS toma un ORDER id,
    // así que /invoices/<pos_invoice.id> abría una factura vacía (09/17/2026).
    expect(n.action_url).toBe("/payments/cp_1");
    expect(n.dedupe_key).toBe("payment_received:cp_1");
    expect(n.entity_type).toBe("customer_payment");
    expect(n.audiences).toEqual([{ kind: "admins" }, { kind: "rep", initials: "AG" }]);
  });
  it("sin factura sigue yendo al pago; sin rep la audiencia rep queda vacía (sólo admins)", () => {
    const n = buildPaymentNotification({ ...row, invoice_id: null, invoice_number: null, rep_initials: null });
    expect(n.action_url).toBe("/payments/cp_1");
    expect(n.title).not.toContain("·");
    expect(n.audiences[1]).toEqual({ kind: "rep", initials: null });
  });
  it("crédito, credit memo, store credit y refunds no son dinero recibido", () => {
    expect(PAYMENT_EXCLUDED_METHODS).toEqual(["credit", "credit_memo", "store_credit"]);
    expect(PAYMENT_EXCLUDED_TYPES).toEqual(["credit_memo", "refund"]);
  });
});

describe("po due today", () => {
  it("la hora de negocio es ET, no UTC (septiembre = EDT, UTC-4)", () => {
    expect(businessHour(new Date("2026-09-17T11:00:00Z"))).toBe(7);
    expect(businessHour(new Date("2026-09-17T04:00:00Z"))).toBe(0);
    expect(isPoDueHour(new Date("2026-09-17T11:30:00Z"))).toBe(true);
    expect(isPoDueHour(new Date("2026-09-17T12:00:00Z"))).toBe(false);
  });
  it("en enero (EST, UTC-5) las 7 am son 12:00Z", () => {
    expect(isPoDueHour(new Date("2026-01-15T12:00:00Z"))).toBe(true);
    expect(isPoDueHour(new Date("2026-01-15T11:00:00Z"))).toBe(false);
  });
  it("una notificación agrupada por día, con singular/plural y fuente del ETA", () => {
    const one = buildPoDueNotification("2026-09-17", [
      { id: "po1", number: "PO-1", vendor_name_snapshot: "V", status: "submitted", expected_today: true, eta_sources: null },
    ]);
    expect(one.title).toBe("1 purchase order expected today");
    expect(one.body).toBe("PO-1 · V (expected date)");
    expect(one.dedupe_key).toBe(poDueDedupeKey("2026-09-17"));
    expect(one.audiences).toEqual([{ kind: "admins" }]);
    const two = buildPoDueNotification("2026-09-17", [
      { id: "po1", number: "PO-1", vendor_name_snapshot: null, status: "submitted", expected_today: false, eta_sources: "auto,ups" },
      { id: "po2", number: null, vendor_name_snapshot: "W", status: "partially_received", expected_today: true, eta_sources: null },
    ]);
    expect(two.title).toBe("2 purchase orders expected today");
    expect(two.body.split("\n")).toEqual(["PO-1 (carrier/UPS ETA)", "po2 · W (expected date)"]);
    expect((two.payload.purchase_orders as unknown[]).length).toBe(2);
  });
});

describe("qb failures", () => {
  it("la huella del error entra en el dedupe: mismo error no re-avisa, otro sí", () => {
    expect(errorFingerprint("  x ")).toBe(errorFingerprint("x"));
    expect(errorFingerprint("x")).toHaveLength(12);
    expect(qbFailureDedupeKey("r", "a")).not.toBe(qbFailureDedupeKey("r", "b"));
    expect(qbFailureDedupeKey("r", null)).toBe(qbFailureDedupeKey("r", ""));
  });
  it("va sólo al owner, es crítica y navega a la orden", () => {
    const n = buildQbFailureNotification({
      id: "row1", order_id: "ord_1", step: "invoice", reference_type: "invoice", reference_id: "inv_1",
      medusa_ref_number: "INV-21821", qb_ref_number: null, error: "QuickBooks Error 3180: boom", failed_at: null, retry_count: 2,
    });
    expect(n.severity).toBe("critical");
    expect(n.title).toBe("QB sync failed — invoice INV-21821");
    expect(n.action_url).toBe("/orders/ord_1");
    expect(n.audiences).toEqual([{ kind: "owner" }]);
    const noOrder = buildQbFailureNotification({
      id: "row2", order_id: null, step: null, reference_type: null, reference_id: null,
      medusa_ref_number: null, qb_ref_number: null, error: null, failed_at: null, retry_count: null,
    });
    expect(noOrder.action_url).toBe("/quickbooks");
    expect(noOrder.body).toBe("No error message recorded");
  });
});

describe("web order", () => {
  it("predicados sobre metadata", () => {
    expect(isPosCreated({ pos_created: true })).toBe(true);
    expect(isPosCreated({ pos_created: "true" })).toBe(false);
    expect(isPosCreated(null)).toBe(false);
    expect(hasSalesRep({ sales_rep: { initials: "AG" } })).toBe(true);
    expect(hasSalesRep({ sales_rep: { initials: " " } })).toBe(false);
    expect(hasSalesRep({})).toBe(false);
  });
  it("aviso a TODOS con el número de documento cuando ya existe", () => {
    const n = buildWebOrderNotification({
      id: "ord_1", display_id: 42, email: "c@x.com", metadata: { document_number: "S12000" },
      company_name: null, first_name: "Cli", last_name: "Ente", item_count: "3",
    });
    expect(n.title).toBe("New web order S12000");
    expect(n.body).toBe(`Cli Ente · 3 items · rep ${WEB_SALES_REP.initials}`);
    expect(n.audiences).toEqual([{ kind: "all" }]);
    expect(n.dedupe_key).toBe("web_order:ord_1");
    const early = buildWebOrderNotification({
      id: "ord_2", display_id: 43, email: null, metadata: null,
      company_name: null, first_name: null, last_name: null, item_count: 1,
    });
    expect(early.title).toBe("New web order #43");
    expect(early.body).toBe("Customer · 1 item · rep WEB");
  });
});
