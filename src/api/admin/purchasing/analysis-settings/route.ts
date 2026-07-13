/**
 * GET /admin/purchasing/analysis-settings  — load toolbar settings
 * PUT /admin/purchasing/analysis-settings  — save toolbar settings
 *
 * Stored in store.metadata.purchasing_analysis_settings as a JSON blob.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { withDb } from "../_lib/db";

export interface PurchasingAnalysisSettings {
  tendency: number;
  inv_days_a: number;
  inv_days_b: number;
  inv_days_c: number;
  china_to_usa_days: number;
  china_to_usa_channels_days: number;
}

const DEFAULTS: PurchasingAnalysisSettings = {
  tendency: 5,
  inv_days_a: 30,
  inv_days_b: 15,
  inv_days_c: 15,
  china_to_usa_days: 27,
  china_to_usa_channels_days: 15,
};

async function loadSettings(): Promise<PurchasingAnalysisSettings> {
  return withDb(async (db) => {
    try {
      const { rows } = await db.query<{
        metadata: Record<string, unknown> | null;
      }>(`SELECT metadata FROM store LIMIT 1`);
      const stored = rows[0]?.metadata?.purchasing_analysis_settings as
        | Partial<PurchasingAnalysisSettings>
        | undefined;
      return { ...DEFAULTS, ...stored };
    } catch {
      return DEFAULTS;
    }
  });
}

/** Reference-only: real observed China→USA transit, in business days (Sundays
 *  excluded, matching how every other "days" figure in this module counts).
 *  Measured confirmed_at → received_at, NOT shipped_at → received_at — the
 *  buyer confirms the transfer (sends the calculated quantities to the agent)
 *  well before the "Shipped" button gets clicked, and that confirm moment is
 *  when the clock should start: it captures the FULL cycle (agent prep time +
 *  hand-off to the freight forwarder + the air leg itself), not just the flight.
 *  "Shipped" in this workflow is a formality for something else and under-counts
 *  the real lead time.
 *
 *  Split regular vs. Channels (EAP SKUs) by the transfer's FIRST line's SKU —
 *  verified every transfer in this system is 100% homogeneous (never mixes EAP
 *  with non-EAP lines in the same shipment), so one line is a perfect proxy for
 *  the whole transfer without scanning every line of every transfer.
 *
 *  Informational only — never overrides the buyer's manual value; the agent
 *  isn't consistent enough yet to automate this. */
type TransitCalc = { value: number | null; sampleSize: number };

async function loadCalculatedTransitDays(): Promise<{
  regular: TransitCalc;
  channels: TransitCalc;
}> {
  return withDb(async (db) => {
    try {
      const { rows } = await db.query<{
        regular_avg: string | null;
        regular_n: string;
        channels_avg: string | null;
        channels_n: string;
      }>(
        `WITH clean AS (
           SELECT it.id, it.confirmed_at, it.received_at,
             (SELECT itl.sku FROM inventory_transfer_line itl
              WHERE itl.transfer_id = it.id AND itl.deleted_at IS NULL
              ORDER BY itl.created_at LIMIT 1) AS first_sku
           FROM inventory_transfer it
           WHERE it.origin_country = 'CN' AND it.status = 'received'
             AND it.confirmed_at IS NOT NULL AND it.received_at IS NOT NULL
             AND it.confirmed_at::date <> it.received_at::date
         ),
         biz AS (
           SELECT first_sku, (
             SELECT count(*) FROM generate_series(confirmed_at::date, received_at::date, '1 day') d
             WHERE extract(dow FROM d) <> 0
           ) AS biz_days
           FROM clean
         )
         SELECT
           round(avg(biz_days) FILTER (WHERE first_sku NOT LIKE 'EAP%'))::int AS regular_avg,
           count(*) FILTER (WHERE first_sku NOT LIKE 'EAP%')::int AS regular_n,
           round(avg(biz_days) FILTER (WHERE first_sku LIKE 'EAP%'))::int AS channels_avg,
           count(*) FILTER (WHERE first_sku LIKE 'EAP%')::int AS channels_n
         FROM biz`
      );
      const r = rows[0];
      const regularN = parseInt(r?.regular_n ?? "0", 10) || 0;
      const channelsN = parseInt(r?.channels_n ?? "0", 10) || 0;
      return {
        regular: {
          value: regularN > 0 && r?.regular_avg != null ? parseInt(r.regular_avg, 10) : null,
          sampleSize: regularN,
        },
        channels: {
          value: channelsN > 0 && r?.channels_avg != null ? parseInt(r.channels_avg, 10) : null,
          sampleSize: channelsN,
        },
      };
    } catch {
      return { regular: { value: null, sampleSize: 0 }, channels: { value: null, sampleSize: 0 } };
    }
  });
}

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const [settings, calculatedTransit] = await Promise.all([
    loadSettings(),
    loadCalculatedTransitDays(),
  ]);
  return res.json({
    ...settings,
    calculated_transit_days: calculatedTransit.regular.value,
    calculated_transit_sample_size: calculatedTransit.regular.sampleSize,
    calculated_transit_channels_days: calculatedTransit.channels.value,
    calculated_transit_channels_sample_size: calculatedTransit.channels.sampleSize,
  });
}

export async function PUT(
  req: AuthenticatedMedusaRequest<Partial<PurchasingAnalysisSettings>>,
  res: MedusaResponse
) {
  const body = req.body ?? {};
  const current = await loadSettings();
  const updated: PurchasingAnalysisSettings = {
    tendency:
      typeof body.tendency === "number" ? body.tendency : current.tendency,
    inv_days_a:
      typeof body.inv_days_a === "number"
        ? body.inv_days_a
        : current.inv_days_a,
    inv_days_b:
      typeof body.inv_days_b === "number"
        ? body.inv_days_b
        : current.inv_days_b,
    inv_days_c:
      typeof body.inv_days_c === "number"
        ? body.inv_days_c
        : current.inv_days_c,
    china_to_usa_days:
      typeof body.china_to_usa_days === "number"
        ? body.china_to_usa_days
        : current.china_to_usa_days,
    china_to_usa_channels_days:
      typeof body.china_to_usa_channels_days === "number"
        ? body.china_to_usa_channels_days
        : current.china_to_usa_channels_days,
  };

  return withDb(async (db) => {
    try {
      await db.query(
        `UPDATE store SET metadata = COALESCE(metadata, '{}') || $1::jsonb`,
        [JSON.stringify({ purchasing_analysis_settings: updated })]
      );
      return res.json(updated);
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });
}
