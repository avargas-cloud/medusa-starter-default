/**
 * src/api/admin/invoices/register-medusa-payment.ts
 *
 * Registers a POS payment into Medusa's native Payment Module.
 * Called from POST /admin/invoices and POST /admin/invoices/:id/payments.
 *
 * Guards:
 *   - Skips if payment_method === 'credit' (web payment already in Medusa — don't duplicate)
 *   - Non-fatal: all errors are caught/logged — Finance Ledger is the source of truth
 *
 * Returns Medusa payment.id if captured, null if skipped or failed.
 */

// Using string literals instead of imported enum constants to avoid TS type issues.
// At runtime: Modules.PAYMENT='payment', ContainerRegistrationKeys.QUERY='query', etc.
const MODULE_PAYMENT = "payment"; // Modules.PAYMENT
const KEY_QUERY = "query"; // ContainerRegistrationKeys.QUERY
const KEY_REMOTE_LINK = "remoteLink"; // ContainerRegistrationKeys.REMOTE_LINK
const SYSTEM_PROVIDER = "pp_system_default";

export async function registerMedusaPayment(
  scope: any,
  opts: {
    order_id: string;
    amount: number; // cents
    currency_code?: string; // default 'usd'
    payment_method: string; // POS label: 'visa', 'cash', 'check', etc.
    invoice_total: number; // cents — used to size the collection if creating new
  }
): Promise<string | null> {
  const { order_id, amount, payment_method, invoice_total } = opts;
  const currency_code = opts.currency_code ?? "usd";

  // Guard: 'credit' reuses an existing web payment already in Medusa — skip to avoid duplicates
  if (payment_method === "credit") return null;

  // ⚠️  Medusa payment module stores amounts in DOLLARS (major units), not cents.
  // Our finance ledger uses cents. Convert before every Medusa call.
  const medusaAmount = amount / 100;
  const medusaInvoiceTotal = invoice_total / 100;

  try {
    const paymentModule = scope.resolve(MODULE_PAYMENT);
    const query = scope.resolve(KEY_QUERY);
    const remoteLink = scope.resolve(KEY_REMOTE_LINK);
    const logger = scope.resolve("logger");

    // ── Step 1: Find existing payment collection for this order ──────────
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: ["id", "payment_collections.id"],
      filters: { id: order_id },
    });

    let collectionId: string = order?.payment_collections?.[0]?.id;

    // ── Step 2: Create collection if none exists ─────────────────────────
    if (!collectionId) {
      const collection = await paymentModule.createPaymentCollections({
        currency_code,
        amount: medusaInvoiceTotal, // Medusa Payment Module expects dollars, not cents
      });
      collectionId = collection.id;

      // Link the new payment collection to the order
      await remoteLink.create([
        {
          order: { order_id },
          payment: { payment_collection_id: collectionId },
        },
      ]);

      logger.info(
        `[registerMedusaPayment] Created PaymentCollection ${collectionId} for order ${order_id}`
      );
    } else {
      // ── Existing collection found: normalize its amount to match what we'll capture ──
      // Medusa creates payment_collections with amount in CENTS at order creation time,
      // but our payment sessions are sized in DOLLARS. Syncing the collection.amount
      // ensures Medusa marks the order as 'captured' (not 'partially_authorized').
      try {
        await paymentModule.updatePaymentCollections(collectionId, {
          amount: medusaInvoiceTotal,
        });
        logger.info(
          `[registerMedusaPayment] Normalized PaymentCollection ${collectionId} amount → ${medusaInvoiceTotal}`
        );
      } catch (updateErr: any) {
        logger.warn(
          `[registerMedusaPayment] Could not update collection amount (non-fatal): ${updateErr.message}`
        );
      }
    }

    // ── Step 3: Create a payment session for this specific amount ─────────
    const session = await paymentModule.createPaymentSession(collectionId, {
      provider_id: SYSTEM_PROVIDER,
      amount: medusaAmount, // Medusa expects dollars, not cents
      currency_code,
      data: { pos_payment_method: payment_method },
    });

    // ── Step 4: Authorize → returns PaymentDTO ───────────────────────────
    const payment = await paymentModule.authorizePaymentSession(session.id, {});

    // ── Step 5: Capture ──────────────────────────────────────────────────
    await paymentModule.capturePayment({
      payment_id: payment.id,
      amount: medusaAmount, // Medusa expects dollars, not cents
    });

    logger.info(
      `[registerMedusaPayment] Captured $${(amount / 100).toFixed(2)} on payment ${payment.id} for order ${order_id}`
    );
    return payment.id;
  } catch (err: any) {
    try {
      scope
        .resolve("logger")
        .warn(
          `[registerMedusaPayment] Failed (non-fatal) for order ${order_id}: ${err.message}`
        );
    } catch {}
    return null;
  }
}
