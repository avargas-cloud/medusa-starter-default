import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

/**
 * POST /admin/orders/:id/fix-payment
 *
 * Recalculates and patches the payment collection to match the current order total.
 * Call this after editing items/shipping/discounts on a confirmed order to keep
 * the "Total pending" amount in sync.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders: Record<string, string> = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
    "Content-Type": "application/json",
  };

  try {
    // 1. Fetch the current order total (Medusa computes from stored tax_lines)
    const orderRes = await fetch(
      `${base}/admin/orders/${id}?fields=total,tax_total,subtotal,discount_total`,
      { headers: authHeaders }
    );
    if (!orderRes.ok) {
      return void res
        .status(400)
        .json({ message: "Could not fetch order total" });
    }
    const { order } = await orderRes.json();
    const correctTotal: number | null = order?.total > 0 ? order.total : null;

    if (correctTotal === null) {
      return void res
        .status(200)
        .json({ success: true, skipped: true, reason: "zero total" });
    }

    console.log(`[fix-payment] order ${id} total = ${correctTotal}`);

    // 2. Fetch payment collections for this order
    const pcRes = await fetch(
      `${base}/admin/payment-collections?order_id=${id}`,
      { headers: authHeaders }
    );
    if (!pcRes.ok) {
      return void res
        .status(200)
        .json({
          success: true,
          skipped: true,
          reason: "no payment collections",
        });
    }
    const { payment_collections: collections = [] } = await pcRes.json();

    // 3. Patch each payment collection to the correct amount (in cents)
    const correctCents = Math.round(correctTotal * 100);
    let patched = 0;

    for (const col of collections) {
      if (col.amount === correctCents) {
        console.log(
          `[fix-payment] collection ${col.id} already correct (${correctCents} cents)`
        );
        continue;
      }
      console.log(
        `[fix-payment] patching collection ${col.id}: ${col.amount} → ${correctCents} cents`
      );
      const patchRes = await fetch(
        `${base}/admin/payment-collections/${col.id}`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ amount: correctCents }),
        }
      );
      if (patchRes.ok) patched++;
      else {
        const err = await patchRes.json().catch(() => ({}));
        console.warn(`[fix-payment] patch failed for ${col.id}:`, err?.message);
      }
    }

    res
      .status(200)
      .json({ success: true, correct_total: correctTotal, patched });
  } catch (e: any) {
    console.error("[fix-payment]", e?.message);
    res.status(500).json({ message: e?.message ?? "Failed to fix payment" });
  }
}
