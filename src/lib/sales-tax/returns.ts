import { ulid } from "ulid";
import type { PoolClient } from "pg";

import { LedgerError } from "../ledger/types";

import { isPeriod } from "./due-dates";
import { listPeriods, type PeriodSummary } from "./period-engine";
import type { SalesTaxSettings } from "./settings";

/**
 * `sales_tax_return` — la declaración CONGELADA de un período (sales-tax-center-20260917).
 *
 * "Prepare" copia las cifras del motor tal como estaban (`figures` = el
 * `PeriodSummary` entero + la config resuelta) con `cutoff_at`; a partir de ahí
 * la pantalla muestra el snapshot y, al lado, el cálculo vivo — si difieren, es
 * un hallazgo con nombre, no una reescritura silenciosa. "File" guarda el
 * número de confirmación del portal. "Reopen" (PIN) vuelve a `open` borrando
 * la fila: la historia queda en el audit del cambio, no en versiones.
 */

export interface SalesTaxReturnRow {
  id: string;
  period: string;
  status: "ready" | "filed";
  figures: Record<string, unknown>;
  cutoff_at: string;
  prepared_by: string;
  prepared_at: string;
  filed_by: string | null;
  filed_at: string | null;
  confirmation_number: string | null;
  filed_amount_cents: string | null;
  notes: string | null;
}

const SELECT = `SELECT id, period, status, figures, cutoff_at::text AS cutoff_at, prepared_by, prepared_at::text AS prepared_at,
  filed_by, filed_at::text AS filed_at, confirmation_number, filed_amount_cents::text AS filed_amount_cents, notes
  FROM sales_tax_return`;

export async function getSalesTaxReturn(client: PoolClient, period: string): Promise<SalesTaxReturnRow | null> {
  const { rows } = await client.query<SalesTaxReturnRow>(`${SELECT} WHERE period = $1`, [period]);
  return rows[0] ?? null;
}

export async function prepareSalesTaxReturn(
  client: PoolClient,
  settings: SalesTaxSettings,
  period: string,
  actorId: string,
  notes: string | null
): Promise<{ return: SalesTaxReturnRow; summary: PeriodSummary }> {
  if (!isPeriod(period)) throw new LedgerError("GL_SOURCE_INVALID", { reason: "invalid_period", period });
  const existing = await getSalesTaxReturn(client, period);
  if (existing) throw new LedgerError("GL_ALREADY_POSTED", { period, status: existing.status });
  const [summary] = await listPeriods(client, settings, period, period);
  if (!summary) throw new LedgerError("GL_SOURCE_INVALID", { reason: "period_not_computed", period });
  const figures = {
    summary,
    settings: {
      tax_item_list_id: settings.tax_item_list_id,
      tax_item_name: settings.tax_item_name,
      vendor_list_id: settings.vendor_list_id,
      vendor_name: settings.vendor_name,
      state_rate_bp: settings.state_rate_bp,
      surtax_rate_bp: settings.surtax_rate_bp,
      payable_list_id: settings.accounts.payable_list_id,
    },
  };
  await client.query(
    `INSERT INTO sales_tax_return (id, period, status, figures, cutoff_at, prepared_by, notes)
     VALUES ($1, $2, 'ready', $3::jsonb, now(), $4, $5)`,
    [`str_${ulid()}`, period, JSON.stringify(figures), actorId, notes]
  );
  return { return: (await getSalesTaxReturn(client, period))!, summary };
}

export async function fileSalesTaxReturn(
  client: PoolClient,
  period: string,
  input: { confirmation_number: string; filed_amount_cents: bigint; notes?: string | null },
  actorId: string
): Promise<SalesTaxReturnRow> {
  const existing = await getSalesTaxReturn(client, period);
  if (!existing) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { period });
  if (existing.status === "filed") throw new LedgerError("GL_ALREADY_POSTED", { period, status: existing.status });
  await client.query(
    `UPDATE sales_tax_return SET status = 'filed', filed_by = $2, filed_at = now(), confirmation_number = $3,
            filed_amount_cents = $4, notes = COALESCE($5, notes), updated_at = now() WHERE period = $1`,
    [period, actorId, input.confirmation_number, input.filed_amount_cents.toString(), input.notes ?? null]
  );
  return (await getSalesTaxReturn(client, period))!;
}

/** Vuelve el período a `open`. Con PIN en la ruta: deshace una preparación o una presentación registrada. */
export async function reopenSalesTaxReturn(client: PoolClient, period: string): Promise<{ removed: boolean }> {
  const result = await client.query(`DELETE FROM sales_tax_return WHERE period = $1`, [period]);
  return { removed: (result.rowCount ?? 0) > 0 };
}
