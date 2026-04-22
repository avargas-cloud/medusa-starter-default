/**
 * src/api/pos/document-templates/[id]/duplicate/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { generateId } from "../../../../../modules/document-templates/generate-id";

const DB = () =>
  new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL?.includes("railway") ||
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const db = DB();
  try {
    await db.connect();
    const { id } = req.params;
    const src = await db.query(
      "SELECT * FROM pos_document_template WHERE id = $1",
      [id]
    );
    if (!src.rows[0])
      return res.status(404).json({ error: "Template not found" });
    const t = src.rows[0];
    const now = new Date().toISOString();
    const newId = generateId();
    const result = await db.query(
      `INSERT INTO pos_document_template (id, name, doc_type, is_default, thumbnail, field_config, layout_data, layout_guides, created_by, created_at, updated_at)
             VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        newId,
        `${t.name} (Copy)`,
        t.doc_type,
        t.thumbnail,
        JSON.stringify(t.field_config),
        JSON.stringify(t.layout_data),
        JSON.stringify(t.layout_guides ?? []),
        t.created_by,
        now,
        now,
      ]
    );
    return res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    console.error("[POS/DocumentTemplates] duplicate error:", err);
    return res.status(500).json({ error: "Failed to duplicate template" });
  } finally {
    await db.end();
  }
};
