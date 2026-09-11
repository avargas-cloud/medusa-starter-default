import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { getBusinessDateString } from "../lib/date/et";
import { reconcilePurchaseDrift, replayLedger } from "../lib/ledger";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

/**
 * src/jobs/ledger-reconciler.ts
 *
 * gl-core-v1 §6: los hooks de posting son best-effort — un fallo del motor
 * (o un caller que nunca llamó al hook) NUNCA rompe la operación del POS.
 * Este job es la red: cada 5 min postea lo que falte y reversa lo voideado
 * desde el go-live del GL (2026-04-14), tope 200 por corrida.
 *
 * No-op total salvo `GL_POSTING_ENABLED === "true"` — en cualquier otro
 * ambiente el GL es invisible, igual que los hooks.
 */
const GL_REPLAY_FROM = "2026-04-14";
const GL_RECONCILER_LIMIT = 200;

export default async function ledgerReconciler(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (process.env.GL_POSTING_ENABLED !== "true") return;

  const logger = container.resolve("logger");
  const client = await getDbPool().connect();
  try {
    // `replayLedger` usa SAVEPOINT por documento (sólo válido dentro de una
    // transacción abierta) y `postDocumentJournal`/`reverseDocumentJournal`
    // dependen de que entry+líneas se commiteen JUNTOS para que el trigger
    // DEFERRED de balance (`gl_document_check_balance`) los vea completos —
    // medido contra el sandbox: sin este BEGIN/COMMIT explícito, cada INSERT
    // suelto es su propia transacción y el balance revienta viendo 0 líneas.
    await client.query("BEGIN");
    const report = await replayLedger(client, {
      from: GL_REPLAY_FROM,
      to: getBusinessDateString(),
      apply: true,
      limit: GL_RECONCILER_LIMIT,
    });
    await client.query("COMMIT");
    const blocked = (report as { blocked?: unknown[] }).blocked ?? [];
    logger.info(
      `[ledger-reconciler] replay ${GL_REPLAY_FROM}→today: ` +
        `${JSON.stringify({ ...report, blocked: undefined })} ` +
        `blocked=${blocked.length}`
    );
    if (blocked.length > 0) {
      // Tope: nunca inundar el log con el detalle completo de un backlog grande.
      logger.warn(
        `[ledger-reconciler] ${blocked.length} blocked (showing up to 20): ` +
          JSON.stringify(blocked.slice(0, 20))
      );
    }

    // gl-purchases-v2 §5: drift de vendor_bill (reconfirm reescribe costos/
    // revisión sin cambiar `status`). Transacción PROPIA — `replayLedger` ya
    // cerró la suya arriba (el COMMIT anterior deja `client` en autocommit,
    // y `reconcilePurchaseDrift` abre SAVEPOINTs por bill, igual de inválido
    // fuera de una transacción que el de `replayLedger`).
    await client.query("BEGIN");
    const driftReport = await reconcilePurchaseDrift(client, {
      limit: GL_RECONCILER_LIMIT,
    });
    await client.query("COMMIT");
    logger.info(
      `[ledger-reconciler] purchase drift: ${JSON.stringify({ ...driftReport, blocked: undefined })} ` +
        `blocked=${driftReport.blocked.length}`
    );
    if (driftReport.blocked.length > 0) {
      logger.warn(
        `[ledger-reconciler] drift ${driftReport.blocked.length} blocked (showing up to 20): ` +
          JSON.stringify(driftReport.blocked.slice(0, 20))
      );
    }
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[ledger-reconciler] replay failed: ${message}`);
  } finally {
    client.release();
  }
}

export const config = { name: "ledger-reconciler", schedule: "*/5 * * * *" };
