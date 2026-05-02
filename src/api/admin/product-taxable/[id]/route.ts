import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /admin/product-taxable/:id
 * Returns { product: { id, taxable } } from product.taxable column.
 * Used by POS at add-to-cart to snapshot the flag onto POSLineItem.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params;
  const pg = req.scope.resolve("__pg_connection__") as any;

  const result = await pg.raw(
    `SELECT taxable FROM product WHERE id = ? LIMIT 1`,
    [id]
  );
  const row = result.rows?.[0];
  if (!row) {
    return res.status(404).json({ message: `Product ${id} not found` });
  }

  const taxable = row.taxable !== false;
  return res.status(200).json({ product: { id, taxable } });
};

/**
 * POST /admin/product-taxable/:id   body: { taxable: boolean }
 * Updates product.taxable column.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params;
  const { taxable } = req.body as { taxable: boolean };
  if (typeof taxable !== "boolean") {
    return res.status(400).json({ message: "taxable must be a boolean" });
  }
  const pg = req.scope.resolve("__pg_connection__") as any;
  const result = await pg.raw(
    `UPDATE product SET taxable = ? WHERE id = ? RETURNING id, taxable`,
    [taxable, id]
  );
  const row = result.rows?.[0];
  if (!row) {
    return res.status(404).json({ message: `Product ${id} not found` });
  }
  return res.status(200).json({ product: row });
};
