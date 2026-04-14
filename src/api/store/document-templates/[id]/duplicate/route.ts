/**
 * src/api/store/document-templates/[id]/duplicate/route.ts
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
    const src = await db.query(
      "SELECT * FROM pos_document_template WHERE id = $1",
      [req.params.id]
    );
    if (!src.rows[0])
      return res.status(404).json({ error: "Template not found" });
    const t = src.rows[0];
    const now = new Date().toISOString();
    const result = await db.query(
      `INSERT INTO pos_document_template (id, name, doc_type, is_default, thumbnail, field_config, layout_data, created_by, created_at, updated_at)
             VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        generateId(),
        `${t.name} (Copy)`,
        t.doc_type,
        t.thumbnail,
        t.field_config,
        t.layout_data,
        t.created_by,
        now,
        now,
      ]
    );
    return res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    console.error("[Store/DocumentTemplates] duplicate error:", err);
    return res.status(500).json({ error: "Failed to duplicate template" });
  } finally {
    await db.end();
  }
};
