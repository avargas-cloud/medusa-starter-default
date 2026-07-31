/**
 * src/api/admin/purchase-orders/_lib/tracking-summary.ts
 *
 * The list page's Tracking column, in one grouped query.
 *
 * WHY THIS FILE EXISTS
 * Inbound tracking moved out of `purchase_order.tracking` (a jsonb column) into
 * three tables. The write path stopped maintaining the jsonb, but the LIST route
 * returns raw model rows, so the column kept rendering a frozen snapshot: a PO
 * whose deliveries were added after the migration showed "—" while carrying two
 * of them, and editing a number on any PO left the list quoting the old one
 * forever. The detail page was right and the list was wrong about the same PO.
 *
 * DELIVERIES ARE THE UNIT, NOT NUMBERS
 * One arrival routinely carries several carrier numbers (two FedEx waybills, a
 * freight booking plus its house bill) — those are labels on ONE delivery, and
 * collapsing them into "+N" made a split shipment read identically to a
 * double-labelled truck. They are counted separately so the column can say which
 * one it is.
 *
 * ONLY WHAT A CELL CAN SHOW
 * This is deliberately not `resolvePoShipments` (lib/purchase-orders/po-tracking-read.ts).
 * That reader hydrates every number and every line allocation for ONE PO, which
 * is right for the detail page and wasteful across a page of 50. A row 150px wide
 * shows a master number and a count; anything else is payload nobody renders.
 *
 * IMPORTANT: knex here is the `__pg_connection__` pool → `?` placeholders (NOT
 * `$1`).
 */

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** The number a cell quotes when it has room for exactly one. */
export interface TrackingSummaryNumber {
  provider: string;
  tracking_number: string;
  /** Empty for untrackable carriers (e.g. ocean freight) — render as plain text. */
  tracking_url: string;
}

export interface TrackingSummary {
  /** Live deliveries on this PO. 0 renders as "—". */
  delivery_count: number;
  /** Carrier numbers across all of them — exceeds delivery_count when a truck has several waybills. */
  number_count: number;
  /**
   * `mixed` must never occur (the write path refuses to create it). It is
   * surfaced rather than smoothed over so a legacy or hand-edited PO is visible
   * instead of rendering as ordinary.
   */
  coverage: "all_order" | "by_line" | "mixed" | "none";
  /** Master of the most recent delivery; null when no number exists yet. */
  master: TrackingSummaryNumber | null;
}

const EMPTY: TrackingSummary = {
  delivery_count: 0,
  number_count: 0,
  coverage: "none",
  master: null,
};

interface Row {
  id: string;
  delivery_count: string | number;
  number_count: string | number;
  has_all_order: boolean;
  has_by_line: boolean;
  master: TrackingSummaryNumber | null;
}

/** Postgres `count()` arrives as a string over the wire. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tracking summary for a page of POs, keyed by PO id. POs with no deliveries are
 * absent from the result and read as EMPTY.
 */
export async function enrichTrackingSummaryMap(
  knex: Knex,
  rows: Array<{ id: string }>
): Promise<Map<string, TrackingSummary>> {
  const out = new Map<string, TrackingSummary>();
  if (rows.length === 0) return out;

  const ids = rows.map((r) => r.id);
  const result = (await knex.raw(
    `SELECT trk.purchase_order_id AS id,
            COUNT(DISTINCT trk.id)                              AS delivery_count,
            COUNT(n.id)                                         AS number_count,
            BOOL_OR(trk.scope = 'all_order')                    AS has_all_order,
            BOOL_OR(trk.scope = 'by_line')                      AS has_by_line,
            -- Master of the most recent delivery. The ORDER BY is a TOTAL order
            -- (…, id) on purpose: created_at ties are common because a delivery
            -- and its numbers are inserted in one statement, and a LIMIT 1 over a
            -- partial order returns a different row per plan.
            (SELECT json_build_object(
                      'provider',        COALESCE(n2.provider, ''),
                      'tracking_number', COALESCE(n2.tracking_number, ''),
                      'tracking_url',    COALESCE(n2.tracking_url, '')
                    )
               FROM purchase_order_tracking trk2
               JOIN purchase_order_tracking_number n2
                 ON n2.purchase_order_tracking_id = trk2.id
                AND n2.deleted_at IS NULL
              WHERE trk2.purchase_order_id = trk.purchase_order_id
                AND trk2.deleted_at IS NULL
              ORDER BY trk2.created_at DESC, trk2.id DESC,
                       n2.is_master DESC, n2.created_at, n2.id
              LIMIT 1)                                          AS master
       FROM purchase_order_tracking trk
       LEFT JOIN purchase_order_tracking_number n
              ON n.purchase_order_tracking_id = trk.id
             AND n.deleted_at IS NULL
      WHERE trk.purchase_order_id = ANY (?::text[])
        AND trk.deleted_at IS NULL
      GROUP BY trk.purchase_order_id`,
    [ids]
  )) as { rows: Row[] };

  for (const r of result.rows) {
    const hasAll = Boolean(r.has_all_order);
    const hasByLine = Boolean(r.has_by_line);
    out.set(r.id, {
      delivery_count: num(r.delivery_count),
      number_count: num(r.number_count),
      coverage:
        hasAll && hasByLine
          ? "mixed"
          : hasAll
            ? "all_order"
            : hasByLine
              ? "by_line"
              : "none",
      master: r.master?.tracking_number ? r.master : null,
    });
  }

  for (const row of rows) if (!out.has(row.id)) out.set(row.id, EMPTY);
  return out;
}
