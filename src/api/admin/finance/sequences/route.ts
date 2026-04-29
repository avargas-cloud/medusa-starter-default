import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

const VALID_SEQUENCES = [
  "custom_estimate_seq",
  "custom_order_seq",
  "custom_medusa_invoice_seq",
  "custom_credit_memo_seq",
  "custom_invoice_seq",
  "custom_sales_receipt_seq",
  "custom_payment_seq",
  "custom_inventory_count_seq",
  "custom_unmet_demand_seq",
  "custom_purchase_order_seq",
  "custom_po_receipt_seq",
  "custom_factory_order_seq",
  "custom_fo_receipt_seq",
  "custom_vendor_bill_seq",
];

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const pg = req.scope.resolve("__pg_connection__") as any;
  const results: Record<string, number | null> = {};

  try {
    for (const seq of VALID_SEQUENCES) {
      try {
        // last_value provides the current sequence count WITHOUT incrementing it
        const result = await pg.raw(`SELECT last_value FROM ${seq}`);
        results[seq] =
          result.rows[0].last_value || result.rows[0].LAST_VALUE || null;
      } catch (e: any) {
        // If the sequence somehow wasn't called yet or errors, we ignore and return null
        if (e.message.includes("not called")) {
          results[seq] = null;
        } else {
          console.error(`Error fetching sequence ${seq}:`, e.message);
          results[seq] = null;
        }
      }
    }
    return res.json({ sequences: results });
  } catch (e: any) {
    console.error("GET /admin/finance/sequences Error:", e);
    return res.status(500).json({ error: e.message });
  }
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const pg = req.scope.resolve("__pg_connection__") as any;
  try {
    const body = req.body as Record<string, number>;
    if (!body || Object.keys(body).length === 0) {
      return res.status(400).json({ error: "No sequence updates provided" });
    }

    const updated: Record<string, number> = {};

    for (const [seq, newValue] of Object.entries(body)) {
      if (!VALID_SEQUENCES.includes(seq)) {
        return res
          .status(400)
          .json({ error: `Invalid sequence identifier: ${seq}` });
      }
      if (typeof newValue !== "number" || newValue < 1) {
        return res.status(400).json({
          error: `Invalid value for sequence ${seq}. Must be a positive integer.`,
        });
      }

      // Update the sequence safely
      // setval('custom_order_seq', 5000, false) means the next nextval() call will return 5000 exactly
      await pg.raw(`SELECT setval(?, ?, false)`, [seq, newValue]);
      updated[seq] = newValue;
      console.log(
        `[Sequences] Manually updated ${seq} to next value ${newValue}`
      );
    }

    return res.json({ success: true, updated });
  } catch (e: any) {
    console.error("POST /admin/finance/sequences Error:", e);
    return res.status(500).json({ error: e.message });
  }
};
