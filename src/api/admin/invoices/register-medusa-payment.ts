/**
 * src/api/admin/invoices/register-medusa-payment.ts
 *
 * Registers a POS payment into Medusa's native Payment Module.
 * Called from POST /admin/invoices and POST /admin/invoices/:id/payments.
 *
 * Guards:
 *   - Skips store-credit/credit-memo methods (already represented in the ledger/QB;
 *     creating a new Medusa capture would inflate the order paid amount)
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

const MEDUSA_CAPTURE_EXCLUDED_METHODS = new Set([
  "credit",
  "credit_memo",
  "store_credit",
]);

export async function registerMedusaPayment(
  scope: any,
  opts: {
    order_id: string;
    amount: number; // cents
    currency_code?: string; // default 'usd'
    payment_method: string; // POS label: 'visa', 'cash', 'check', etc.
    invoice_total: number; // cents — used to size the collection if creating new
    customer_payment_id?: string; // finance payment being captured (for guard log/audit)
  }
): Promise<string | null> {
  const { order_id, amount, payment_method, invoice_total, customer_payment_id } =
    opts;
  const currency_code = opts.currency_code ?? "usd";

  // Guard: applying customer credit is not new money. Do not create a native
  // Medusa capture for credit memo/store-credit applications.
  if (MEDUSA_CAPTURE_EXCLUDED_METHODS.has(payment_method)) return null;

  // ⚠️  Medusa payment module stores amounts in DOLLARS (major units), not cents.
  // Our finance ledger uses cents. Convert before every Medusa call. The actual
  // captured amount is computed by the anti-double-capture guard below.
  const medusaInvoiceTotal = invoice_total / 100;

  try {
    const paymentModule = scope.resolve(MODULE_PAYMENT);
    const query = scope.resolve(KEY_QUERY);
    const remoteLink = scope.resolve(KEY_REMOTE_LINK);
    const knex = scope.resolve("__pg_connection__");
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

    // ── Step 2.5: Rebind-safe cumulative-gap guard (anti double-capture) ──
    // A native capture must never push the order's native effective captured
    // above its DEDUPED expected native amount:
    //   order_expected = Σ per-payment LEAST(Σ active apps, customer_payment.amount)
    // The LEAST() cap is what makes this rebind-safe: during a deposit→invoice
    // rebind the SAME customer_payment briefly has two active applications
    // (order-only + invoice-bound), but it still contributes at most its own
    // amount — so once it's captured, the gap is 0 and we skip the 2nd capture.
    // This also hard-caps any single over-capture (the ~1.07 cases) going fwd.
    const { rows: gapRows } = await knex.raw(
      `
      WITH exp AS (
        SELECT COALESCE(SUM(LEAST(applied_cents, payment_cents)),0)::bigint AS order_expected
        FROM (
          SELECT pa.payment_id,
                 SUM(pa.amount_applied)::bigint AS applied_cents,
                 MAX(cp.amount)::bigint         AS payment_cents
          FROM payment_application pa
          JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
          WHERE pa.order_id = ? AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
            AND cp.status <> 'voided'
          GROUP BY pa.payment_id
        ) x
      ),
      nat AS (
        SELECT COALESCE(ROUND((SUM(pc.captured_amount) - SUM(COALESCE(pc.refunded_amount,0))) * 100),0)::bigint AS native_now
        FROM order_payment_collection opc
        JOIN payment_collection pc ON pc.id = opc.payment_collection_id
        WHERE opc.order_id = ?
      )
      SELECT exp.order_expected, nat.native_now FROM exp, nat
      `,
      [order_id, order_id]
    );
    const orderExpectedCents = Number(gapRows?.[0]?.order_expected ?? 0);
    const nativeNowCents = Number(gapRows?.[0]?.native_now ?? 0);
    const captureCents = Math.min(amount, orderExpectedCents - nativeNowCents);

    if (captureCents <= 1) {
      logger.info(
        `[registerMedusaPayment] SKIP native capture (already covered) for order ${order_id}` +
          `${customer_payment_id ? ` cp=${customer_payment_id}` : ""} — ` +
          `expected=${orderExpectedCents}¢ native=${nativeNowCents}¢ requested=${amount}¢`
      );
      return null;
    }
    if (captureCents < amount) {
      logger.info(
        `[registerMedusaPayment] CAP native capture for order ${order_id} ` +
          `${amount}¢ → ${captureCents}¢ (expected=${orderExpectedCents}¢ native=${nativeNowCents}¢)`
      );
    }
    const captureDollars = captureCents / 100; // Medusa expects dollars

    // ── Step 3: Create a payment session for this specific amount ─────────
    const session = await paymentModule.createPaymentSession(collectionId, {
      provider_id: SYSTEM_PROVIDER,
      amount: captureDollars,
      currency_code,
      data: { pos_payment_method: payment_method },
    });

    // ── Step 4: Authorize → returns PaymentDTO ───────────────────────────
    const payment = await paymentModule.authorizePaymentSession(session.id, {});

    // ── Step 5: Capture ──────────────────────────────────────────────────
    await paymentModule.capturePayment({
      payment_id: payment.id,
      amount: captureDollars,
    });

    logger.info(
      `[registerMedusaPayment] Captured $${captureDollars.toFixed(2)} on payment ${payment.id} for order ${order_id}`
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
