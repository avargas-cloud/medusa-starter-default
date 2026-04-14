import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

/**
 * GET /admin/shipping-settings
 * Returns current shipping configuration
 */
export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(`
            SELECT 
                id,
                free_shipping_minimum,
                regular_ground_shipping_price,
                long_item_ground_shipping_price,
                override_ups_ground,
                created_at,
                updated_at
            FROM shipping_settings
            LIMIT 1
        `);

    // If no settings exist, return defaults
    if (result.rows.length === 0) {
      res.json({
        settings: {
          free_shipping_minimum: 0,
          regular_ground_shipping_price: 0,
          long_item_ground_shipping_price: 0,
          override_ups_ground: false,
        },
      });
      return;
    }

    res.json({
      settings: result.rows[0],
    });
  } catch (error: any) {
    console.error("Error fetching shipping settings:", error);
    res.status(500).json({
      error: "Failed to fetch shipping settings",
    });
  } finally {
    await client.end();
  }
}

/**
 * POST /admin/shipping-settings
 * Updates shipping configuration
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const {
      free_shipping_minimum,
      regular_ground_shipping_price,
      long_item_ground_shipping_price,
      override_ups_ground,
    } = req.body as {
      free_shipping_minimum?: number;
      regular_ground_shipping_price?: number;
      long_item_ground_shipping_price?: number;
      override_ups_ground?: boolean;
    };

    // Validation - all values must be non-negative numbers if provided
    if (free_shipping_minimum !== undefined && free_shipping_minimum < 0) {
      res.status(400).json({
        error: "free_shipping_minimum must be a non-negative number",
      });
      return;
    }

    if (
      regular_ground_shipping_price !== undefined &&
      regular_ground_shipping_price < 0
    ) {
      res.status(400).json({
        error: "regular_ground_shipping_price must be a non-negative number",
      });
      return;
    }

    if (
      long_item_ground_shipping_price !== undefined &&
      long_item_ground_shipping_price < 0
    ) {
      res.status(400).json({
        error: "long_item_ground_shipping_price must be a non-negative number",
      });
      return;
    }

    await client.connect();

    // Check if settings exist
    const existingResult = await client.query(`
            SELECT id FROM shipping_settings LIMIT 1
        `);

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (free_shipping_minimum !== undefined) {
      updates.push(`free_shipping_minimum = $${paramIndex}`);
      values.push(free_shipping_minimum);
      paramIndex++;
    }

    if (regular_ground_shipping_price !== undefined) {
      updates.push(`regular_ground_shipping_price = $${paramIndex}`);
      values.push(regular_ground_shipping_price);
      paramIndex++;
    }

    if (long_item_ground_shipping_price !== undefined) {
      updates.push(`long_item_ground_shipping_price = $${paramIndex}`);
      values.push(long_item_ground_shipping_price);
      paramIndex++;
    }

    if (override_ups_ground !== undefined) {
      updates.push(`override_ups_ground = $${paramIndex}`);
      values.push(override_ups_ground);
      paramIndex++;
    }

    if (updates.length === 0) {
      res.status(400).json({
        error: "No fields to update",
      });
      return;
    }

    updates.push(`updated_at = NOW()`);

    let result;
    if (existingResult.rows.length === 0) {
      // Insert new settings
      const insertQuery = `
                INSERT INTO shipping_settings (
                    free_shipping_minimum,
                    regular_ground_shipping_price,
                    long_item_ground_shipping_price,
                    override_ups_ground
                ) VALUES ($1, $2, $3, $4)
                RETURNING *
            `;
      result = await client.query(insertQuery, [
        free_shipping_minimum || 0,
        regular_ground_shipping_price || 0,
        long_item_ground_shipping_price || 0,
        override_ups_ground || false,
      ]);
    } else {
      // Update existing settings
      const updateQuery = `
                UPDATE shipping_settings
                SET ${updates.join(", ")}
                RETURNING *
            `;
      result = await client.query(updateQuery, values);
    }

    res.json({
      settings: result.rows[0],
      message: "Shipping settings updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating shipping settings:", error);
    res.status(500).json({
      error: "Failed to update shipping settings",
    });
  } finally {
    await client.end();
  }
}
