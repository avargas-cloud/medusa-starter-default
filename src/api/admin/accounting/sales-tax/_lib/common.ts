import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { z } from "zod";

import { ledgerFailure } from "../../../../../lib/ledger/documents/manual-http";
import { accessFailure, assertAccounting } from "../../../../../lib/pos/access-level";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import { isPeriod } from "../../../../../lib/sales-tax/due-dates";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * Helpers de las rutas /admin/accounting/sales-tax/** (sales-tax-center-20260917).
 * Acceso = Accounting; las rutas que mueven dinero o config piden además el
 * PIN de supervisor por header `x-supervisor-pin` (`guardSupervisorPin`, con
 * throttle — nunca `verifySupervisorPin` pelado, regla 09/15/2026).
 */

export const PERIOD_SCHEMA = z.string().refine(isPeriod, "period must be YYYY-MM");
export const DAY_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD");
export const CENTS_SCHEMA = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v) => BigInt(v));

export async function withAccounting(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  fn: (client: PoolClient, actorId: string) => Promise<unknown>
): Promise<void> {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    accessFailure(res, error);
    return;
  }
  const client = await getDbPool().connect();
  try {
    await fn(client, actorId);
  } catch (error) {
    ledgerFailure(res, error);
  } finally {
    client.release();
  }
}

/** Como `withAccounting`, pero el PIN se verifica ANTES de tocar nada (la ruta autoriza, no la pantalla). */
export async function withAccountingAndPin(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  fn: (client: PoolClient, actorId: string) => Promise<unknown>
): Promise<void> {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    accessFailure(res, error);
    return;
  }
  const knex = req.scope.resolve("__pg_connection__");
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: knex as unknown as PinConn,
    pin: extractSupervisorPin(req),
    actorId,
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    res.status(status).json(body);
    return;
  }
  const client = await getDbPool().connect();
  try {
    await fn(client, actorId);
  } catch (error) {
    ledgerFailure(res, error);
  } finally {
    client.release();
  }
}

export function invalid(res: MedusaResponse, issue: string | undefined): void {
  res.status(400).json({ error: issue ?? "Invalid body", code: "invalid_body" });
}

export function periodParam(req: AuthenticatedMedusaRequest, res: MedusaResponse): string | null {
  const period = req.params.period as string;
  if (!isPeriod(period)) {
    res.status(400).json({ error: "period must be YYYY-MM", code: "invalid_period" });
    return null;
  }
  return period;
}
