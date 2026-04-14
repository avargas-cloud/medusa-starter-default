import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

const DB = () => new Client({ connectionString: process.env.DATABASE_URL });

/**
 * PATCH /admin/note-presets/:id
 * Updates a preset (any fields)
 */
export async function PATCH(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params;
  const { group_name, title, content, sort_order } = req.body as any;

  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (group_name !== undefined) {
    sets.push(`group_name = $${i++}`);
    vals.push(group_name);
  }
  if (title !== undefined) {
    sets.push(`title = $${i++}`);
    vals.push(title);
  }
  if (content !== undefined) {
    sets.push(`content = $${i++}`);
    vals.push(content);
  }
  if (sort_order !== undefined) {
    sets.push(`sort_order = $${i++}`);
    vals.push(sort_order);
  }
  sets.push(`updated_at = NOW()`);

  if (vals.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  vals.push(id);
  const client = DB();
  try {
    await client.connect();
    const { rows } = await client.query(
      `UPDATE note_presets SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ preset: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
}

/**
 * DELETE /admin/note-presets/:id
 * Deletes a preset
 */
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params;
  const client = DB();
  try {
    await client.connect();
    const { rowCount } = await client.query(
      `DELETE FROM note_presets WHERE id = $1`,
      [id]
    );
    if (!rowCount) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
}
