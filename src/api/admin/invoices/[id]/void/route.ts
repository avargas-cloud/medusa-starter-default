/**
 * src/api/admin/invoices/[id]/void/route.ts
 * POST /admin/invoices/:id/void — Void an issued invoice
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { createSalesOrderInQb } from "../../../../../lib/quickbooks/client/sales-orders";
import { handlePosPaymentCreated } from "../../../../../lib/quickbooks/handlers/handle-pos-payment-created";
import { buildQbItems } from "../../../../../lib/quickbooks/order-flow-core";
import { parseSalesRepInitials } from "../../../../../lib/quickbooks/parse-sales-rep";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { recalculateOrderStatus } from "../../../../../utils/order-utils";
import { getDbPool } from "../../../../utils/db-pool";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const id = req.params.id!;
  const { void_reason } = req.body as { void_reason?: string };

  console.log(`[VOID INVOICE START] ID: ${id}`);
  let invoice: any;
  try {
    invoice = await invoiceService.retrievePosInvoice(id);
    console.log(
      `[VOID INVOICE] Retrieved invoice data:`,
      !!invoice,
      invoice.status
    );
  } catch {
    return res.status(404).json({ error: "Invoice not found" });
  }

  if (invoice.status === "voided") {
    console.log(`[VOID INVOICE] Encountered already voided invoice`);
    return res.status(409).json({ error: "Invoice is already voided" });
  }

  // 0. SURGICAL FULFILLMENT & INVENTORY REVERSAL (Undo POS Physical Checkout)
  if (invoice.fulfillment_id && invoice.order_id) {
    console.log(
      `[VOID INVOICE] Surgical Fulfillment Reversal Triggered for Ful ID: ${invoice.fulfillment_id}`
    );
    const pool = getDbPool();
    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;

    // Force raw SQL fetch of invoice items to bypass DML empty array anomaly
    const invoiceItemsRes = await pool.query(
      `SELECT * FROM pos_invoice_item WHERE invoice_id = $1 AND deleted_at IS NULL`,
      [id]
    );
    const activeInvoiceItems = invoiceItemsRes.rows;
    console.log(
      `[VOID INVOICE] Raw PG fetch found ${activeInvoiceItems.length} invoice items.`
    );

    // Fetch location where this was originally fulfilled to correctly return the stock
    const fulfillmentRes = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM fulfillment WHERE id = $1 LIMIT 1`,
      [invoice.fulfillment_id]
    );
    const locationId = fulfillmentRes.rows[0]?.location_id;
    console.log(`[VOID INVOICE] Fulfillment Location Found: ${locationId}`);

    if (locationId) {
      // Get original order items line references via join with order_line_item
      const orderRes = await pool.query<{
        id: string;
        line_item_id: string;
        variant_id: string;
        variant_sku: string;
      }>(
        `SELECT oi.id, oli.id as line_item_id, oli.variant_id, oli.variant_sku 
                 FROM order_item oi
                 JOIN order_line_item oli ON oi.item_id = oli.id
                 WHERE oi.order_id = $1`,
        [invoice.order_id]
      );
      const orderItems = orderRes.rows;
      console.log(
        `[VOID INVOICE] Retrieved ${orderItems.length} matching order items`
      );

      for (const posItem of activeInvoiceItems) {
        console.log(
          `[VOID INVOICE] Processing invoice line: ${posItem.description?.substring(0, 30)} | variant_id: ${posItem.variant_id} | sku: ${posItem.sku} | qty: ${posItem.quantity}`
        );
        if (!posItem.quantity) continue;

        let reqItem = posItem.variant_id
          ? orderItems.find((oi: any) => oi.variant_id === posItem.variant_id)
          : undefined;
        if (!reqItem && posItem.sku) {
          reqItem = orderItems.find(
            (oi: any) => oi.variant_sku === posItem.sku
          );
        }

        if (!reqItem) {
          console.log(
            `[VOID INVOICE] No matching order item found for invoice item ${posItem.description}. Skipping line.`
          );
          continue;
        }

        const qtyToRevert = Number(posItem.quantity);
        console.log(
          `[VOID INVOICE] Reverting ${qtyToRevert} units for variant ${posItem.variant_id}`
        );

        // 0A. Raw SQL order_item fix (erase fulfilled/delivered progress natively)
        try {
          await pool.query(
            `UPDATE order_item 
                          SET fulfilled_quantity = GREATEST(COALESCE(fulfilled_quantity, 0) - $1, 0),
                              delivered_quantity = GREATEST(COALESCE(delivered_quantity, 0) - $1, 0)
                          WHERE id = $2`,
            [qtyToRevert, reqItem.id]
          );
          console.log(
            `[VOID INVOICE] SQL order_item update success for ${reqItem.id}`
          );
        } catch (e) {
          console.error(`[VOID INVOICE] SQL Error on order_item update:`, e);
        }

        // Locate the exact inventory reference to return physical stock
        const invItemRes = await pool.query<{ inventory_item_id: string }>(
          `SELECT inventory_item_id FROM product_variant_inventory_item
                      WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [reqItem.variant_id]
        );
        const inventoryItemId = invItemRes.rows[0]?.inventory_item_id;

        if (inventoryItemId) {
          console.log(
            `[VOID INVOICE] Re-adding physical inventory for Inv Item: ${inventoryItemId} at Location: ${locationId}`
          );
          // 0B. Physically Put Stock Back On Shelf (+ qty)
          await inventoryModule.adjustInventory(
            inventoryItemId,
            locationId,
            qtyToRevert
          );

          // 0C. Re-create the Reservation Item strictly bound to the un-fulfilled line item
          // Guard: skip if an active reservation already exists for this line item
          // to prevent double-reservation on void of a partially-fulfilled order.
          // Uses raw SQL because inventoryModule.listReservationItems { line_item_id }
          // filter is unreliable in Medusa v2 (may return empty even when rows exist).
          const existingResvRows = await pool.query<{ id: string }>(
            `SELECT id FROM reservation_item WHERE line_item_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [reqItem.line_item_id]
          );
          if (existingResvRows.rows.length > 0) {
            console.log(
              `[VOID INVOICE] Reservation already exists for line_item ${reqItem.line_item_id}, skipping recreation`
            );
          } else {
            try {
              const { createReservationsWorkflow } =
                await import("@medusajs/core-flows");
              await createReservationsWorkflow(req.scope).run({
                input: {
                  reservations: [
                    {
                      inventory_item_id: inventoryItemId,
                      location_id: locationId,
                      quantity: qtyToRevert,
                      line_item_id: reqItem.line_item_id,
                      allow_backorder: true,
                      description: `Auto-restored via Void of Invoice ${invoice.invoice_number || invoice.id}`,
                    },
                  ],
                },
              });
              console.log(`[VOID INVOICE] createReservationsWorkflow Success`);
            } catch (err) {
              console.error(
                "[Void Invoice] Could not recreate reservation item silently:",
                err
              );
            }
          }
        }
      }
    }
  } else {
    console.log(
      `[VOID INVOICE] No fulfillment_id — skipping physical stock rollback`
    );
    // No physical stock movement to reverse, but we do need to recreate the
    // reservation that was deleted when the invoice was created (2026-05-11+).
    if (invoice.order_id) {
      try {
        const pool = getDbPool();
        const stockLocMod = req.scope.resolve(Modules.STOCK_LOCATION) as any;

        const [invItemsRes, locs, orderItemsRes] = await Promise.all([
          pool.query(
            `SELECT * FROM pos_invoice_item WHERE invoice_id = $1 AND deleted_at IS NULL`,
            [id]
          ),
          stockLocMod.listStockLocations({}, { take: 1, select: ["id"] }),
          pool.query<{ line_item_id: string; variant_id: string }>(
            `SELECT oli.id AS line_item_id, oli.variant_id
             FROM order_item oi
             JOIN order_line_item oli ON oi.item_id = oli.id
             WHERE oi.order_id = $1`,
            [invoice.order_id]
          ),
        ]);

        const locId: string | undefined = locs?.[0]?.id;
        if (locId) {
          const { createReservationsWorkflow } = await import(
            "@medusajs/core-flows"
          );
          for (const posItem of invItemsRes.rows) {
            if (!posItem.quantity || !posItem.variant_id) continue;
            const orderItem = orderItemsRes.rows.find(
              (oi) => oi.variant_id === posItem.variant_id
            );
            if (!orderItem) continue;
            const invLinkRes = await pool.query<{
              inventory_item_id: string;
            }>(
              `SELECT inventory_item_id FROM product_variant_inventory_item
               WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
              [posItem.variant_id]
            );
            const inventoryItemId =
              invLinkRes.rows[0]?.inventory_item_id;
            if (!inventoryItemId) continue;
            // Guard: skip if an active reservation already exists for this line item
            const existingResvNFRows = await pool.query<{ id: string }>(
              `SELECT id FROM reservation_item WHERE line_item_id = $1 AND deleted_at IS NULL LIMIT 1`,
              [orderItem.line_item_id]
            );
            if (existingResvNFRows.rows.length > 0) {
              console.log(
                `[VOID INVOICE] Reservation already exists for line_item ${orderItem.line_item_id} (no-fulfillment path), skipping`
              );
              continue;
            }
            try {
              await createReservationsWorkflow(req.scope).run({
                input: {
                  reservations: [
                    {
                      inventory_item_id: inventoryItemId,
                      location_id: locId,
                      quantity: Number(posItem.quantity),
                      line_item_id: orderItem.line_item_id,
                      allow_backorder: true,
                      description: `Restored via void of invoice ${invoice.invoice_number || invoice.id}`,
                    },
                  ],
                },
              });
              console.log(
                `[VOID INVOICE] Recreated reservation for variant ${posItem.variant_id} (no-fulfillment path)`
              );
            } catch (resErr: any) {
              console.warn(
                `[VOID INVOICE] Reservation recreation failed for ${posItem.variant_id}: ${resErr.message}`
              );
            }
          }
        }
      } catch (elseErr: any) {
        console.warn(
          `[VOID INVOICE] Reservation restoration failed (no-fulfillment path): ${elseErr.message}`
        );
      }
    }
  }

  // 1. UNAPPLY ALL ATTACHED PAYMENTS FIRST (Free up customer balance)

  // Pre-fetch order document_number — used to update SR payment reference on void
  let orderDocumentNumber: string | null = null;
  if (invoice.order_id) {
    try {
      const orderQuery = req.scope.resolve("query");
      const {
        data: [orderData],
      } = await (orderQuery as any).graph({
        entity: "order",
        fields: ["metadata"],
        filters: { id: invoice.order_id },
      });
      orderDocumentNumber =
        ((orderData?.metadata as Record<string, unknown>)
          ?.document_number as string) ?? null;
    } catch {
      // non-fatal — reference update is best-effort
    }
  }

  // Collect SR payment IDs that need a new QB ReceivePayment after void
  const srPaymentsToRequeue = new Set<string>();

  console.log(`[VOID INVOICE] Listing payment applications`);
  const dbApplications = await financeService.listPaymentApplications(
    { invoice_id: id },
    {
      relations: ["payment"],
    }
  );

  // Only process applications that aren't already voided
  const activeApplications = dbApplications.filter(
    (app: any) => !app.voided_at
  );
  console.log(
    `[VOID INVOICE] Found ${activeApplications.length} active applications to reverse`
  );

  let totalReversed = 0;
  for (const app of activeApplications) {
    totalReversed += Number(app.amount_applied);

    // Void the application
    await financeService.updatePaymentApplications({
      id: app.id,
      voided_at: new Date(),
      void_reason:
        void_reason ||
        `Auto-voided via invoice ${invoice.invoice_number || id} voiding`,
      voided_by: null, // system
    });

    // Re-evaluate the source CustomerPayment status (partially_applied vs available vs voided)
    const currentPaymentDesc = await financeService.retrieveCustomerPayment(
      app.payment.id,
      {
        relations: ["applications"],
      }
    );

    // Filter out this newly voided application to check if anything else is still clinging to this payment
    const stillActive = currentPaymentDesc.applications.filter(
      (a: any) => !a.voided_at && a.id !== app.id
    );
    const totalStillApplied = stillActive.reduce(
      (sum: number, a: any) => sum + Number(a.amount_applied),
      0
    );

    const isSRPayment =
      currentPaymentDesc.metadata?.is_sales_receipt_payment === true ||
      currentPaymentDesc.metadata?.qb_source === "sales_receipt";

    if (isSRPayment) {
      // SR payments must become AVAILABLE (not voided) — the customer's money is still
      // in hand. Clear all SR flags so handlePosPaymentCreated will re-sync it as a
      // standalone QB ReceivePayment. Update reference to the order's document_number.
      const {
        is_sales_receipt_payment: _isSR,
        qb_source: _qbSrc,
        qb_txn_id: _qbTxn,
        ...restMeta
      } = (currentPaymentDesc.metadata || {}) as Record<string, unknown>;

      await financeService.updateCustomerPayments({
        id: currentPaymentDesc.id,
        status: totalStillApplied === 0 ? "available" : "partially_applied",
        reference:
          orderDocumentNumber ||
          (currentPaymentDesc.reference as string | null),
        notes: (
          (currentPaymentDesc.notes || "") +
          `\nReleased from voided Sales Receipt ${invoice.invoice_number || id}`
        ).trim(),
        metadata: { ...restMeta, qb_sync_status: "pending" },
        qb: {},
      });

      // Medusa module updates can merge JSON metadata, so omitting SR keys above
      // is not enough to guarantee they are removed from the row. Strip them at
      // the database level so future apply_payment rows treat this as a reusable
      // ReceivePayment credit, not an embedded Sales Receipt payment.
      await getDbPool().query(
        `UPDATE customer_payment
            SET metadata = (
                  COALESCE(metadata, '{}'::jsonb)
                    - 'is_sales_receipt_payment'
                    - 'qb_source'
                    - 'qb_txn_id'
                    - 'qb_ref_number'
                    - 'qb_operation_id'
                    - 'invoices_affected'
                    - 'invoices_affected_friendly'
                ) || jsonb_build_object('qb_sync_status', 'pending'),
                qb = '{}'::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [currentPaymentDesc.id]
      );

      console.log(
        `[VOID INVOICE] SR payment ${currentPaymentDesc.id} released → available (ref: ${orderDocumentNumber ?? "unchanged"})`
      );
      srPaymentsToRequeue.add(currentPaymentDesc.id);
    } else {
      await financeService.updateCustomerPayments({
        id: currentPaymentDesc.id,
        status: totalStillApplied === 0 ? "available" : "partially_applied",
      });
    }

    // D. Refund Native Medusa Payment (best effort, to keep ledger synced)
    try {
      const query = req.scope.resolve("query");
      const paymentModule = req.scope.resolve("payment");
      const {
        data: [order],
      } = await query.graph({
        entity: "order",
        fields: [
          "payment_collections.payments.id",
          "payment_collections.payments.amount",
          "payment_collections.payments.captures.*",
          "payment_collections.payments.refunds.*",
        ],
        filters: { id: invoice.order_id },
      });
      if (order?.payment_collections?.length) {
        // `app.amount_applied` is in CENTS (finance module); the native payment
        // module works in DOLLARS. Convert once so the accounting below is
        // unit-consistent (the old code mixed cents vs dollars and only worked
        // by accident via Math.min).
        let dollarsToRefund = Number(app.amount_applied) / 100;
        for (const pc of order.payment_collections) {
          if (dollarsToRefund <= 0.001) break;
          for (const payment of (pc?.payments ?? []) as any[]) {
            if (dollarsToRefund <= 0.001) break;

            // Detect a captured payment via its CAPTURE rows (which this query
            // DOES select), NOT `payment.captured_at`/`canceled_at` — those
            // fields are not in the fields[] above, so they arrived `undefined`
            // and the old `.find(p => p.captured_at && !p.canceled_at)` never
            // matched → captured POS payments were never refunded and the native
            // payment_collection kept a stale captured amount after a void.
            // Refundable = captured − already-refunded.
            const captured = ((payment.captures ?? []) as any[]).reduce(
              (sum: number, c: any) => sum + Number(c.amount ?? 0),
              0
            );
            const refunded = ((payment.refunds ?? []) as any[]).reduce(
              (sum: number, r: any) => sum + Number(r.amount ?? 0),
              0
            );
            const availableForRefund = captured - refunded; // dollars
            if (availableForRefund <= 0.001) continue;

            const refundChunk = Math.min(dollarsToRefund, availableForRefund);
            console.log(
              `[VOID INVOICE] Native refund of $${refundChunk.toFixed(2)} from Payment ${payment.id} (captured $${captured.toFixed(2)}, already refunded $${refunded.toFixed(2)})`
            );
            try {
              await paymentModule.refundPayment({
                payment_id: payment.id,
                amount: refundChunk,
                created_by: "pos-void-hook",
                note: `Auto-refunded via Void of Invoice ${invoice.invoice_number || invoice.id}`,
              });
              dollarsToRefund -= refundChunk;
              console.log(
                `[VOID INVOICE] Native Refund Successful for Payment ${payment.id}`
              );
            } catch (refundErr: any) {
              console.error(
                "[VOID INVOICE] Refund failed for payment",
                payment.id,
                refundErr.message
              );
            }
          }
        }
        if (dollarsToRefund > 0.001) {
          console.warn(
            `[VOID INVOICE] Order ${invoice.order_id}: no refundable native capture for $${dollarsToRefund.toFixed(2)} of the voided application. The native payment_collection may retain a residual captured amount — the finance-module credit (customer_payment → available) is authoritative.`
          );
        }
      }
    } catch (e: any) {
      console.error(
        `[VOID INVOICE] Non-fatal error refunding native Medusa payment: ${e.message}`
      );
    }

    // Create an offsetting negative payment record in the Invoice ledger for auditing
    await invoiceService.createInvoicePayments({
      invoice_id: id,
      amount: -app.amount_applied,
      payment_method: "credit",
      notes: `Auto-void unapply from payment ${app.payment.reference || app.payment.id}`,
      paid_at: new Date(),
    });
    console.log(
      `[VOID INVOICE] Reversed application ${app.id} for amount ${app.amount_applied}`
    );
  }

  // Fire QB ReceivePayment creation for any SR payments that were released
  // (fire & forget — does not block the void response)
  if (
    process.env.QB_ORDER_FLOW_ENABLED === "true" &&
    srPaymentsToRequeue.size > 0
  ) {
    for (const srPaymentId of srPaymentsToRequeue) {
      const capturedId = srPaymentId;
      setTimeout(async () => {
        try {
          await handlePosPaymentCreated({
            event: { name: "pos.payment.created", data: { id: capturedId } },
            container: req.scope as any,
            pluginOptions: {},
          });
          console.log(
            `[VOID INVOICE] ✅ QB ReceivePayment queued for released SR payment ${capturedId}`
          );
        } catch (e: any) {
          console.error(
            `[VOID INVOICE] QB ReceivePayment creation failed for ${capturedId}:`,
            e.message
          );
        }
      }, 200);
    }
  }

  // 2. MARK INVOICE AS VOIDED & BALANCE TO 0
  console.log(
    `[VOID INVOICE] Calculating final invoice payments prior to void completion`
  );
  const finalInvoicePayments = await invoiceService.listInvoicePayments({
    invoice_id: id,
  });
  const finalTotalPaid = finalInvoicePayments.reduce(
    (sum: number, p: any) => sum + Number(p.amount),
    0
  );

  console.log(
    `[VOID INVOICE] Updating invoice ${id} totalPaid=${finalTotalPaid}`
  );

  // Use the explicit single-object DML signature
  const updated = await invoiceService.updatePosInvoices({
    id,
    amount_paid: 0, // Hard zero-out
    subtotal: 0,
    discount: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    balance_due: 0,
    status: "voided",
    voided_at: new Date(),
    void_reason: void_reason ?? null,
  });

  // Also zero out individual item amounts so reports don't pick up 'fake' historical line items
  try {
    const pool = getDbPool();
    await pool.query(
      `UPDATE pos_invoice_item SET unit_price = 0, total = 0 WHERE invoice_id = $1 AND deleted_at IS NULL`,
      [id]
    );
    console.log(`[VOID INVOICE] Zeroed out items for invoice ${id}`);
  } catch (e: any) {
    console.error(
      `[VOID INVOICE] Non-fatal error zeroing out invoice items: ${e.message}`
    );
  }

  // 3. DYNAMICALLY REVERT PARENT MEDUSA ORDER STATUSES
  if (invoice.order_id) {
    if (invoice.fulfillment_id) {
      try {
        // Medusa natively blocks canceling a Fulfillment once it has been "Shipped"
        // Since this is a POS hard-void, we surgically revert the item counts and nuke the physical tree.
        const pool = getDbPool();

        // 1. Find the exact quantities that were fulfilled in THIS specific fulfillment
        const fItems = await pool.query(
          `SELECT line_item_id, quantity FROM fulfillment_item WHERE fulfillment_id = $1 AND deleted_at IS NULL`,
          [invoice.fulfillment_id]
        );

        // If this fulfillment was already SHIPPED, voiding it must also roll back
        // shipped_quantity. Medusa never reverses shipped_quantity on cancel, so a
        // void-then-refulfill leaves shipped_quantity stuck at its old value, and the
        // next shipment is blocked by "Cannot ship more items than what was fulfilled"
        // (shipped >= fulfilled). We only decrement when shipped_at is set so we never
        // under-count an unshipped fulfillment. (Fixed 2026-06-02 — invoice 20561.)
        const fulShipRes = await pool.query<{ shipped_at: Date | null }>(
          `SELECT shipped_at FROM fulfillment WHERE id = $1 LIMIT 1`,
          [invoice.fulfillment_id]
        );
        const fulfillmentWasShipped = !!fulShipRes.rows[0]?.shipped_at;

        // 2. Reverse the counts in Medusa's high-precision JSONB schema
        for (const fItem of fItems.rows) {
          // Reverse fulfilled quantity
          await pool.query(
            `
                        UPDATE order_item
                        SET
                            fulfilled_quantity = GREATEST(0, fulfilled_quantity - $1::numeric),
                            raw_fulfilled_quantity = jsonb_set(
                                raw_fulfilled_quantity,
                                '{value}',
                                to_jsonb(GREATEST(0, (raw_fulfilled_quantity->>'value')::numeric - $1::numeric)::text),
                                false
                            )
                        WHERE item_id = $2
                     `,
            [fItem.quantity, fItem.line_item_id]
          );

          // Reverse shipped quantity (only if this fulfillment had been shipped)
          if (fulfillmentWasShipped) {
            await pool.query(
              `
                        UPDATE order_item
                        SET
                            shipped_quantity = GREATEST(0, shipped_quantity - $1::numeric),
                            raw_shipped_quantity = jsonb_set(
                                raw_shipped_quantity,
                                '{value}',
                                to_jsonb(GREATEST(0, (raw_shipped_quantity->>'value')::numeric - $1::numeric)::text),
                                false
                            )
                        WHERE item_id = $2
                     `,
              [fItem.quantity, fItem.line_item_id]
            );
          }

          // The allocated (reservation) quantity is natively restored by createReservationsWorkflow in Step 0C.
          // We previously ran a manual SQL update here that caused duplicate allocations.
        }

        // 3. Delete the fulfillment records
        await pool.query(
          `UPDATE fulfillment_label SET deleted_at = NOW() WHERE fulfillment_id = $1`,
          [invoice.fulfillment_id]
        );
        await pool.query(
          `UPDATE fulfillment_item SET deleted_at = NOW() WHERE fulfillment_id = $1`,
          [invoice.fulfillment_id]
        );
        await pool.query(
          `UPDATE order_fulfillment SET deleted_at = NOW() WHERE fulfillment_id = $1`,
          [invoice.fulfillment_id]
        );
        await pool.query(
          `UPDATE fulfillment SET deleted_at = NOW(), canceled_at = NOW() WHERE id = $1`,
          [invoice.fulfillment_id]
        );

        console.log(
          `[VOID INVOICE] Surgically Nuked native fulfillment ${invoice.fulfillment_id}`
        );
      } catch (fErr: any) {
        console.warn(
          `[VOID INVOICE] Could not nuke fulfillment natively:`,
          fErr.message
        );
      }
    }

    // Oracle calculation based purely on order items stock and active POS Invoices
    await recalculateOrderStatus(invoice.order_id, req.scope);

    // Restore referential_deposit: voiding the invoice reverses whatever amount_paid was credited to the order
    if (invoice.amount_paid > 0) {
      try {
        const orderModule = req.scope.resolve(Modules.ORDER);
        const [order] = await orderModule.listOrders(
          { id: invoice.order_id },
          { select: ["id", "metadata"] }
        );
        if (order) {
          const existingMeta = ((order as any).metadata as Record<string, unknown>) ?? {};
          const currentDeposit = Number(existingMeta.referential_deposit ?? 0);
          const voidedDollars = invoice.amount_paid / 100;
          const newDeposit = Math.max(0, Number((currentDeposit - voidedDollars).toFixed(2)));
          await orderModule.updateOrders(invoice.order_id, {
            metadata: { ...existingMeta, referential_deposit: newDeposit },
          });
          console.log(
            `[VOID INVOICE] Restored referential_deposit for order ${invoice.order_id}: ${currentDeposit} → ${newDeposit}`
          );
        }
      } catch (depositErr: any) {
        console.warn(
          `[VOID INVOICE] Could not restore referential_deposit for order ${invoice.order_id}: ${depositErr.message}`
        );
      }
    }

    // NOTE: Voiding an invoice (even a sales receipt) never cancels the Medusa order.
    // The order stays open with its allocations restored by the steps above.
  }

  const eventBus = req.scope.resolve(Modules.EVENT_BUS);
  await eventBus.emit({
    name: "pos.invoice.voided",
    data: {
      order_id: invoice.order_id,
      invoice_id: id,
      fulfillment_id: invoice.fulfillment_id ?? null,
    },
  });

  // QB void is handled by handleInvoiceVoided (subscriber on pos.invoice.voided above).
  // That handler correctly distinguishes void_sales_receipt vs void_invoice.

  // -- SO REPAIR AFTER INVOICE VOID --
  // If this order never got a QB Sales Order (went direct to invoice), and the invoice is
  // now voided, we need to restore the pipeline so a SO can be created.
  //   < 1h old  → pipeline sales_order row: skipped → waiting (will be processed when aged)
  //   >= 1h old → pipeline sales_order row: skipped → submitted + fire SO creation immediately
  if (process.env.QB_ORDER_FLOW_ENABLED === "true" && invoice.order_id) {
    try {
      const pool = getDbPool();

      const { rows: soCheckRows } = await pool.query<{
        created_at: Date;
        qb_list_id: string | null;
        document_number: string | null;
        display_id: number | null;
        sales_rep: string | null;
        so_flat: string | null;
        so_new: string | null;
        est_flat: string | null;
        est_new: string | null;
      }>(
        `SELECT
           o.created_at,
           o.metadata->>'qb_list_id'               AS qb_list_id,
           o.metadata->>'document_number'           AS document_number,
           o.display_id,
           o.metadata->>'sales_rep'                 AS sales_rep,
           o.metadata->>'qb_sales_order_txn_id'     AS so_flat,
           o.metadata->'qb_sales_order'->>'txn_id'  AS so_new,
           o.metadata->>'qb_estimate_txn_id'        AS est_flat,
           o.metadata->'qb_estimate'->>'txn_id'     AS est_new
         FROM "order" o WHERE o.id = $1`,
        [invoice.order_id]
      );

      const orderRow = soCheckRows[0];
      if (orderRow) {
        const hasQbDoc = !!(
          orderRow.so_flat ||
          orderRow.so_new ||
          orderRow.est_flat ||
          orderRow.est_new
        );

        if (!hasQbDoc) {
          const ageMs = Date.now() - new Date(orderRow.created_at).getTime();
          const ONE_HOUR_MS = 60 * 60 * 1000;

          if (ageMs < ONE_HOUR_MS) {
            // Too new — bump pipeline back to waiting; cron/next-Save will pick it up
            await pool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'waiting', error = NULL, updated_at = NOW()
                WHERE order_id = $1 AND step = 'sales_order' AND status = 'skipped'`,
              [invoice.order_id]
            );
            console.log(
              `[VOID INVOICE] SO repair: order < 1h — pipeline set to waiting for ${invoice.order_id}`
            );
          } else {
            // Old enough — create SO in QB now (fire & forget)
            const friendlyRef =
              orderRow.document_number ||
              (orderRow.display_id ? `S${orderRow.display_id}` : undefined);
            const salesRep = parseSalesRepInitials(
              orderRow.sales_rep ?? undefined
            );

            if (orderRow.qb_list_id) {
              const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
              const { data: orderData } = await query.graph({
                entity: "order",
                fields: [
                  "id",
                  "display_id",
                  "metadata",
                  "items.*",
                  "items.variant.*",
                  "items.variant.metadata",
                ],
                filters: { id: invoice.order_id },
              });
              const fullOrder = orderData?.[0];
              const qbItems = buildQbItems(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (fullOrder?.items ?? []).filter(Boolean) as any[],
                fullOrder?.metadata ?? undefined
              );
              const qbListId = orderRow.qb_list_id as string;

              await writePipelineRow({
                orderId: invoice.order_id,
                step: "sales_order",
                status: "pending",
                medusaRefNumber: friendlyRef,
              });

              console.log(
                `[VOID INVOICE] SO repair: order >= 1h — firing QB SO creation for ${invoice.order_id}`
              );

              setTimeout(async () => {
                try {
                  const todayDate = new Date().toISOString().split("T")[0]!;
                  const soRes = await createSalesOrderInQb({
                    customerId: qbListId,
                    date: todayDate,
                    items: qbItems,
                    ...(salesRep ? { salesRep } : {}),
                  });

                  if (soRes.success && soRes.data?.operationId) {
                    await writePipelineRow({
                      orderId: invoice.order_id,
                      step: "sales_order",
                      status: "submitted",
                      bridgeOpId: soRes.data.operationId,
                      medusaRefNumber: friendlyRef,
                    });
                    console.log(
                      `[VOID INVOICE] ✅ QB SO submitted after void, opId=${soRes.data.operationId}`
                    );
                  } else {
                    console.error(
                      `[VOID INVOICE] ❌ QB SO creation failed after void: ${soRes.error}`
                    );
                  }
                } catch (soErr: any) {
                  console.error(
                    `[VOID INVOICE] ❌ QB SO creation error after void: ${soErr.message}`
                  );
                }
              }, 300);
            } else {
              console.warn(
                `[VOID INVOICE] SO repair: order >= 1h but no qb_list_id — cannot create SO for ${invoice.order_id}`
              );
            }
          }
        } else {
          console.log(
            `[VOID INVOICE] SO repair: order already has QB SO/Estimate — skipping for ${invoice.order_id}`
          );
        }
      }
    } catch (soRepairErr: any) {
      console.error(
        `[VOID INVOICE] SO repair error (non-fatal): ${soRepairErr.message}`
      );
    }
  }
  // -- SO REPAIR END --

  console.log(`[VOID INVOICE] Final API Response Payload ready. Success.`);

  return res.json({ invoice: updated, total_reversed: totalReversed });
}
