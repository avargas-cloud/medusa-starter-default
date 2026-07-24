/**
 * src/lib/cost/avco.ts
 *
 * THE weighted-average (AVCO) engine. Pure, deterministic, integer-cents.
 *
 * WHY THIS EXISTS
 * The moving average used to be computed inline inside the vendor-bill confirm
 * route, and it had three defects that silently corrupted the cost basis of
 * every China product (see docs/COST_BASIS_RESTATEMENT.md):
 *
 *   1. The running average was seeded from `avg_landed_cost_cents ?? 0`, a key
 *      that is NULL on a variant's FIRST bill — so pre-existing on-hand stock
 *      entered the weighted average valued at $0 and collapsed the result.
 *      (14 units @ $0.00 + 3 @ $14.14 -> $2.50 when QuickBooks said $23.55.)
 *   2. A negative `qty_on_hand_at_receive` (oversold stock) was fed straight
 *      into the formula, shrinking the denominator and inflating the average
 *      (-28 units + 40 @ $20.48 -> $68.27, 3.3x too high).
 *   3. There was no audit trail of the transition beyond a float log table.
 *
 * Both the live confirm route and the historical restatement script call THIS
 * function, so a replay of the past and a write in the present can never
 * disagree — that equivalence is the whole point of the file.
 *
 * NEGATIVE INVENTORY (the part that is not just arithmetic)
 * Clamping a negative quantity to zero stops the nonsense but is not correct
 * accounting: those oversold units were already issued to COGS at a provisional
 * cost, and the arriving receipt is what finally reveals what they really cost.
 * So an arriving receipt is applied in two stages:
 *
 *   a. Settlement — receipt units first match the shortage. Those units never
 *      enter inventory; they retro-price units that were already sold. The
 *      difference between the provisional cost they were issued at and the real
 *      landed cost is a COGS true-up, reported explicitly, never buried in the
 *      average.
 *   b. Layering — only the REMAINING units enter on-hand inventory and take
 *      part in the weighted average.
 *
 * Example: -28 on hand issued at $15.00, receipt of 40 @ $20.48
 *   28 units settle the shortage -> COGS true-up = 28 x ($20.48 - $15.00) = $153.44
 *   12 units remain              -> new average  = $20.48 (nothing to average against)
 * NOT (-28 x 15 + 40 x 20.48) / 12 = $68.27.
 *
 * UNITS: every cost in this module is INTEGER CENTS. The caller converts to the
 * dollars that `metadata.average_cost` stores. Rounding happens once, at the
 * very end of a step, via `roundCents` — never per-unit mid-computation.
 */

/** A single inbound event to apply to a variant's cost basis. */
export interface AvcoReceiptInput {
  /** Units arriving. Must be > 0 for the step to do anything. */
  quantity: number;
  /**
   * Fully-landed cost of ONE arriving unit, in cents: factory price plus its
   * allocated share of agent commission, freight and duty. Comes from
   * `landed-allocation.ts` — never recomputed here.
   */
  landedUnitCostCents: number;
  /**
   * On-hand quantity IMMEDIATELY BEFORE this receipt. May be negative when the
   * variant was oversold; that is handled, not rejected.
   */
  quantityOnHandBefore: number;
}

/** The outcome of applying one receipt to a cost basis. */
export interface AvcoStepResult {
  /** Average unit cost in cents BEFORE this step. */
  previousAvgCostCents: number;
  /** Average unit cost in cents AFTER this step — what gets persisted. */
  newAvgCostCents: number;
  /** On-hand quantity after the receipt (never negative once settled). */
  quantityOnHandAfter: number;
  /** Units consumed settling a negative balance (0 in the normal case). */
  negativeSettledQuantity: number;
  /**
   * COGS correction owed for the oversold units this receipt settled, in cents.
   * Positive = the units were issued too cheaply and COGS was understated.
   * Zero in the normal (non-negative) case.
   */
  cogsTrueUpCents: number;
  /** Units that actually entered inventory and joined the average. */
  layeredQuantity: number;
  /** Change in inventory carrying value caused by this step, in cents. */
  inventoryValueDeltaCents: number;
  /**
   * True when the previous average had to be inferred rather than read from an
   * established basis — the caller should surface this, not swallow it.
   */
  seedWasImputed: boolean;
}

/**
 * Round to whole cents, half-away-from-zero. `Math.round` is half-UP, which
 * biases negative values (Math.round(-0.5) === -0) — money must round
 * symmetrically or a restatement and its reversal will not cancel out.
 */
export function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Round a DOLLAR cost to QB-safe precision (≤5 decimals). Cost dollars derived
 * from fractional cents via `cents / 100` carry IEEE-754 float noise
 * (`2764.8 / 100 === 27.648000000000003`), which QuickBooks' QBXML PRICETYPE
 * rejects with error 3045. Apply this the moment a cost number is produced —
 * when it is stored in `metadata.average_cost`/`purchase_cost` — not only just
 * before the QB payload, so the stored value is clean at the source too.
 */
export function roundCostDollars(dollars: number): number {
  return Math.round(dollars * 1e5) / 1e5;
}

/**
 * Nullish-safe {@link roundCostDollars}: rounds finite numbers, passes
 * `null`/`undefined`/non-finite through unchanged. Use at write boundaries
 * (POS product create/update) where a cost field may be absent on the input.
 */
export function roundCostDollarsOpt<T extends number | null | undefined>(
  dollars: T
): T {
  return typeof dollars === "number" && Number.isFinite(dollars)
    ? (roundCostDollars(dollars) as T)
    : dollars;
}

/**
 * Resolve the seed for a variant's running average, in cents, in descending
 * order of authority. This is the fix for defect #1: the old code read ONLY the
 * first source and fell to 0 when it was absent.
 *
 * Order matters and is deliberate:
 *   1. `avg_landed_cost_cents` — the live chaining state of a variant that has
 *      already been through a bill. Most specific, so it wins.
 *   2. `average_cost` — the canonical COGS field, whoever wrote it last (a QB
 *      sync for a local product, a previous bill for a China one). This is the
 *      entry that makes the engine origin-agnostic.
 *   3. `qb_avg_cost` — QuickBooks' own average. For China this is the original
 *      catalog load and already includes freight and duty.
 *   4. `purchase_cost` — raw factory cost, no freight. Last resort: understates
 *      the basis, but it beats zero by a mile.
 *
 * Returns null when the variant has no usable basis at all (a brand-new product
 * whose first-ever receipt legitimately establishes the cost).
 */
export function resolveAvgCostSeedCents(metadata: Record<string, unknown> | null | undefined): {
  seedCents: number | null;
  source: "landed_state" | "average_cost" | "qb_avg_cost" | "purchase_cost" | "none";
} {
  const num = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    // <= 0 is treated as absent, not as a real cost: vendor-bill cancel/reopen
    // can reset a running average to 0, and a $0 basis is never authoritative.
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const meta = metadata ?? {};

  const landedState = num(meta["avg_landed_cost_cents"]);
  if (landedState !== null) return { seedCents: roundCents(landedState), source: "landed_state" };

  const averageCost = num(meta["average_cost"]);
  if (averageCost !== null) return { seedCents: roundCents(averageCost * 100), source: "average_cost" };

  const qbAvg = num(meta["qb_avg_cost"]);
  if (qbAvg !== null) return { seedCents: roundCents(qbAvg * 100), source: "qb_avg_cost" };

  const purchase = num(meta["purchase_cost"]);
  if (purchase !== null) return { seedCents: roundCents(purchase * 100), source: "purchase_cost" };

  return { seedCents: null, source: "none" };
}

/**
 * Apply ONE receipt to a cost basis. The core primitive — every other entry
 * point in this file is a loop around it.
 *
 * `previousAvgCostCents` of null means "no established basis": the arriving
 * units set the cost outright instead of averaging against a fictional zero.
 */
export function applyReceiptToAvco(
  previousAvgCostCents: number | null,
  input: AvcoReceiptInput
): AvcoStepResult {
  const qty = Math.trunc(input.quantity);
  const landed = roundCents(input.landedUnitCostCents);
  const qBefore = Math.trunc(input.quantityOnHandBefore);

  const seedWasImputed = previousAvgCostCents === null;
  // With no prior basis, the arriving cost IS the basis — averaging against 0
  // is exactly the bug this engine exists to kill.
  const prevAvg = previousAvgCostCents === null ? landed : roundCents(previousAvgCostCents);

  if (qty <= 0) {
    return {
      previousAvgCostCents: prevAvg,
      newAvgCostCents: prevAvg,
      quantityOnHandAfter: qBefore,
      negativeSettledQuantity: 0,
      cogsTrueUpCents: 0,
      layeredQuantity: 0,
      inventoryValueDeltaCents: 0,
      seedWasImputed,
    };
  }

  // --- Stage (a): settle any negative balance BEFORE averaging. ---
  // The oversold units were issued to COGS at `prevAvg` (the provisional cost).
  // The receipt reveals they really cost `landed`, so the gap is owed to COGS.
  const shortage = qBefore < 0 ? Math.min(-qBefore, qty) : 0;
  const cogsTrueUpCents = shortage > 0 ? shortage * (landed - prevAvg) : 0;

  // --- Stage (b): only what survives settlement joins the average. ---
  const layeredQuantity = qty - shortage;
  const qtyOnHandBeforeLayering = qBefore + shortage; // 0 when we settled a shortage
  const quantityOnHandAfter = qtyOnHandBeforeLayering + layeredQuantity;

  let newAvgCostCents: number;
  if (layeredQuantity <= 0) {
    // The whole receipt went to settling the shortage. The average is unchanged;
    // the economics landed entirely in the COGS true-up.
    newAvgCostCents = prevAvg;
  } else if (qtyOnHandBeforeLayering <= 0) {
    // Nothing (or nothing positive) to average against — the receipt sets it.
    newAvgCostCents = landed;
  } else {
    newAvgCostCents = roundCents(
      (qtyOnHandBeforeLayering * prevAvg + layeredQuantity * landed) /
        (qtyOnHandBeforeLayering + layeredQuantity)
    );
  }

  // Carrying-value change, stored explicitly rather than re-derived later from
  // a quantity that may have moved since.
  const inventoryValueDeltaCents =
    quantityOnHandAfter * newAvgCostCents - Math.max(0, qBefore) * prevAvg;

  return {
    previousAvgCostCents: prevAvg,
    newAvgCostCents,
    quantityOnHandAfter,
    negativeSettledQuantity: shortage,
    cogsTrueUpCents,
    layeredQuantity,
    inventoryValueDeltaCents,
    seedWasImputed,
  };
}

/** One inbound event in a chronological replay. */
export interface AvcoReplayStep extends AvcoReceiptInput {
  /** Opaque identifier echoed back on the result, for audit joins. */
  ref: string;
  /** Economic date this step takes effect. Ordering is the caller's job. */
  effectiveAt: Date;
}

export interface AvcoReplayStepResult extends AvcoStepResult {
  ref: string;
  effectiveAt: Date;
}

/**
 * Replay a chronological series of receipts against one variant, chaining the
 * average. The caller MUST pass `steps` already ordered by economic date — this
 * function does not sort, because the correct ordering authority (received_at
 * vs confirmed_at, and the tie-break) is an accounting decision that belongs
 * upstream, not a property of the arithmetic.
 */
export function replayAvco(
  seedCents: number | null,
  steps: readonly AvcoReplayStep[]
): { finalAvgCostCents: number | null; steps: AvcoReplayStepResult[] } {
  let running: number | null = seedCents;
  const results: AvcoReplayStepResult[] = [];

  for (const step of steps) {
    const result = applyReceiptToAvco(running, step);
    results.push({ ...result, ref: step.ref, effectiveAt: step.effectiveAt });
    running = result.newAvgCostCents;
  }

  return { finalAvgCostCents: running, steps: results };
}
