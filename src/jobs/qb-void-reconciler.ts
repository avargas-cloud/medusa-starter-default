/**
 * src/jobs/qb-void-reconciler.ts
 *
 * Red de seguridad para la carrera void-before-create.
 *
 * `pipeline/void-intent.ts` materializa el void en el confirm del ADD, y ese es
 * el camino normal. Pero entre "el ADD confirmó en QuickBooks" y "el hook
 * corrió" hay una ventana: si el proceso muere ahí, o si el hook falla, o si un
 * camino de confirmación futuro se olvida de llamarlo, el documento queda vivo
 * y abierto en QB sin que nada avise. Eso es exactamente lo que pasó con la POS
 * Invoice 21246 / QB 19637 — sólo que ahí la causa fue un camino sin cobertura,
 * y el resultado se descubrió mirando QuickBooks a mano seis horas después.
 *
 * La query vive en `pipeline/void-orphan-scan.ts` y la comparte la sección del
 * digest diario (email): este job es el barrido rápido (15 min → logs), el
 * digest es el que le llega a una persona aunque nadie mire los logs. Cuando
 * cada capa tenía su propia lista de tipos ya divergieron: `payment` no lo
 * miraba nadie y el pago 3420 quedó vivo en QB sin denuncia.
 *
 * ── READ-ONLY a propósito ─────────────────────────────────────────────────────
 * Reporta; NO encola. La primera corrida contra producción explicó por qué:
 * denunció a CM-1090 (QB 18984), y ese credit memo YA estaba voideado en
 * QuickBooks — `TotalAmount 0.00`, memo `VOID: POS Return CM-1090`. Lo que le
 * falta no es el void: le falta la fila de pipeline que lo registre. La DB sola
 * no puede distinguir "nunca se voideó en QB" de "se voideó por fuera del
 * pipeline", así que auto-encolar habría mandado un void contra un documento ya
 * voideado, sobre una premisa no verificada.
 *
 * Confirmarlo exige leer QuickBooks, y una lectura por candidato dentro de un
 * cron serializa el bridge — que es un recurso compartido y lento. El camino
 * rápido y correcto ya existe: el hook del confirm (`void-intent.ts`), que actúa
 * en el único momento en que el estado es inequívoco. Esto es la red para lo que
 * se le escape, y lo que se le escapa merece que lo mire una persona.
 *
 * Es la misma decisión que ya tomó `qb-drift-detector` para la familia de
 * compras: empezar read-only y recién después decidir si el auto-repair es
 * seguro.
 */

import { MedusaContainer } from "@medusajs/framework/types";

import { scanVoidOrphans } from "../lib/quickbooks/pipeline/void-orphan-scan";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[qb-void-reconciler]";

export default async function qbVoidReconciler(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    warn: (m: string) => void;
    info: (m: string) => void;
  };

  try {
    const rows = await scanVoidOrphans();
    if (rows.length === 0) return;

    // Que este job encuentre algo significa que el hook del confirm no lo
    // cubrió: es una señal sobre el CÓDIGO, no sólo sobre los datos. Por eso el
    // mensaje nombra los documentos — para que se puedan verificar contra QB
    // uno por uno (`/qb-trace`) antes de decidir nada.
    const sample = rows
      .slice(0, 10)
      .map(
        (r) =>
          `${r.create_step}:${r.medusa_ref_number ?? r.qb_ref_number ?? r.qb_txn_id}` +
          ` (txn ${r.qb_txn_id})`
      )
      .join(", ");
    logger.warn(
      `${TAG} ${rows.length} documento(s) voideado(s) en Medusa sin fila de void en el pipeline. ` +
        `NO se encoló nada: hay que verificar en QuickBooks si el documento sigue vivo ` +
        `(puede haberse voideado a mano, por fuera del pipeline). ` +
        `${sample}${rows.length > 10 ? " …" : ""}`
    );
  } catch (err) {
    logger.warn(
      `${TAG} barrido falló: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export const config = {
  name: "qb-void-reconciler",
  schedule: "*/15 * * * *",
};
