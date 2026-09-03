/**
 * Secciones 12 y 13 del digest: los dos invariantes de vendor bills que hasta
 * el 2026-09-03 sólo existían como `verify-*` que había que tipear a mano.
 *
 * Los barridos viven en `lib/purchase-orders/vendor-bill-invariant-scans.ts` y
 * los comparten estas secciones con sus scripts `verify-*` — la comparación una
 * sola vez, o el barrido y el reporte terminan sin coincidir en qué es deriva.
 *
 * Sin dedup ni ventana propia, a propósito, igual que la sección de huérfanos de
 * void: mientras el problema exista se repite todos los días. El estado
 * estacionario es cero filas, así que el silencio ya significa limpio.
 *
 * Fail-isolated: cualquier error devuelve null para que el digest salga igual —
 * perder el digest entero por una sección taparía los errores de pipeline que el
 * digest existe para mostrar. (Filename con `_`: el JobLoader excluye por
 * FILENAME, no por el directorio `_lib/`.)
 */

import {
  scanClearingDrift,
  scanLostSiblingBills,
  type ScanKnex,
} from "../../lib/purchase-orders/vendor-bill-invariant-scans";

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

export interface DigestSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * SECCIÓN 12 — un bill secundario cuyo par está COMPLETO y que no tiene
 * documento en QuickBooks.
 *
 * No es un aviso cosmético: el regular ya posteó la expense line NEGATIVA que
 * cancela a este bill, así que el A/P de QuickBooks está corto por exactamente
 * este monto mientras la fila exista. Los que están ESPERANDO a su regular no
 * entran acá — son sanos, y mezclarlos es lo que hacía imposible ver los otros.
 */
export async function collectLostSiblingBillSection(
  knex: ScanKnex,
  logger: { warn: (m: string) => void }
): Promise<DigestSection | null> {
  try {
    const scan = await scanLostSiblingBills(knex);
    if (scan.lost.length === 0) return null;

    return {
      title: `Vendor bills confirmed but never sent to QuickBooks (${money(scan.lost_cents)})`,
      description:
        "These service/freight/tariff bills are confirmed, their regular bill is " +
        "confirmed too, and QuickBooks has no document for them — while the regular " +
        "bill ALREADY posted the negative clearing line that cancels each one. A/P " +
        "in QuickBooks is short by exactly this amount until they post. Nothing was " +
        "auto-enqueued: the database alone cannot tell 'never sent' from 'entered by " +
        "hand outside the pipeline'. Check each one in QuickBooks and re-confirm the " +
        "bill from the POS. Bills correctly WAITING on a draft regular are not " +
        "listed. Repeats daily while any remain.",
      admin_path: "/vendor-bills",
      rows: scan.lost.map((b) => ({
        id: b.vendor_bill_id,
        medusa_ref: b.number ?? b.vendor_bill_id,
        qb_ref: "",
        step: `${b.bill_type} bill missing in QuickBooks`,
        error: `${money(b.total_cents)} — ${b.reason}`,
        retries: 0,
        status: "sibling_bill_lost",
        created_at: new Date(),
      })),
    };
  } catch (err) {
    logger.warn(
      `[qb-pipeline-error-digest] lost-sibling section failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * SECCIÓN 13 — las clearing lines que QuickBooks tiene ya no valen lo que valen
 * los bills hermanos.
 *
 * Es el mismo aviso que muestra la pantalla del bill ("a related bill was edited
 * — this one needs review"), que hasta hoy sólo veía quien abriera ESE bill. La
 * diferencia neta es lo que el A/P de QuickBooks tiene de más o de menos.
 *
 * Se apaga solo cuando el grupo se reconfirma: el BillMod manda los montos vivos
 * y su confirm actualiza la columna.
 */
export async function collectClearingDriftSection(
  knex: ScanKnex,
  logger: { warn: (m: string) => void }
): Promise<DigestSection | null> {
  try {
    const findings = await scanClearingDrift(knex);
    if (findings.length === 0) return null;

    const totalDelta = findings.reduce((sum, f) => sum + f.delta_cents, 0);

    return {
      title: `Vendor bills whose QuickBooks clearing lines are stale (${money(totalDelta)} off)`,
      description:
        "For each of these, a linked service/freight/tariff bill was edited after " +
        "the regular bill was sent to QuickBooks, so the negative clearing line over " +
        "there still cancels the OLD figure and A/P is off by the difference. Fix by " +
        "reopening the regular bill and confirming it — the BillMod re-sends the " +
        "current amounts and its confirm brings our copy back in step. Repeats daily " +
        "while any remain.",
      admin_path: "/vendor-bills",
      rows: findings.map((f) => ({
        id: f.vendor_bill_id,
        medusa_ref: f.number ?? f.vendor_bill_id,
        qb_ref: "",
        step: "clearing lines stale",
        error: f.items
          .map(
            (i) =>
              `${i.kind} ${i.sibling_number ?? "(sibling gone)"}: QuickBooks clears ` +
              `${money(i.quickbooks_cents)}, the bill is ${money(i.current_cents)}`
          )
          .join(" · "),
        retries: 0,
        status: "clearing_drift",
        created_at: new Date(),
      })),
    };
  } catch (err) {
    logger.warn(
      `[qb-pipeline-error-digest] clearing-drift section failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
