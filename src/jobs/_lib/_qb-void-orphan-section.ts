/**
 * Sección del digest para los huérfanos de void (voideado en Medusa, ADD
 * confirmado con TxnID, sin fila de void en el pipeline). El barrido vive en
 * `lib/quickbooks/pipeline/void-orphan-scan.ts` y lo comparte el job
 * `qb-void-reconciler` (cada 15 min → logs); esta sección es la que llega por
 * EMAIL — un warning de log que nadie mira no es una red.
 *
 * Sin dedup ni ventana propia, a propósito: mientras el huérfano exista dentro
 * de la ventana del scan, se repite cada día. El estado estacionario es cero
 * filas; el silencio ya significa limpio.
 *
 * Fail-isolated: cualquier error devuelve null para que el digest salga igual —
 * perder el digest entero por esta sección taparía los errores de pipeline que
 * el digest existe para mostrar. (Filename con `_`: el JobLoader excluye por
 * FILENAME, no por el directorio _lib/.)
 */

import { scanVoidOrphans } from "../../lib/quickbooks/pipeline/void-orphan-scan";

interface SectionRow {
  id: string;
  medusa_ref: string;
  qb_ref: string;
  step: string;
  error: string;
  retries: number;
  status: string;
  created_at: string | Date;
}

export interface VoidOrphanSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

export async function collectVoidOrphanSection(logger: {
  warn: (m: string) => void;
}): Promise<VoidOrphanSection | null> {
  try {
    const rows = await scanVoidOrphans();
    if (rows.length === 0) return null;

    return {
      title: "Voided in POS, still alive in QuickBooks (void orphans)",
      description:
        "These documents were voided in the POS but their QuickBooks document was " +
        "created/confirmed and NO void row exists in the pipeline — the void-before-" +
        "create hook did not cover them. Nothing was auto-enqueued: the database " +
        "alone cannot tell 'never voided in QB' from 'voided by hand outside the " +
        "pipeline'. Verify each one in QuickBooks (/qb-trace) and enqueue the void " +
        "or record it. Repeats daily while the orphan exists.",
      admin_path: "/qb-pipeline",
      rows: rows.map((r) => ({
        id: r.reference_id ?? r.order_id ?? r.qb_txn_id,
        medusa_ref: r.medusa_ref_number ?? r.reference_id ?? r.order_id ?? "",
        qb_ref: r.qb_ref_number ?? r.qb_txn_id,
        step: `${r.create_step} voided in POS, alive in QB`,
        error:
          `The POS document is voided but QB txn ${r.qb_txn_id} was confirmed ` +
          `and no void/TxnDel was ever enqueued for it.`,
        retries: 0,
        status: "void_orphan",
        // WHEN the ADD confirmed — the moment the orphan was born.
        created_at: r.confirmed_at,
      })),
    };
  } catch (err) {
    logger.warn(
      `[qb-void-orphan-section] failed, section omitted from digest: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
