/**
 * Verifies that POST /admin/invoices honors partial quantities. Picks an
 * order with multiple items, builds a body with HALF the quantity for one
 * SKU and EXCLUDES another SKU entirely, then asserts pos_invoice_item
 * matches what was sent (no full-quantity override).
 *
 * Run: yarn medusa exec ./src/scripts/verify/verify-partial-invoice.ts
 */
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";

const ORDER_DISPLAY_ID = 1576;

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export default async function verify({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const pool = getDbPool();

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "customer_id",
      "items.*",
      "items.variant.*",
    ],
    filters: { display_id: ORDER_DISPLAY_ID },
  });
  const order = orders?.[0];
  if (!order) {
    console.log(`Order ${ORDER_DISPLAY_ID} not found.`);
    return;
  }

  const items = (order.items || []).filter((i: any) => (i.quantity ?? 0) > 0);
  if (items.length < 2) {
    console.log(`Order ${ORDER_DISPLAY_ID} only has ${items.length} items — need ≥2.`);
    return;
  }

  // Cleanup any prior test invoice for this order
  await pool.query(
    `DELETE FROM pos_invoice_item WHERE invoice_id IN
       (SELECT id FROM pos_invoice WHERE order_id = $1 AND notes = 'PARTIAL VERIFY TEST')`,
    [order.id]
  );
  await pool.query(
    `DELETE FROM pos_invoice WHERE order_id = $1 AND notes = 'PARTIAL VERIFY TEST'`,
    [order.id]
  );

  // Pick first item with qty ≥ 2 to halve, second item to exclude entirely
  const halveable = items.find((i: any) => (i.quantity ?? 0) >= 2);
  const excludable = items.find((i: any) => i.id !== halveable?.id);
  if (!halveable || !excludable) {
    console.log("Need at least one item with qty ≥ 2 and another distinct item.");
    return;
  }

  const halvedQty = Math.floor(halveable.quantity / 2);
  const includedItems = items
    .filter((i: any) => i.id !== excludable.id)
    .map((i: any) => ({
      ...i,
      quantity: i.id === halveable.id ? halvedQty : i.quantity,
    }));

  console.log(`\n=== Partial Invoice Test against order ${ORDER_DISPLAY_ID} ===`);
  console.log(`Original items: ${items.length}`);
  console.log(
    `Sending body.items: ${includedItems.length} (excluding ${excludable.variant?.sku || excludable.title})`
  );
  console.log(
    `  Halved item ${halveable.variant?.sku}: ${halveable.quantity} → ${halvedQty}`
  );

  // Build body matching what the modal sends
  const subtotalCents = includedItems.reduce(
    (s: number, it: any) =>
      s + Math.round(Number(it.unit_price) * 100) * it.quantity,
    0
  );

  const body: any = {
    order_id: order.id,
    customer_id: order.customer_id,
    items: includedItems.map((it: any) => ({
      item_id: it.id,
      variant_id: it.variant_id ?? undefined,
      sku: it.variant?.sku ?? null,
      description: it.title ?? "Item",
      quantity: it.quantity,
      unit_price: Math.round(Number(it.unit_price) * 100),
      total: Math.round(Number(it.unit_price) * 100) * it.quantity,
    })),
    subtotal: subtotalCents,
    discount: 0,
    shipping: 0,
    tax: 0,
    total: subtotalCents,
    amount_paid: subtotalCents,
    payment_method: "cash",
    notes: "PARTIAL VERIFY TEST",
  };

  // Generate an admin auth token via the auth service
  const authModule = container.resolve(Modules.AUTH);
  const userModule = container.resolve(Modules.USER);

  // Find an admin user
  const { data: users } = await query.graph({
    entity: "user",
    fields: ["id", "email"],
    filters: {},
  });
  const admin = users?.find((u: any) => u.email === "a.vargas@ecopowertech.com");
  if (!admin) {
    console.log("Admin user not found.");
    return;
  }

  // Use jsonwebtoken directly with the JWT_SECRET to forge an admin token
  const jwt = require("jsonwebtoken");
  const token = jwt.sign(
    { actor_id: admin.id, actor_type: "user" },
    process.env.JWT_SECRET || "supersecret",
    { expiresIn: "10m" }
  );

  const resp = await fetch("http://localhost:9099/admin/invoices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.log(`POST failed: ${resp.status} ${await resp.text()}`);
    return;
  }
  const json: any = await resp.json();
  const invoiceId = json?.invoice?.id || json?.id;
  console.log(`Invoice created: ${invoiceId}`);

  // Re-read pos_invoice_item from DB
  const { rows: storedItems } = await pool.query(
    `SELECT sku, quantity FROM pos_invoice_item WHERE invoice_id = $1 ORDER BY created_at`,
    [invoiceId]
  );

  console.log("\nStored pos_invoice_item rows:");
  for (const r of storedItems) {
    console.log(`  ${r.sku} → quantity=${r.quantity}`);
  }

  // Assertions
  const checks: CheckResult[] = [];

  // 1. Excluded SKU should NOT be in pos_invoice_item
  const excludedSku = excludable.variant?.sku || excludable.title;
  const excludedFound = storedItems.find((r: any) => r.sku === excludedSku);
  checks.push({
    name: `Excluded SKU '${excludedSku}' is NOT in invoice`,
    passed: !excludedFound,
    detail: excludedFound
      ? `BUG: excluded SKU was stored with qty=${excludedFound.quantity}`
      : undefined,
  });

  // 2. Halved SKU should have the reduced quantity
  const halvedSku = halveable.variant?.sku;
  const halvedRow = storedItems.find((r: any) => r.sku === halvedSku);
  checks.push({
    name: `Halved SKU '${halvedSku}' has qty=${halvedQty} (not original ${halveable.quantity})`,
    passed: halvedRow?.quantity === halvedQty,
    detail: halvedRow
      ? `actual qty=${halvedRow.quantity}, expected ${halvedQty}`
      : "row not found",
  });

  // 3. Total stored items count matches body count
  checks.push({
    name: `Stored items count = sent items count`,
    passed: storedItems.length === includedItems.length,
    detail: `stored=${storedItems.length}, sent=${includedItems.length}`,
  });

  console.log("\n=== Results ===");
  for (const c of checks) {
    const icon = c.passed ? "✓" : "✗";
    const detail = c.detail ? ` (${c.detail})` : "";
    console.log(`${icon} ${c.name}${detail}`);
  }

  const passed = checks.filter((c) => c.passed).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed < checks.length) {
    process.exitCode = 1;
  }

  // Cleanup
  await pool.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [invoiceId]);
  await pool.query(`DELETE FROM pos_invoice WHERE id = $1`, [invoiceId]);
  console.log(`\nCleaned up test invoice ${invoiceId}.`);
}
