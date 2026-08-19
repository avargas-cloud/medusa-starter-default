/**
 * rebuild-skydance-fos
 *
 * The SKYDANCE button (`factory-order-mirror/route.ts`) mirrors a PO's ECTSK
 * (controller) lines into a real Factory Order linked to that PO. It was used
 * for 1 in 9 shipments; the rest were reconciled with manual/legacy FOs that
 * just happened to balance. Owner's absolute truth: China holds NO controller
 * inventory (`ECTSK%` SKUs) — everything that arrives ships out. "Original
 * quantities" on the old ledger were estimates.
 *
 * REV 2 (2026-08-19) — first APPLY run on sandbox hit a real guard:
 * `contra-apply-fo-receipt-stock-step.ts`'s RESERVED_BLOCK refuses to reverse
 * a receipt below what's currently reserved ("stocked=12, reserved=12,
 * reversing 10 would leave 2 stocked, below 12 reserved"). Reordering
 * (create-then-delete) only moves the collision: it permanently strands
 * ECTSK-AM3&4C8A (35 units reserved by PO-1140/IT-1046, which is still at
 * sea, so nothing ever replenishes it) and drives ECTSK-TWDXSP-34C to −1.
 * Owner's new spec, which this revision implements:
 *
 *   1. DELETE every Skydance FO (ANY FO with ≥1 `ECTSK%` line — INCLUDING
 *      FOD-39/PO-1138, no longer spared) — but ONLY the documents (FO,
 *      lines, receipts, receipt lines), via soft-delete SQL. Never touches
 *      `inventory_level`, so the reversal guard never fires because nothing
 *      calls the reversal path.
 *   2. CREATE the real PO→FO mirror, 1:1, for every PO/IT pair carrying
 *      ECTSK lines whose IT is already received in Miami
 *      (`inventory_transfer.received_at IS NOT NULL`): draft → submit →
 *      receive, dated at the PO's `ordered_at` (REV 3, owner 2026-08-19 —
 *      dating at the transfer's Miami `received_at` filed the inflow AFTER
 *      the transfer's `shipped_at` outflow and the China History ledger drew
 *      mid-history negatives; the only legitimate negative is the in-transit
 *      tail. Same policy as the mirrored default in
 *      `factory-orders/:id/receive`).
 *   3. CREATE the mirror in DRAFT (no receive) for every PO/IT pair still in
 *      transit (`received_at IS NULL`).
 *   4. ADJUST every ECTSK SKU's China stock to On Hand = 0, ABSOLUTE (not
 *      incremental), via the same available-basis math as `china-adjustment`.
 *
 * The net is identical to a per-receipt reversal — step 4 lands on 0
 * regardless of what garbage step 1 left in `inventory_level`, because it is
 * an absolute assignment, not a delta on top of a delta — but no step ever
 * calls the code path that owns the guard, so it can't fire.
 *
 * NUMBERING: deleting the 7 manual `FO-####` and 1 `FOD-##` frees those
 * labels. `custom_factory_order_seq`/`custom_fo_draft_seq` only ever advance
 * (`nextval`), so re-issuing a freed number means writing it explicitly
 * (bypassing `nextval`) rather than asking the sequence for it — the
 * sequence never learns a number came back into circulation. The freed set
 * is hard-coded as an audited manifest (REUSED_FO_NUMBERS /
 * REUSED_FOD_NUMBERS) and cross-checked against what step 1 actually deletes
 * at runtime — same "never infer, verify and abort" posture as
 * `repair-china-deduction-gap.ts`'s STOCK_MANIFEST. After all writes, both
 * sequences are bumped (`setval`) to `GREATEST(current position, live max in
 * use)` — a no-op today (verified: sandbox `custom_factory_order_seq` sits at
 * exactly 1033, the top of the reused range, so nothing issued during this
 * run can be ≤ it) but cheap insurance against a future collision.
 *
 * WHY THIS SCRIPT DOES NOT FOLLOW repair-china-deduction-gap's
 * knex.transaction()-then-rollback shape
 * ─────────────────────────────────────────────────────────────────────────
 * That script's dry run works because every write goes through `moveChinaStock`
 * called with the SAME `trx` the script opened — every statement lands on one
 * held connection, so throwing rolls all of it back atomically.
 *
 * Steps 2-3 here MUST go through the real Medusa workflows
 * (`submitFactoryOrderWorkflow`, `receiveFactoryOrderWorkflow`) and the
 * factory-orders module service — reimplementing FO creation/receipt as raw
 * SQL would be a second, divergence-prone copy of logic that already exists.
 * Those workflows resolve their OWN `__pg_connection__` inside each step and
 * write with autocommit; they do not, and structurally cannot, participate in
 * a transaction this script opens on a different held connection. Wrapping
 * the workflow calls in `knex.transaction()` would not make them
 * rollback-able — it would just be decoration around writes that already
 * landed. (Step 1's delete no longer calls a workflow at all — see above —
 * but the same non-atomicity applies to steps 2-3.)
 *
 * So: DRY RUN (APPLY unset) is READ-ONLY. It queries current state and
 * PRINTS the plan — every FO, SKU, quantity and date that would be written —
 * without calling a single mutating workflow/service method. Nothing to
 * roll back because nothing was written. APPLY=true executes steps 1→4
 * in sequence, each step's writes landing for real as soon as it runs (same
 * as an operator clicking through the UI four times); a failure partway
 * through is NOT undone automatically — the console log up to that point is
 * the record of what committed, and re-running with the same flags is safe
 * because every step re-checks live state (SKIP_* lets you resume past a
 * completed step instead of re-deriving what's still needed), INCLUDING the
 * numbering manifest: `dropAlreadyIssued` reconciles the reuse queue against
 * live documents on every run, so a resume after a partial PASO 2 hands the
 * remaining candidates the numbers that are still free and falls through to
 * fresh consecutive ones when the queue runs out.
 *
 * That sentence used to claim the opposite of what the code did — it said a
 * resume would "fall through to fresh consecutive numbers (logged loudly,
 * never silent)". It threw instead, and it threw in production, mid-run, on
 * exactly the resume this file told the reader was covered. A comment that
 * describes a recovery path is load-bearing at the worst possible moment; this
 * one was written from intent rather than from the code.
 *
 * NOTE on step 4's math: china-adjustment-math.ts's `computeChinaAdjustment`
 * takes an AVAILABLE (loose-shelf) count, not stocked, and re-adds
 * committed+in_transit reserved units on top. To land `stocked_quantity` at
 * exactly 0 regardless of what's reserved, feed it `newAvailable = -reserved`
 * (`newStocked = newAvailable + reserved = 0` always, by construction).
 *
 * Run:
 *   env DISABLE_SCHEDULED_JOBS=true \
 *       DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       REDIS_URL="redis://127.0.0.1:6399" \
 *       MEILISEARCH_HOST="http://127.0.0.1:7799" \
 *       MEILISEARCH_API_KEY="sandbox_master_key" \
 *     npx medusa exec ./src/scripts/fix/rebuild-skydance-fos.ts
 *   ... add APPLY=true to write. NEVER against production.
 *   SKIP_DELETE=true / SKIP_CREATE=true / SKIP_DRAFT=true / SKIP_ADJUST=true
 *   disable individual steps.
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { CHINA_LOC, USA_LOC } from "../../lib/locations";
import { FACTORY_ORDERS_MODULE } from "../../modules/factory-orders";
import { FACTORY_ORDER_STOCK_LOCATION_ID } from "../../modules/factory-orders/constants";
import type FactoryOrdersModuleService from "../../modules/factory-orders/service";
import { receiveFactoryOrderWorkflow } from "../../workflows/factory-orders/receive-factory-order";
import { submitFactoryOrderWorkflow } from "../../workflows/factory-orders/submit-factory-order";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";
import {
  resolveManufacturer,
} from "../../api/admin/factory-orders/_lib/po-mirror";
import {
  computeChinaAdjustment,
  loadChinaLevels,
  type ChinaLevel,
} from "../../api/admin/china-adjustment/_lib/china-adjustment-math";

const ECTSK_PREFIX = "ECTSK";
const SCRIPT_ACTOR = "system_rebuild_skydance_fos";

/**
 * Audited manifest of numbers step 1 frees, in the order they get reused —
 * verified against production/sandbox at runtime in `runDeleteStep`; the
 * script aborts rather than reuse a set that no longer matches. Assignment
 * order: FO-#### to PASO 2 candidates chronologically by
 * `inventory_transfer.received_at` ascending (oldest shipment first, same
 * order an operator would have submitted them in); FOD-## to the PASO 3
 * candidate PO-1138 specifically (the one FOD-39 used to mirror).
 */
const REUSED_FO_NUMBERS = [
  "FO-1007",
  "FO-1009",
  "FO-1022",
  "FO-1026",
  "FO-1027",
  "FO-1031",
  "FO-1033",
] as const;
const REUSED_FOD_NUMBERS = ["FOD-39"] as const;

type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
  adjustInventory: (
    inventory_item_id: string,
    location_id: string,
    adjustment: number
  ) => Promise<void>;
}

function assertChina(locationId: string, context: string): void {
  if (locationId !== CHINA_LOC) {
    throw new Error(
      `${context}: refusing to touch a non-China location (${locationId}). Miami (${USA_LOC}) is prohibited.`
    );
  }
}

function assertEctsk(sku: string, context: string): void {
  if (!sku.startsWith(ECTSK_PREFIX)) {
    throw new Error(`${context}: refusing to touch non-ECTSK SKU "${sku}".`);
  }
}

// ── PASO 1 — delete ALL Skydance (ECTSK) FOs, documents only ───────────────

interface SkydanceFo {
  id: string;
  number: string | null;
  draft_number: string | null;
  status: string;
  stock_location_id: string;
  linked_purchase_order_id: string | null;
}
interface FoLineRow {
  id: string;
  sku_snapshot: string;
  qty_ordered: number;
  qty_received: number;
}
interface FoReceiptRow {
  id: string;
  number: string;
  status: string;
}
interface FoReceiptLineRow {
  id: string;
  sku_snapshot: string;
  qty_received_now: number;
}

/** Every live FO with ≥1 ECTSK line, linked or not — "Skydance" per the new spec. */
async function findSkydanceFos(knex: KnexRaw): Promise<SkydanceFo[]> {
  const { rows } = await knex.raw(
    `SELECT DISTINCT fo.id, fo.number, fo.draft_number, fo.status,
            fo.stock_location_id, fo.linked_purchase_order_id
       FROM factory_order fo
       JOIN factory_order_line fol
         ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL
      WHERE fo.deleted_at IS NULL
        AND fo.voided_at IS NULL
        AND fol.sku_snapshot LIKE ?
      ORDER BY fo.number NULLS LAST, fo.draft_number`,
    [`${ECTSK_PREFIX}%`]
  );
  return rows as SkydanceFo[];
}

/**
 * PASO 1 — soft-delete every Skydance FO's documents (header, lines,
 * receipts, receipt lines). Deliberately does NOT call
 * `deleteFactoryOrderReceiptWorkflow` or touch `inventory_level` in any way:
 * that workflow's reversal step is exactly what threw RESERVED_BLOCK on the
 * first APPLY attempt. Step 4 zeroes China absolutely afterward, so whatever
 * this step leaves behind in `stocked_quantity` is irrelevant — it never
 * reads or writes stock.
 */
async function runDeleteStep(
  knex: KnexRaw,
  apply: boolean
): Promise<void> {
  console.log("── PASO 1 — delete ALL Skydance (ECTSK) factory orders (documents only) ──");
  const candidates = await findSkydanceFos(knex);
  if (candidates.length === 0) {
    console.log("  none found — nothing to delete\n");
    return;
  }

  // Validate ALL candidates before touching ANY of them — no partial deletes.
  for (const fo of candidates) {
    assertChina(fo.stock_location_id, `PASO1 ${fo.number ?? fo.draft_number}`);
    const { rows } = await knex.raw(
      `SELECT sku_snapshot FROM factory_order_line
        WHERE factory_order_id = ? AND deleted_at IS NULL AND sku_snapshot NOT LIKE ?`,
      [fo.id, `${ECTSK_PREFIX}%`]
    );
    if (rows.length > 0) {
      throw new Error(
        `PASO1 ABORT: ${fo.number ?? fo.draft_number} has ${rows.length} non-ECTSK line(s) ` +
          `(e.g. "${(rows[0] as { sku_snapshot: string }).sku_snapshot}") — ` +
          `"100% ECTSK" assumption is false. Re-audit before deleting anything (would touch a non-Skydance line).`
      );
    }
  }

  // Cross-check the freed-number manifest against what's actually about to
  // die — "never infer, verify and abort" (see file header). NOTE: the
  // mirror route sets `number` = `draft_number` ("FOD-N") at draft creation
  // and only overwrites it with the real "FO-N" at submit — so `number` on a
  // still-draft candidate (FOD-39) is NOT a submitted FO number and must be
  // excluded from the FO-#### manifest check.
  const freedFoNumbers = candidates
    .map((f) => f.number)
    .filter((n): n is string => !!n && n.startsWith("FO-"))
    .sort();
  const freedFodNumbers = candidates.map((f) => f.draft_number).filter((n): n is string => !!n);
  const expectedFo = [...REUSED_FO_NUMBERS].sort();
  if (JSON.stringify(freedFoNumbers) !== JSON.stringify(expectedFo)) {
    throw new Error(
      `PASO1 ABORT: freed FO-#### numbers are [${freedFoNumbers.join(", ")}], ` +
        `manifest expected [${expectedFo.join(", ")}] — production has moved, re-audit REUSED_FO_NUMBERS.`
    );
  }
  for (const fod of REUSED_FOD_NUMBERS) {
    if (!freedFodNumbers.includes(fod)) {
      throw new Error(
        `PASO1 ABORT: expected to free draft number ${fod}, but it's not among the deleted FOs' draft_number ` +
          `(saw [${freedFodNumbers.join(", ")}]) — re-audit REUSED_FOD_NUMBERS.`
      );
    }
  }
  console.log(
    `  verified ${candidates.length} FO(s) are 100% ECTSK, freed numbers match manifest: ` +
      `${candidates.map((f) => f.number ?? f.draft_number).join(", ")}`
  );

  let unitsLeftInChina = 0;
  for (const fo of candidates) {
    const label = fo.number ?? fo.draft_number;
    const lines = (await knex.raw(
      `SELECT id, sku_snapshot, qty_ordered, qty_received FROM factory_order_line
        WHERE factory_order_id = ? AND deleted_at IS NULL`,
      [fo.id]
    ).then((r) => r.rows)) as FoLineRow[];

    const receipts = (await knex.raw(
      `SELECT id, number, status FROM factory_order_receipt
        WHERE factory_order_id = ? AND deleted_at IS NULL`,
      [fo.id]
    ).then((r) => r.rows)) as FoReceiptRow[];

    for (const line of lines) {
      console.log(
        `  doc-delete  ${label} ${line.sku_snapshot.padEnd(20)} qty_received=${line.qty_received}/${line.qty_ordered}`
      );
    }

    for (const receipt of receipts) {
      const rLines = (await knex.raw(
        `SELECT id, sku_snapshot, qty_received_now
           FROM factory_order_receipt_line
          WHERE factory_order_receipt_id = ? AND deleted_at IS NULL`,
        [receipt.id]
      ).then((r) => r.rows)) as FoReceiptLineRow[];

      for (const rl of rLines) {
        assertEctsk(rl.sku_snapshot, `PASO1 ${label}/${receipt.number}`);
        console.log(
          `  doc-delete  ${label} ${receipt.number} ${rl.sku_snapshot.padEnd(20)} qty=${rl.qty_received_now} (stock left AS-IS — PASO4 zeroes absolutely)`
        );
        unitsLeftInChina += rl.qty_received_now;
      }

      if (apply) {
        await knex.raw(
          `UPDATE factory_order_receipt_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE factory_order_receipt_id = ? AND deleted_at IS NULL`,
          [receipt.id]
        );
        await knex.raw(
          `UPDATE factory_order_receipt SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ? AND deleted_at IS NULL`,
          [receipt.id]
        );
        console.log(`    → ${label} ${receipt.number} soft-deleted (receipt + receipt lines)`);
      }
    }

    if (apply) {
      await knex.raw(
        `UPDATE factory_order_line SET deleted_at = NOW(), updated_at = NOW()
          WHERE factory_order_id = ? AND deleted_at IS NULL`,
        [fo.id]
      );
      await knex.raw(
        `UPDATE factory_order
            SET deleted_at = NOW(), updated_at = NOW(),
                status = 'cancelled', cancelled_at = NOW(),
                cancelled_by_user_id = ?, cancel_reason = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [
          SCRIPT_ACTOR,
          "rebuild-skydance-fos v2: superseded by 1:1 real PO→FO mirror",
          fo.id,
        ]
      );
      console.log(`    → ${label} soft-deleted (header + lines)`);
    }
  }

  console.log(
    `  PASO 1 summary: ${candidates.length} FO(s) deleted (docs only), ${unitsLeftInChina} unit(s) left in China stock for PASO 4 to zero\n`
  );
}

// ── PASO 2 / 3 — mirror PO→FO ───────────────────────────────────────────────

interface PoHeader {
  id: string;
  number: string | null;
  vendor_id: string;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  shipping_method: string | null;
  payment_terms: string | null;
}
interface PoEctskLine {
  po_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  line_order: number;
}
interface Candidate {
  po: PoHeader;
  it_number: string;
  received_at: string | null;
  lines: PoEctskLine[];
}

async function findCandidatePos(
  knex: KnexRaw,
  receivedFilter: "received" | "in_transit"
): Promise<Candidate[]> {
  const receivedClause =
    receivedFilter === "received" ? "it.received_at IS NOT NULL" : "it.received_at IS NULL";

  const { rows: poRows } = await knex.raw(
    `SELECT po.id, po.number, po.vendor_id, po.vendor_name_snapshot,
            po.vendor_qb_list_id_snapshot, po.ordered_at, po.expected_at,
            po.shipping_method, po.payment_terms,
            it.number AS it_number, it.received_at, it.shipped_at
       FROM purchase_order po
       JOIN inventory_transfer it
         ON it.linked_purchase_order_id = po.id AND it.deleted_at IS NULL
      WHERE po.deleted_at IS NULL
        AND ${receivedClause}
        AND EXISTS (
          SELECT 1 FROM purchase_order_line pol
           WHERE pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
             AND pol.sku_snapshot LIKE ?
             AND COALESCE(pol.status, 'open') <> 'cancelled'
             AND (pol.qty_ordered - COALESCE(pol.qty_cancelled, 0)) > 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM factory_order fo
           WHERE fo.linked_purchase_order_id = po.id AND fo.deleted_at IS NULL
        )
      ORDER BY po.number`,
    [`${ECTSK_PREFIX}%`]
  );

  const out: Candidate[] = [];
  for (const po of poRows as Array<PoHeader & { it_number: string; received_at: string | null; shipped_at: string | null }>) {
    const { rows: lineRows } = await knex.raw(
      `SELECT pol.id AS po_line_id, pol.product_variant_id, pol.inventory_item_id,
              pol.sku_snapshot AS sku, pol.description_snapshot AS description,
              GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) AS qty,
              pol.unit_cost_cents, COALESCE(pol.line_order, 0) AS line_order
         FROM purchase_order_line pol
        WHERE pol.purchase_order_id = ?
          AND pol.deleted_at IS NULL
          AND pol.sku_snapshot LIKE ?
          AND COALESCE(pol.status, 'open') <> 'cancelled'
        ORDER BY COALESCE(pol.line_order, 0) ASC, pol.id ASC`,
      [po.id, `${ECTSK_PREFIX}%`]
    );
    const lines = (lineRows as Array<PoEctskLine & { qty: number | string; unit_cost_cents: number | string; line_order: number | string }>)
      .map((l) => ({
        ...l,
        qty: Number(l.qty),
        unit_cost_cents: Number(l.unit_cost_cents),
        line_order: Number(l.line_order),
      }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) continue;
    out.push({
      po: {
        id: po.id,
        number: po.number,
        vendor_id: po.vendor_id,
        vendor_name_snapshot: po.vendor_name_snapshot,
        vendor_qb_list_id_snapshot: po.vendor_qb_list_id_snapshot,
        ordered_at: po.ordered_at,
        expected_at: po.expected_at,
        shipping_method: po.shipping_method,
        payment_terms: po.payment_terms,
      },
      it_number: po.it_number,
      received_at: po.received_at,
      shipped_at: po.shipped_at,
      lines,
    });
  }
  return out;
}

/**
 * La fecha CANONICA del documento: el FO y su receipt comparten una sola, y
 * sale del PO.
 *
 * Un FO espejado no es una compra nueva: documenta mercaderia que la fabrica ya
 * entrego contra un PO viejo. Fecharlo el dia en que alguien apreto el boton
 * archiva la ENTRADA despues de los transfers que ya se llevaron esas unidades,
 * y el ledger de China History —que ordena receipts por `received_at` y
 * transfers por `shipped_at`— dibuja un hundimiento a mitad de historia que la
 * bodega nunca tuvo. El unico negativo legitimo es la cola de lo que sigue
 * navegando.
 *
 * Fallback al `shipped_at` del IT, nunca a hoy: dos POs viejos no tienen
 * `ordered_at`, y la mercaderia estuvo en China antes de salir, asi que la
 * fecha de embarque es historica y correcta. `new Date()` reintroduciria
 * exactamente el defecto que esta funcion existe para cerrar.
 */
function foDocumentDate(c: Candidate): Date {
  if (c.po.ordered_at) return new Date(c.po.ordered_at);
  if (c.shipped_at) return new Date(c.shipped_at);
  throw new Error(
    `${c.po.number}: sin ordered_at del PO ni shipped_at del IT — no hay fecha historica que usar, y fechar hoy romperia el orden del ledger.`
  );
}

/**
 * Drop from the reuse queue every number a live document already holds.
 *
 * WHY THIS EXISTS (production, 2026-08-19). The queue is consumed positionally
 * (`.shift()` per candidate), so it only lines up with the candidate list on a
 * FULL run. Production's first APPLY died partway through PASO 2 with 7 of 15
 * FOs written; on resume those 7 POs dropped out of the candidate list (they
 * now have a live FO) but their numbers were still queued, so candidate #8 was
 * handed `FO-1007` — already issued, an hour earlier, by this same script.
 *
 * `assertNumberFree` caught it and aborted, which is the outcome it was written
 * for. But aborting is the wrong END state for a script with no rollback: the
 * only way forward was to hand-edit the manifest, and a resume that needs
 * hand-editing is a resume that will be gotten wrong at 2am. Reconciling the
 * queue against live state makes the resume converge on its own, and it costs
 * nothing on a clean run — nothing is issued yet, so nothing is dropped.
 *
 * This does NOT soften the guard. `assertNumberFree` still runs before every
 * write; what changes is that it now only fires for a number taken by
 * something OTHER than this script's own completed work, which is the case it
 * actually needs to stop.
 */
async function dropAlreadyIssued(
  knex: KnexRaw,
  column: "number" | "draft_number",
  queue: string[]
): Promise<string[]> {
  if (queue.length === 0) return queue;
  // One `?` per element rather than `= ANY(?)`: knex expands an array binding
  // into a comma-separated list, which is what `IN (...)` wants and what
  // `ANY(...)` does NOT — the latter needs a single array parameter and would
  // silently take only the first value.
  const placeholders = queue.map(() => "?").join(", ");
  const { rows } = await knex.raw(
    `SELECT ${column} AS n FROM factory_order
      WHERE ${column} IN (${placeholders}) AND deleted_at IS NULL`,
    queue
  );
  const taken = new Set((rows as { n: string }[]).map((r) => r.n));
  if (taken.size === 0) return queue;
  const remaining = queue.filter((n) => !taken.has(n));
  console.log(
    `  reuse queue (${column}): ${taken.size} number(s) already issued by an earlier ` +
      `partial run — [${[...taken].join(", ")}]; ${remaining.length} still free ` +
      `[${remaining.join(", ") || "none"}]`
  );
  return remaining;
}

/** Throws if a live FO already holds `value` in `column` — guards number reuse. */
async function assertNumberFree(knex: KnexRaw, column: "number" | "draft_number", value: string): Promise<void> {
  const { rows } = await knex.raw(
    `SELECT id FROM factory_order WHERE ${column} = ? AND deleted_at IS NULL`,
    [value]
  );
  if (rows.length > 0) {
    throw new Error(
      `Refusing to reuse ${column}="${value}": a live factory_order already holds it (id=${(rows[0] as { id: string }).id}). ` +
        `PASO1 may not have actually run — did SKIP_DELETE=true slip in?`
    );
  }
}

async function createDraftFo(
  knex: KnexRaw,
  foService: FactoryOrdersModuleService,
  candidate: Candidate,
  reusedDraftNumber: string | null,
  manufacturer: { id: string; qb_list_id: string; name: string; short_name: string }
): Promise<{ id: string; lineIds: Map<string, string> }> {
  let draftNumber: string;
  if (reusedDraftNumber) {
    await assertNumberFree(knex, "draft_number", reusedDraftNumber);
    draftNumber = reusedDraftNumber;
  } else {
    const draftSeq = await foService.getNextDraftSequence();
    draftNumber = `FOD-${draftSeq}`;
  }
  const subtotal = candidate.lines.reduce((s, l) => s + l.qty * l.unit_cost_cents, 0);

  const [fo] = await foService.createFactoryOrders([
    {
      status: "draft",
      // Matches factory-order-mirror/route.ts's create action: `number` is
      // set to the draft label at creation time and only overwritten with
      // the real "FO-N" at submit. A NULL `number` on a live draft is what
      // verify-skydance-fo-parity.ts's truthiness check (`!r.fo`) reads as
      // "no mirrored FO exists" — leaving it unset here made a real,
      // correctly-linked draft FO invisible to that check.
      number: draftNumber,
      draft_number: draftNumber,
      seq: null,
      vendor_id: candidate.po.vendor_id,
      vendor_name_snapshot: candidate.po.vendor_name_snapshot,
      vendor_list_id_snapshot: candidate.po.vendor_qb_list_id_snapshot,
      stock_location_id: FACTORY_ORDER_STOCK_LOCATION_ID,
      ordered_at: foDocumentDate(candidate),
      expected_at: candidate.po.expected_at ? new Date(candidate.po.expected_at) : null,
      memo: `ECTSK controllers from ${candidate.po.number ?? candidate.po.id} (rebuild-skydance-fos)`,
      shipping_method: candidate.po.shipping_method,
      payment_terms: candidate.po.payment_terms,
      linked_purchase_order_id: candidate.po.id,
      // El manufacturer NO es una columna: vive en metadata, y es lo que la
      // pantalla del FO lee para mostrar "MANUFACTURER: SKYDANCE" junto al
      // vendor Veetech. La primera version de este script escribia
      // `{ source: … }` y perdia las cuatro claves, asi que los 17 FOs salian
      // sin manufacturer — invisible para el verificador y visible para el
      // dueño en la primera pantalla que abrio. Las claves y su forma salen de
      // `resolveManufacturer`, el MISMO resolvedor que usa el boton, para que
      // no puedan divergir otra vez.
      metadata: {
        manufacturer_vendor_id: manufacturer.id,
        manufacturer_vendor_name: manufacturer.name,
        manufacturer_vendor_short_name: manufacturer.short_name,
        manufacturer_vendor_qb_list_id: manufacturer.qb_list_id,
        source: "rebuild-skydance-fos",
      },
      subtotal_cents: subtotal,
      tax_cents: 0,
      shipping_cents: 0,
      other_fees_cents: 0,
      total_cents: subtotal,
      total_lines: candidate.lines.length,
      total_units_ordered: candidate.lines.reduce((s, l) => s + l.qty, 0),
      created_by_user_id: SCRIPT_ACTOR,
    },
  ] as never);
  const foRow = fo as unknown as { id: string };

  const created = (await foService.createFactoryOrderLines(
    candidate.lines.map((l, i) => ({
      factory_order_id: foRow.id,
      purchase_order_line_id: l.po_line_id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku_snapshot: l.sku,
      description_snapshot: l.description,
      qty_ordered: l.qty,
      qty_received: 0,
      qty_cancelled: 0,
      unit_cost_cents: l.unit_cost_cents,
      tax_cents: 0,
      total_cents: l.qty * l.unit_cost_cents,
      status: "open",
      line_order: l.line_order ?? i,
      notes: null,
    })) as never
  )) as unknown as Array<{ id: string; purchase_order_line_id: string }>;

  const lineIds = new Map(created.map((c) => [c.purchase_order_line_id, c.id]));
  return { id: foRow.id, lineIds };
}

async function runCreateStep(
  knex: KnexRaw,
  foService: FactoryOrdersModuleService,
  container: MedusaContainer,
  apply: boolean,
  mode: "received" | "in_transit",
  reusedFoNumbers: string[],
  reusedFodNumbers: string[]
): Promise<void> {
  const label = mode === "received" ? "PASO 2 — mirror + receive (shipped & received)" : "PASO 3 — mirror as DRAFT (in transit)";
  console.log(`── ${label} ──`);

  // El mismo resolvedor que usa el boton Skydance. Resolverlo (en vez de
  // hardcodear el ListID) es lo que impide que esto vuelva a divergir del
  // documento que el operador ve en pantalla.
  const resolution = await resolveManufacturer(knex as never, "SKYDANCE");
  if (!resolution.ok) {
    throw new Error(
      `No se pudo resolver el manufacturer SKYDANCE (${resolution.code}) — sin eso los FOs saldrian sin manufacturer.`
    );
  }
  // El mismo mapeo que hace el boton (`factory-order-mirror/route.ts:132`):
  // el resolvedor devuelve `display_name` y el metadata guarda `name`.
  const manufacturer = {
    id: resolution.vendor.id,
    qb_list_id: resolution.vendor.qb_list_id,
    name: resolution.vendor.display_name,
    short_name: resolution.vendor.short_name,
  };
  console.log(
    `  manufacturer: ${manufacturer.name} (${manufacturer.id}, QB ${manufacturer.qb_list_id})`
  );
  const candidates = await findCandidatePos(knex, mode);
  if (candidates.length === 0) {
    console.log("  none found\n");
    return;
  }

  for (const c of candidates) {
    assertChina(FACTORY_ORDER_STOCK_LOCATION_ID, `PASO${mode === "received" ? 2 : 3} ${c.po.number}`);
    const totalUnits = c.lines.reduce((s, l) => s + l.qty, 0);
    const reusedFo = mode === "received" ? (reusedFoNumbers.shift() ?? null) : null;
    const reusedFod = mode === "in_transit" ? (reusedFodNumbers.shift() ?? null) : null;
    console.log(
      `  create  ${c.po.number} (${c.it_number}${c.received_at ? `, received ${c.received_at}` : ", in transit"}) — ` +
        `${c.lines.length} line(s), ${totalUnits} unit(s) — number: ${reusedFo ?? reusedFod ?? "next in sequence"}`
    );
    for (const l of c.lines) {
      console.log(`    line   ${l.sku.padEnd(20)} qty=${l.qty} @${(l.unit_cost_cents / 100).toFixed(2)}`);
    }

    if (!apply) continue;

    const { id: foId, lineIds } = await createDraftFo(knex, foService, c, reusedFod, manufacturer);
    console.log(`    → draft FO created (${foId})${reusedFod ? `, reused draft_number ${reusedFod}` : ""}`);

    if (mode === "in_transit") {
      console.log(`    → left in DRAFT — no receive`);
      continue;
    }

    if (reusedFo) {
      // Pin the reused number BEFORE submit — allocateFoSequenceStep's
      // idempotent branch (existing.seq != null && number startsWith "FO-")
      // then reuses it as-is instead of calling nextval().
      await assertNumberFree(knex, "number", reusedFo);
      const seq = Number(reusedFo.replace("FO-", ""));
      await knex.raw(
        `UPDATE factory_order SET seq = ?, number = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL AND status = 'draft'`,
        [seq, reusedFo, foId]
      );
    }

    const { result: submitted } = await submitFactoryOrderWorkflow(container).run({
      input: { fo_id: foId, submitted_by_user_id: SCRIPT_ACTOR },
    });
    console.log(`    → submitted as ${submitted.number}${reusedFo ? " (reused)" : " (next in sequence)"}`);

    if (!c.received_at) {
      throw new Error(`PASO2 ${c.po.number}: linked IT has no received_at — should have been filtered out`);
    }

    // El receipt del espejo se fecha con la FECHA DEL PO (fo.ordered_at =
    // po.ordered_at), NUNCA con el received_at de Miami del transfer: Miami
    // recibe SIEMPRE después de que el IT salió de China (que resta al
    // shipped_at), así que fechar el ingreso al día de Miami lo archiva
    // DESPUÉS del egreso y el ledger de China History dibuja un negativo en
    // el medio que el warehouse nunca tuvo (owner, 2026-08-19; misma política
    // que el default de POST /factory-orders/:id/receive para espejados y su
    // E2E e2e-fo-receipt-inherits-po-date-sandbox). El único negativo legítimo
    // es la cola por in-transit sin recibir. `received_at` del IT queda solo
    // como guard de elegibilidad (el par ya llegó), no como fecha.
    // UNA sola fecha para el documento y su receipt: la del PO. Si el PO no
    // la trae (2 POs viejos), el embarque del IT — la mercaderia estuvo en
    // China antes de salir, asi que esa fecha es historica y correcta. NUNCA
    // `new Date()`: fechar hoy archiva el ingreso despues de los egresos que
    // alimenta y el ledger dibuja un negativo que la bodega nunca tuvo.
    const receiptDate = foDocumentDate(c);

    const workflowLines = c.lines.map((l) => {
      const foLineId = lineIds.get(l.po_line_id);
      if (!foLineId) {
        throw new Error(`PASO2 ${c.po.number}: created FO line missing for PO line ${l.po_line_id}`);
      }
      return {
        fo_line_id: foLineId,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku,
        description_snapshot: l.description,
        qty_received_now: l.qty,
        unit_cost_cents_effective: l.unit_cost_cents,
        unit_cost_cents_override: null,
      };
    });

    const { result: received } = await receiveFactoryOrderWorkflow(container).run({
      input: {
        fo_id: foId,
        fo_number: submitted.number,
        received_by_user_id: SCRIPT_ACTOR,
        stock_location_id: FACTORY_ORDER_STOCK_LOCATION_ID,
        received_at: receiptDate,
        notes: `Mirrors ${c.po.number} / ${c.it_number} (rebuild-skydance-fos)`,
        lines: workflowLines,
      },
    });
    console.log(
      `    → received ${received.receipt_number}, fo_status_after=${received.fo_status_after}, total_units_received=${received.total_units_received}`
    );
  }
  console.log("");
}

// ── PASO 4 — zero out China ECTSK stock ─────────────────────────────────────

async function runAdjustStep(
  knex: KnexRaw,
  inventoryService: InventoryServiceLike,
  apply: boolean
): Promise<string[]> {
  console.log("── PASO 4 — zero China ECTSK stock (On Hand → 0) ──");

  const { rows } = await knex.raw(
    `SELECT il.inventory_item_id, ii.sku, il.stocked_quantity::int AS stocked,
            il.reserved_quantity::int AS reserved
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
      WHERE il.location_id = ? AND il.deleted_at IS NULL
        AND ii.sku LIKE ? AND il.stocked_quantity <> 0
      ORDER BY ii.sku`,
    [CHINA_LOC, `${ECTSK_PREFIX}%`]
  );
  const targets = rows as Array<{
    inventory_item_id: string;
    sku: string;
    stocked: number;
    reserved: number;
  }>;

  if (targets.length === 0) {
    console.log("  every ECTSK SKU already at On Hand = 0\n");
    return [];
  }

  console.log(`  PRE-STATE (China, ${targets.length} SKU(s) non-zero — save this to revert):`);
  for (const t of targets) {
    console.log(
      `    ${t.sku.padEnd(20)} stocked=${t.stocked} reserved=${t.reserved} inventory_item_id=${t.inventory_item_id}`
    );
  }

  const itemIds = targets.map((t) => t.inventory_item_id);
  const levels = await loadChinaLevels(knex, inventoryService, CHINA_LOC, itemIds);

  const applied: Array<{ sku: string; item: string; delta: number }> = [];
  for (const t of targets) {
    assertEctsk(t.sku, "PASO4");
    const level = levels.get(t.inventory_item_id) as ChinaLevel;
    const reserved = level.committed + level.in_transit;
    const math = computeChinaAdjustment(level, -reserved);
    console.log(
      `  zero    ${t.sku.padEnd(20)} stocked ${level.stocked} → ${math.newStocked} (delta ${math.delta >= 0 ? "+" : ""}${math.delta}, reserved=${reserved})`
    );
    if (math.newStocked !== 0) {
      throw new Error(`PASO4 ${t.sku}: math produced newStocked=${math.newStocked}, expected 0 — aborting`);
    }
    if (math.delta !== 0) applied.push({ sku: t.sku, item: t.inventory_item_id, delta: math.delta });
  }

  if (!apply) {
    console.log(`  PASO 4 summary (planned): ${applied.length} SKU(s), ${applied.reduce((s, a) => s + Math.abs(a.delta), 0)} unit(s) net\n`);
    return applied.map((a) => a.item);
  }

  for (const a of applied) {
    assertChina(CHINA_LOC, `PASO4 ${a.sku}`);
    await inventoryService.adjustInventory(a.item, CHINA_LOC, a.delta);
  }

  // NO se crea un `china_adjustment`, y es deliberado.
  //
  // Un China Adjustment significa "alguien contó el estante y encontró una
  // diferencia". Eso no fue lo que pasó: las cantidades originales del ledger
  // eran ESTIMACIONES cargadas antes de que existiera el dato real. Emitir el
  // documento le pone al historial un evento de conteo que nunca ocurrió, y
  // encima lo deja como última fila —después de todos los movimientos reales—
  // como si la bodega se hubiera vaciado hoy.
  //
  // La `Cantidad Original` que muestra el modal NO es un dato guardado: sale de
  // `beginning_balance = physical_china − netSince` en china-product-history.
  // Al mover el stock sin emitir el documento, esa resta absorbe la corrección
  // sola y el saldo inicial pasa a decir la verdad — que es exactamente lo que
  // había que corregir. El movimiento de inventario sigue yendo por
  // `adjustInventory` del módulo, así que la columna numérica y su `raw_`
  // siguen moviéndose juntas.
  //
  // Lo que se pierde: no queda un documento navegable para esta corrección. El
  // rastro es el log de esta corrida y el estado previo que imprime más arriba.
  console.log(
    `  PASO 4 applied: ${applied.length} SKU(s) zeroed — sin documento de ajuste ` +
      `(la Cantidad Original derivada absorbe la corrección; ver el estado previo arriba)\n`
  );
  return applied.map((a) => a.item);
}

async function reportRemaining(knex: KnexRaw, apply: boolean): Promise<void> {
  const { rows } = await knex.raw(
    `SELECT ii.sku, il.stocked_quantity::int AS stocked
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
      WHERE il.location_id = ? AND il.deleted_at IS NULL
        AND ii.sku LIKE ? AND il.stocked_quantity <> 0
      ORDER BY ii.sku`,
    [CHINA_LOC, `${ECTSK_PREFIX}%`]
  );
  const remaining = rows as Array<{ sku: string; stocked: number }>;
  console.log(`── Final check — ECTSK SKUs with On Hand ≠ 0 in China: ${remaining.length} ──`);
  for (const r of remaining) console.log(`    ${r.sku.padEnd(20)} stocked=${r.stocked}`);
  if (apply && remaining.length > 0) {
    throw new Error(
      `FAILURE: ${remaining.length} ECTSK SKU(s) still have On Hand ≠ 0 after APPLY=true ` +
        `(${remaining.map((r) => `${r.sku}=${r.stocked}`).join(", ")}). ` +
        `Do not trust the China ledger until this is 0.`
    );
  } else if (!apply) {
    console.log(
      `  (dry run: this is the CURRENT live count, not a post-repair projection — ` +
        `steps 1-3 write nothing in dry run, see file header)`
    );
  } else {
    console.log(`  PASS — 0 ECTSK SKUs with On Hand ≠ 0`);
  }
}

/**
 * `custom_factory_order_seq`/`custom_fo_draft_seq` only advance; reusing a
 * freed number never calls `nextval`, so the sequence itself doesn't know
 * anything came back. Bump both to `GREATEST(current position, live max in
 * use)` — a no-op if everything issued this run stayed above the reused
 * range (expected, see file header), but cheap insurance against a future
 * collision if that assumption ever stops holding.
 */
async function bumpSequences(knex: KnexRaw): Promise<void> {
  const before = await knex.raw(
    `SELECT (SELECT last_value FROM custom_factory_order_seq) AS fo,
            (SELECT last_value FROM custom_fo_draft_seq) AS fod`
  );
  const { fo: foBefore, fod: fodBefore } = before.rows[0] as { fo: number; fod: number };

  const foMax = await knex.raw(
    `SELECT COALESCE(MAX((regexp_replace(number, 'FO-', ''))::int), 0) AS max
       FROM factory_order WHERE number LIKE 'FO-%' AND deleted_at IS NULL`
  );
  const fodMax = await knex.raw(
    `SELECT COALESCE(MAX((regexp_replace(draft_number, 'FOD-', ''))::int), 0) AS max
       FROM factory_order WHERE draft_number LIKE 'FOD-%' AND deleted_at IS NULL`
  );
  const foTarget = Math.max(Number((foMax.rows[0] as { max: number }).max), Number(foBefore));
  const fodTarget = Math.max(Number((fodMax.rows[0] as { max: number }).max), Number(fodBefore));

  await knex.raw(`SELECT setval('custom_factory_order_seq', ?)`, [foTarget]);
  await knex.raw(`SELECT setval('custom_fo_draft_seq', ?)`, [fodTarget]);

  console.log(
    `── Sequences bumped ──\n` +
      `  custom_factory_order_seq: ${foBefore} → ${foTarget}\n` +
      `  custom_fo_draft_seq:      ${fodBefore} → ${fodTarget}\n`
  );
}

/**
 * PASO 0 — borrar las lineas de ajuste de China que tocan controladores.
 *
 * Un `china_adjustment` significa "alguien conto el estante y encontro una
 * diferencia". Sobre controladores eso nunca fue cierto: las cantidades
 * originales del ledger eran estimaciones, no conteos. Mientras esas lineas
 * existan entran en `netSince`, asi que la Cantidad Original derivada no puede
 * dar 0 — hoy deja a ECTSK-RFRC3C4A y ECTSK-TWDXSP-34C en 1 por un -1 cada uno.
 *
 * Se borran LINEAS, no documentos: un ajuste puede mezclar controladores con
 * otros SKUs, y esos no son nuestros. Un documento que se queda sin lineas se
 * borra tambien, para no dejar un encabezado huerfano en el listado.
 *
 * NO revierte stock: el PASO 4 fija el valor absoluto despues, asi que
 * revertir aca seria un movimiento que el paso siguiente pisa igual.
 */
async function runAdjustmentCleanupStep(knex: KnexRaw, apply: boolean): Promise<void> {
  console.log("── PASO 0 — borrar lineas de ajuste de China sobre controladores ──");

  const { rows } = await knex.raw(
    `SELECT cl.id, cl.china_adjustment_id, cl.sku, cl.delta, ca.notes,
            to_char(ca.created_at, 'YYYY-MM-DD') AS fecha
       FROM china_adjustment_line cl
       JOIN china_adjustment ca ON ca.id = cl.china_adjustment_id AND ca.voided_at IS NULL
      WHERE cl.sku LIKE ?
      ORDER BY ca.created_at`,
    [`${ECTSK_PREFIX}%`]
  );
  const lines = rows as Array<{
    id: string;
    china_adjustment_id: string;
    sku: string;
    delta: number;
    notes: string | null;
    fecha: string;
  }>;

  if (lines.length === 0) {
    console.log("  ninguna — nada que limpiar\n");
    return;
  }

  for (const l of lines) {
    console.log(
      `  delete  ${l.fecha}  ${l.sku.padEnd(20)} delta=${l.delta}  (${l.notes ?? "sin nota"})`
    );
  }

  if (!apply) {
    console.log(`  PASO 0 summary (planned): ${lines.length} linea(s)\n`);
    return;
  }

  const ids = lines.map((l) => l.id);
  await knex.raw(`DELETE FROM china_adjustment_line WHERE id = ANY(?)`, [ids]);

  // Encabezados que quedaron sin ninguna linea.
  const { rows: emptied } = await knex.raw(
    `DELETE FROM china_adjustment ca
      WHERE ca.id = ANY(?)
        AND NOT EXISTS (
          SELECT 1 FROM china_adjustment_line cl WHERE cl.china_adjustment_id = ca.id
        )
      RETURNING ca.id`,
    [Array.from(new Set(lines.map((l) => l.china_adjustment_id)))]
  );
  console.log(
    `  PASO 0 applied: ${lines.length} linea(s) borradas, ${(emptied as unknown[]).length} documento(s) que quedaron vacios\n`
  );
}

/**
 * PASO 5 — resincronizar el indice de los items tocados.
 *
 * El PASO 4 mueve stock por `adjustInventory` del modulo, que no dispara el
 * sync inline. En produccion el reconciler lo curaria en ~1 minuto, pero
 * durante ese minuto /china-inventory —que lee MeiliSearch, no Postgres—
 * mostraria centenares de unidades que ya no existen, y quien mire justo ahi
 * saca una conclusion falsa sobre stock disponible. En el sandbox no se cura
 * nunca, porque corre con los crons apagados.
 *
 * Se sincroniza item por item con el MISMO workflow que usan los triggers, en
 * vez de un reindex completo: alcanza con los que se tocaron y no arrastra los
 * otros 2.600 productos.
 */
async function runReindexStep(
  container: MedusaContainer,
  itemIds: string[],
  apply: boolean
): Promise<void> {
  console.log("── PASO 5 — resincronizar MeiliSearch de los items tocados ──");
  if (itemIds.length === 0) {
    console.log("  ninguno\n");
    return;
  }
  console.log(`  ${itemIds.length} inventory_item(s)`);
  if (!apply) {
    console.log("  PASO 5 (planned): sin escribir\n");
    return;
  }
  let ok = 0;
  const failed: string[] = [];
  for (const inventoryItemId of itemIds) {
    try {
      await syncInventoryItemToMeiliSearchWorkflow(container).run({
        input: { inventoryItemId },
      });
      ok++;
    } catch (e) {
      failed.push(inventoryItemId);
    }
  }
  // No fatal: el indice desactualizado es peor pantalla, no datos rotos — y el
  // reconciler de produccion lo terminaria curando. Se avisa fuerte para que
  // nadie lo lea como "todo listo".
  console.log(`  PASO 5 applied: ${ok} sincronizado(s)${failed.length ? `, ${failed.length} FALLARON — corre scripts/sandbox/reindex.sh o el force-reindex de prod` : ""}\n`);
}

export default async function rebuildSkydanceFos({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const apply = process.env.APPLY === "true";
  const doCleanup = process.env.SKIP_CLEANUP !== "true";
  const doDelete = process.env.SKIP_DELETE !== "true";
  const doCreate = process.env.SKIP_CREATE !== "true";
  const doDraft = process.env.SKIP_DRAFT !== "true";
  const doAdjust = process.env.SKIP_ADJUST !== "true";

  console.log(
    `rebuild-skydance-fos — ${apply ? "APPLY (writes commit as each step runs)" : "DRY RUN (read-only, nothing written)"}` +
      ` · cleanup=${doCleanup} delete=${doDelete} create=${doCreate} draft=${doDraft} adjust=${doAdjust}\n`
  );

  const knex = container.resolve("__pg_connection__") as KnexRaw;
  const foService = container.resolve(
    FACTORY_ORDERS_MODULE
  ) as unknown as FactoryOrdersModuleService;
  const inventoryService = container.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike;

  const reusedFoNumbers = await dropAlreadyIssued(knex, "number", [...REUSED_FO_NUMBERS]);
  const reusedFodNumbers = await dropAlreadyIssued(knex, "draft_number", [...REUSED_FOD_NUMBERS]);

  if (doCleanup) await runAdjustmentCleanupStep(knex, apply);
  if (doDelete) await runDeleteStep(knex, apply);
  if (doCreate) {
    await runCreateStep(knex, foService, container, apply, "received", reusedFoNumbers, reusedFodNumbers);
  }
  if (doDraft) {
    await runCreateStep(knex, foService, container, apply, "in_transit", reusedFoNumbers, reusedFodNumbers);
  }
  const touchedItemIds = doAdjust
    ? await runAdjustStep(knex, inventoryService, apply)
    : [];

  if (apply && (doCreate || doDraft)) await bumpSequences(knex);

  if (doAdjust) await runReindexStep(container, touchedItemIds, apply);

  await reportRemaining(knex, apply);
}
