/**
 * GET    /admin/purchasing/analysis-groups
 * POST   /admin/purchasing/analysis-groups
 * PUT    /admin/purchasing/analysis-groups
 * DELETE /admin/purchasing/analysis-groups?id=...
 *
 * Product-level presentation groups used by the POS Purchasing Analysis
 * "Elegant" sort. Assigning a product groups all of its variants.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { withDb } from "../_lib/db";

type GroupProductRow = {
  id: string;
  product_id: string;
  title: string;
  sku_count: number;
  skus: string[];
  sort_order: number;
};

type GroupRow = {
  id: string;
  category: string;
  title: string;
  sort_order: number;
  product_count: number;
};

type GroupResponse = GroupRow & {
  products: GroupProductRow[];
  product_ids: string[];
};

type Db = {
  query: <T = unknown>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

const makeId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => cleanText(v)).filter(Boolean))];
}

async function fetchGroups(
  db: Db,
  category?: string
): Promise<GroupResponse[]> {
  const params: unknown[] = [];
  const categoryFilter = category ? `AND g.category = $1` : "";
  if (category) params.push(category);

  const groups = await db.query<GroupRow>(
    `
    SELECT
      g.id,
      g.category,
      g.title,
      g.sort_order,
      COUNT(gp.product_id)::int AS product_count
    FROM purchasing_analysis_group g
    LEFT JOIN purchasing_analysis_group_product gp
      ON gp.group_id = g.id
     AND gp.deleted_at IS NULL
    WHERE g.deleted_at IS NULL
      AND g.is_active = true
      ${categoryFilter}
    GROUP BY g.id, g.category, g.title, g.sort_order
    ORDER BY g.category, g.sort_order, g.title
    `,
    params
  );

  if (groups.rows.length === 0) return [];

  const groupIds = groups.rows.map((g) => g.id);
  const products = await db.query<GroupProductRow & { group_id: string }>(
    `
    SELECT
      gp.group_id,
      gp.id,
      gp.product_id,
      p.title,
      COUNT(pv.id)::int AS sku_count,
      ARRAY_AGG(pv.sku ORDER BY pv.sku) FILTER (WHERE pv.sku IS NOT NULL) AS skus,
      gp.sort_order
    FROM purchasing_analysis_group_product gp
    JOIN product p
      ON p.id = gp.product_id
     AND p.deleted_at IS NULL
    LEFT JOIN product_variant pv
      ON pv.product_id = p.id
     AND pv.deleted_at IS NULL
    WHERE gp.deleted_at IS NULL
      AND gp.group_id = ANY($1::text[])
    GROUP BY gp.group_id, gp.id, gp.product_id, p.title, gp.sort_order
    ORDER BY gp.group_id, gp.sort_order, p.title
    `,
    [groupIds]
  );

  const byGroup = new Map<string, GroupProductRow[]>();
  for (const row of products.rows) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push({
      id: row.id,
      product_id: row.product_id,
      title: row.title,
      sku_count: row.sku_count,
      skus: row.skus ?? [],
      sort_order: row.sort_order,
    });
    byGroup.set(row.group_id, list);
  }

  return groups.rows.map((group) => {
    const groupProducts = byGroup.get(group.id) ?? [];
    return {
      ...group,
      products: groupProducts,
      product_ids: groupProducts.map((p) => p.product_id),
    };
  });
}

async function assertNoCategoryConflicts(
  db: Db,
  category: string,
  productIds: string[],
  groupId?: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (productIds.length === 0) return { ok: true };

  const params: unknown[] = [category, productIds];
  let groupFilter = "";
  if (groupId) {
    params.push(groupId);
    groupFilter = `AND g.id <> $3`;
  }

  const existing = await db.query<{
    product_id: string;
    product_title: string;
    sku: string;
    group_title: string;
  }>(
    `
    WITH candidate_skus AS (
      SELECT
        p.id AS product_id,
        p.title AS product_title,
        pv.sku
      FROM product p
      JOIN product_variant pv
        ON pv.product_id = p.id
       AND pv.deleted_at IS NULL
       AND pv.sku IS NOT NULL
       AND btrim(pv.sku) <> ''
      WHERE p.deleted_at IS NULL
        AND p.id = ANY($2::text[])
    )
    SELECT
      candidate_skus.product_id,
      candidate_skus.product_title,
      candidate_skus.sku,
      g.title AS group_title
    FROM candidate_skus
    JOIN product_variant existing_variant
      ON existing_variant.sku = candidate_skus.sku
     AND existing_variant.deleted_at IS NULL
    JOIN purchasing_analysis_group_product gp
      ON gp.product_id = existing_variant.product_id
     AND gp.deleted_at IS NULL
    JOIN purchasing_analysis_group g
      ON g.id = gp.group_id
     AND g.deleted_at IS NULL
     AND g.is_active = true
     AND g.category = $1
     ${groupFilter}
    LIMIT 1
    `,
    params
  );

  const row = existing.rows[0];
  if (!row) return { ok: true };
  return {
    ok: false,
    message: `SKU "${row.sku}" from "${row.product_title}" is already in "${row.group_title}" for ${category}.`,
  };
}

async function replaceProducts(
  db: Db,
  groupId: string,
  productIds: string[]
): Promise<void> {
  await db.query(
    `UPDATE purchasing_analysis_group_product
     SET deleted_at = now(), updated_at = now()
     WHERE group_id = $1 AND deleted_at IS NULL`,
    [groupId]
  );

  for (const [index, productId] of productIds.entries()) {
    await db.query(
      `
      INSERT INTO purchasing_analysis_group_product
        (id, group_id, product_id, sort_order, created_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (group_id, product_id)
      DO UPDATE SET sort_order = EXCLUDED.sort_order, deleted_at = NULL, updated_at = now()
      `,
      [makeId("pagp"), groupId, productId, index]
    );
  }
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<unknown> {
  const category = cleanText((req.query as Record<string, string>).category);
  return withDb(async (db) => {
    const groups = await fetchGroups(db, category || undefined);
    return res.json({ groups, count: groups.length });
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<unknown> {
  const body = req.body as {
    category?: string;
    title?: string;
    product_ids?: string[];
  };
  const category = cleanText(body.category);
  const title = cleanText(body.title);
  const productIds = cleanProductIds(body.product_ids);

  if (!category || !title) {
    return res.status(400).json({ error: "category and title are required" });
  }

  return withDb(async (db) => {
    const conflicts = await assertNoCategoryConflicts(db, category, productIds);
    if (!conflicts.ok) {
      return res
        .status(409)
        .json({ error: "product_already_grouped", message: conflicts.message });
    }

    const order = await db.query<{ next_order: number }>(
      `
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM purchasing_analysis_group
      WHERE category = $1 AND deleted_at IS NULL
      `,
      [category]
    );
    const id = makeId("pag");

    await db.query("BEGIN");
    try {
      await db.query(
        `
        INSERT INTO purchasing_analysis_group
          (id, category, title, sort_order, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, true, now(), now())
        `,
        [id, category, title, order.rows[0]?.next_order ?? 0]
      );
      await replaceProducts(db, id, productIds);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }

    const groups = await fetchGroups(db, category);
    return res
      .status(201)
      .json({ ok: true, group: groups.find((g) => g.id === id) });
  });
}

export async function PUT(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<unknown> {
  const body = req.body as {
    id?: string;
    category?: string;
    title?: string;
    product_ids?: string[];
    sort_order?: number;
  };
  const id = cleanText(body.id);
  const category = cleanText(body.category);
  const title = cleanText(body.title);
  const productIds = cleanProductIds(body.product_ids);
  const sortOrder =
    typeof body.sort_order === "number" ? body.sort_order : undefined;

  if (!id || !category || !title) {
    return res
      .status(400)
      .json({ error: "id, category and title are required" });
  }

  return withDb(async (db) => {
    const conflicts = await assertNoCategoryConflicts(
      db,
      category,
      productIds,
      id
    );
    if (!conflicts.ok) {
      return res
        .status(409)
        .json({ error: "product_already_grouped", message: conflicts.message });
    }

    await db.query("BEGIN");
    try {
      await db.query(
        `
        UPDATE purchasing_analysis_group
        SET category = $2,
            title = $3,
            sort_order = COALESCE($4, sort_order),
            updated_at = now()
        WHERE id = $1
          AND deleted_at IS NULL
        `,
        [id, category, title, sortOrder]
      );
      await replaceProducts(db, id, productIds);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }

    const groups = await fetchGroups(db, category);
    return res.json({ ok: true, group: groups.find((g) => g.id === id) });
  });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<unknown> {
  const id = cleanText((req.query as Record<string, string>).id);
  if (!id) return res.status(400).json({ error: "id is required" });

  return withDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(
        `UPDATE purchasing_analysis_group
         SET deleted_at = now(), is_active = false, updated_at = now()
         WHERE id = $1`,
        [id]
      );
      await db.query(
        `UPDATE purchasing_analysis_group_product
         SET deleted_at = now(), updated_at = now()
         WHERE group_id = $1 AND deleted_at IS NULL`,
        [id]
      );
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }

    return res.json({ ok: true });
  });
}
