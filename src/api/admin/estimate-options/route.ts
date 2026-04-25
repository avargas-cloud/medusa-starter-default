import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export const DB = () =>
  new Client({ connectionString: process.env.DATABASE_URL });

/**
 * GET /admin/estimate-options
 * Returns the dropdown option lists for Estimate fields.
 * Now loaded dynamically from the system_defaults table.
 */
export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = DB();
  try {
    await client.connect();
    // We look for 'Document Defaults' context first, or fallback contexts on older migrations
    const { rows } = await client.query(
      `SELECT * FROM system_defaults 
             WHERE context IN ('Document Defaults', 'Order Defaults', 'Customer Defaults', 'Global')
             ORDER BY context, field_name, sort_order, value`
    );

    const getOptions = (name: string) =>
      Array.from(
        new Set(
          rows
            .filter(
              (r) =>
                r.field_name === name ||
                r.field_name === (name === "Payment Terms" ? "Terms" : name)
            )
            .map((r) => r.value)
        )
      );

    const getSalesReps = () => {
      return rows
        .filter(
          (r) => r.context === "Global" && r.field_name === "Sales Rep User"
        )
        .map((r) => {
          try {
            return JSON.parse(r.value);
          } catch {
            return null;
          }
        })
        .filter((u) => u && u.is_sales_rep);
    };

    res.status(200).json({
      payment_terms: getOptions("Payment Terms"),
      shipping_methods: getOptions("Shipping Method"),
      lead_times: getOptions("Lead Time"),
      order_types: getOptions("Order Type"),
      sales_reps: getSalesReps(),
    });
  } catch (e: any) {
    // Fallback to empty arrays if table is missing or DB error
    res.status(200).json({
      payment_terms: [],
      shipping_methods: [],
      lead_times: [],
      order_types: [],
      sales_reps: [],
    });
  } finally {
    await client.end();
  }
}
