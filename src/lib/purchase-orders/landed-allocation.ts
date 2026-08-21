/**
 * src/lib/purchase-orders/landed-allocation.ts
 *
 * Largest-remainder allocation of a landed-cost overhead pool (commission,
 * freight, or tariff) across vendor-bill lines, returning an INTEGER per-unit
 * cost per line.
 *
 * WHY THIS EXISTS
 * The old code rounded each line's per-unit share INDEPENDENTLY
 * (`Math.round(total / totalQty)`, `Math.round((cbm/totalCbm) * freight)`), so
 * the sum of `perUnit_i × qty_i` drifted away from the real overhead total —
 * e.g. commission $453.75 ÷ 800u = $0.5671875 rounds to $0.57, and
 * $0.57 × 800 = $456.00, over-allocating by $2.25. Across commission + freight
 * that produced a systematic ~$3.50 over-allocation, which then forced a manual
 * "rounding plug" line on the QuickBooks bill so it could balance to the true
 * item cost. See the RM5/PO-1081 incident.
 *
 * THE FIX
 * Floor each line's per-unit share, then distribute the leftover cents with the
 * largest-remainder method. Because the stored value is a per-UNIT integer, one
 * extra cent on line i adds `qty_i` cents to the pool — so hitting the pool
 * total EXACTLY is a subset-sum over the line quantities. We solve it with a
 * small DP: for virtually all real POs (round-lot quantities that share a common
 * factor, e.g. 25/50/100/200/300) an exact subset exists and the pool lands on
 * the penny — no plug needed. Any mathematically-unavoidable leftover (only when
 * the quantities are coprime to the residual) is reported as `residualCents`
 * (always < the smallest line qty, i.e. a few cents) so the caller can decide
 * where the crumb lands.
 *
 * DETERMINISM: this is a pure function with no reliance on Math.random / clock /
 * unstable sort tie-breaks (ties break by index). The store-pos draft preview
 * (`computeLandedPreviews`) MUST mirror this byte-for-byte so what the user sees
 * equals what `Confirm & Lock Costs` persists and what QuickBooks receives.
 */

export interface AllocLine {
  /** Units on this line (the per-unit cost is multiplied by this). */
  qty: number;
  /**
   * Proportional basis for this line's share of the pool:
   *   - commission (flat per unit): weight = qty
   *   - freight (by volume):        weight = cbm_per_unit × qty  (0 if CBM unknown)
   *   - tariff (by value):          weight = unit_cost_cents × qty
   *   - sales tax (by value):       weight = unit_cost_cents × qty
   * A line with weight 0 receives nothing.
   */
  weight: number;
}

export interface AllocResult {
  /** Integer per-unit cents for each input line, in the same order. */
  perUnit: number[];
  /**
   * Cents that could not be placed on any per-unit bump (subset-sum had no exact
   * hit). Always < the smallest positive line qty. 0 for virtually all real POs.
   */
  residualCents: number;
}

const DP_MAX_RESIDUAL = 2_000_000; // safety cap; real residuals are < total units

/**
 * Allocate `totalCents` across `lines` as integer per-unit cents using the
 * largest-remainder / subset-sum method. Σ(perUnit_i × qty_i) === totalCents
 * whenever the quantities allow it.
 */
export function allocatePerUnitCents(
  totalCents: number,
  lines: AllocLine[]
): AllocResult {
  const n = lines.length;
  const perUnit = new Array<number>(n).fill(0);
  if (totalCents <= 0 || n === 0) return { perUnit, residualCents: 0 };

  const totalWeight = lines.reduce((s, l) => s + Math.max(0, l.weight), 0);
  if (totalWeight <= 0) return { perUnit, residualCents: 0 };

  // Step 1 — floor each line's per-unit share; remember the fractional leftover.
  const frac = new Array<number>(n).fill(0);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    if (line.qty <= 0 || line.weight <= 0) continue;
    const exactLineCents = (line.weight / totalWeight) * totalCents; // real cents for the whole line
    const pu = Math.floor(exactLineCents / line.qty);
    perUnit[i] = pu;
    allocated += pu * line.qty;
    frac[i] = exactLineCents - pu * line.qty; // 0 .. < qty
  }

  let residual = Math.round(totalCents - allocated); // 0 .. < Σqty
  if (residual <= 0) return { perUnit, residualCents: 0 };

  // Step 2 — distribute the residual by giving +1 per-unit (== +qty cents) to a
  // subset of lines whose quantities sum to exactly `residual`.
  if (residual > DP_MAX_RESIDUAL) {
    // Degenerate guard (never hit by real data): greedy largest-qty-first.
    const order = [...Array(n).keys()]
      .filter((i) => lines[i]!.qty > 0)
      .sort((a, b) => lines[b]!.qty - lines[a]!.qty || a - b);
    for (const i of order) {
      if (residual <= 0) break;
      const q = lines[i]!.qty;
      if (q <= residual) {
        perUnit[i] = (perUnit[i] ?? 0) + 1;
        residual -= q;
      }
    }
    return { perUnit, residualCents: residual };
  }

  // DP subset-sum. Candidate lines: qty in (0, residual], higher fractional
  // remainder first so the DP fills from the "most deserving" lines; ties by index.
  const order = [...Array(n).keys()]
    .filter((i) => lines[i]!.qty > 0 && lines[i]!.qty <= residual)
    .sort((a, b) => (frac[b] ?? 0) - (frac[a] ?? 0) || a - b);

  // reach[s] = index of the line used to first reach sum s (-2 for s=0, -1 unreachable)
  const reach = new Array<number>(residual + 1).fill(-1);
  const prev = new Array<number>(residual + 1).fill(-1);
  reach[0] = -2;
  for (const i of order) {
    const q = lines[i]!.qty;
    for (let s = residual; s >= q; s--) {
      if ((reach[s] ?? -1) === -1 && (reach[s - q] ?? -1) !== -1) {
        reach[s] = i;
        prev[s] = s - q;
      }
    }
    if ((reach[residual] ?? -1) !== -1) break;
  }

  // Largest reachable sum ≤ residual (exact when reach[residual] is set).
  let best = residual;
  while (best > 0 && (reach[best] ?? -1) === -1) best--;

  for (let s = best; s > 0; ) {
    const idx = reach[s]!;
    perUnit[idx] = (perUnit[idx] ?? 0) + 1;
    s = prev[s]!;
  }

  return { perUnit, residualCents: residual - best };
}

/**
 * Allocate `totalCents` across lines as integer LINE totals (largest remainder).
 *
 * WHY THIS EXISTS ALONGSIDE `allocatePerUnitCents`
 * The per-unit allocator is constrained: its output is an integer cost PER UNIT,
 * so a line of qty Q can only ever absorb multiples of Q cents. A single-line
 * bill therefore CANNOT represent most pools exactly — PO-1029 (37 units, $12.90
 * of sales tax) allocates 34¢/unit = $12.58 and strands 32¢, because rescuing it
 * would need a line with qty ≤ 32 to bump and there is only the one line of 37.
 * The ceiling scales with quantity: a 250-unit line can strand $2.49.
 *
 * Line totals have no such constraint — one cent can go to any line — so this
 * allocator ALWAYS sums to exactly `totalCents`. It is the basis for the money
 * that matters (the AVCO numerator and the displayed landed total); the per-unit
 * figures stay purely presentational.
 *
 * Ties in the fractional remainder break by index, so this is deterministic.
 */
export function allocateLineTotalsCents(
  totalCents: number,
  weights: number[]
): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  if (totalCents <= 0 || n === 0) return out;

  const totalWeight = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (totalWeight <= 0) return out;

  const frac = new Array<number>(n).fill(0);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.max(0, weights[i] ?? 0);
    if (w <= 0) continue;
    const exact = (w / totalWeight) * totalCents;
    const floored = Math.floor(exact);
    out[i] = floored;
    allocated += floored;
    frac[i] = exact - floored;
  }

  // Hand the leftover cents to the largest fractional remainders, one each.
  let leftover = Math.round(totalCents - allocated);
  const order = [...Array(n).keys()]
    .filter((i) => (weights[i] ?? 0) > 0)
    .sort((a, b) => (frac[b] ?? 0) - (frac[a] ?? 0) || a - b);
  for (let k = 0; leftover > 0 && k < order.length; k++, leftover--) {
    const i = order[k]!;
    out[i] = (out[i] ?? 0) + 1;
  }
  // Only reachable when every weight is 0 (guarded above) — kept so the
  // function's contract "sums to totalCents" holds unconditionally.
  if (leftover > 0 && order.length > 0) {
    const i = order[0]!;
    out[i] = (out[i] ?? 0) + leftover;
  }
  return out;
}

export interface LandedInput {
  qty: number;
  unit_cost_cents: number;
  /** null when the product has no CBM yet — line gets no freight share. */
  cbm_per_unit: number | null;
}

/** Basis used to spread the freight pool across lines. */
export type FreightBasis = "cbm" | "units" | "value";

export interface LandedOptions {
  /**
   * Base de reparto del pool de freight. Default "cbm" — preserva byte a byte
   * el comportamiento de todo caller existente (bills China). Cambiarla
   * requiere pasarla explícitamente.
   */
  freightBasis?: FreightBasis;
}

/**
 * The freight weight for a single line under a given basis. Shared by both
 * `allocatePerUnitCents` and `allocateLineTotalsCents` call sites so the two
 * can never diverge.
 */
function freightWeight(l: LandedInput, basis: FreightBasis): number {
  switch (basis) {
    case "units":
      return l.qty;
    case "value":
      return l.unit_cost_cents * l.qty;
    case "cbm":
    default:
      return l.cbm_per_unit != null ? l.cbm_per_unit * l.qty : 0;
  }
}

/**
 * The freight weight VECTOR for a set of lines under a given basis — exported
 * so every caller that needs to allocate a freight pool independently (the QB
 * payload builders, which recompute an exact-line-total allocation rather than
 * trusting the confirm's rounded per-unit figures) reuses the exact same
 * per-line formula `computeLandedLines` uses internally. A caller that
 * hand-rolls this instead of importing it is how the confirm and the QB
 * payload diverge on which line absorbs which cent.
 */
export function freightWeights(lines: LandedInput[], basis: FreightBasis): number[] {
  return lines.map((l) => freightWeight(l, basis));
}

/**
 * Dumps an `allocatePerUnitCents` pool's `residualCents` onto the single line
 * with the highest `unit_cost_cents × qty`, as one lump +N¢/unit bump — see
 * the call site in `computeLandedLines` for why this exists. A no-op when
 * there is nothing to place or no eligible line (qty > 0) to place it on.
 */
function absorbResidualOnHighestValueLine(
  alloc: AllocResult,
  lines: LandedInput[]
): number[] {
  if (alloc.residualCents <= 0) return alloc.perUnit;
  let bestIndex = -1;
  let bestValue = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.qty <= 0) continue;
    const value = line.unit_cost_cents * line.qty;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) return alloc.perUnit;
  const bump = Math.ceil(alloc.residualCents / lines[bestIndex]!.qty);
  const out = [...alloc.perUnit];
  out[bestIndex] = (out[bestIndex] ?? 0) + bump;
  return out;
}

export interface LandedPools {
  /** total commission / service cents to spread (0 to skip) */
  commissionCents: number;
  /** total freight cents to spread (0 to skip) */
  freightCents: number;
  /** total tariff/duties cents to spread (0 to skip) */
  tariffCents: number;
  /**
   * Sales tax the vendor charged on this invoice (0 to skip).
   *
   * Non-recoverable tax on goods bought for resale is part of the acquisition
   * cost, so it capitalizes into the landed unit cost exactly like tariff.
   * It is deliberately NOT surfaced as a per-line column in the POS items
   * table — the operator enters ONE header amount copied off the vendor
   * document and reads it in the totals footer, mirroring how QuickBooks
   * presents it. The per-unit split is persisted only so the landed identity
   *   landed = unit + commission + freight + tariff + tax
   * stays reconstructible by the replay/drift engines.
   */
  taxCents: number;
}

export interface LandedLineResult {
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  tax_per_unit_cents: number;
  landed_unit_cost_cents: number;
  /**
   * EXACT landed money for this line: goods + its share of every pool, with
   * Σ over all lines equal to Σ(unit_cost × qty) + every pool, to the penny.
   *
   * This — NOT `landed_unit_cost_cents × qty` — is the cost basis. The per-unit
   * value is an integer and therefore lossy: it can only express multiples of
   * `qty` cents per line, so multiplying it back out strands up to `qty − 1`
   * cents of real money per pool. Use this for the AVCO numerator and for any
   * total shown against the bill; use the per-unit figures for display only.
   */
  landed_total_cents: number;
}

/**
 * Full landed-cost breakdown for a set of lines: allocates each pool with
 * largest-remainder and returns per-unit commission / freight / tariff / landed.
 * This is the ONE source of truth the confirm route and the store-pos preview
 * both call so the estimate always equals the locked value.
 *
 * Weight bases:
 *   commission → qty (flat per unit)
 *   freight    → opts.freightBasis, default "cbm" (cbm_per_unit × qty; lines
 *                without CBM get none). Passing "units" or "value" spreads it
 *                by quantity or by cost instead — see `freightWeight()`.
 *   tariff     → unit_cost_cents × qty (by value)
 *   tax        → unit_cost_cents × qty (by value — sales tax is levied on the
 *                taxable value of the goods, so value is the faithful basis)
 */
export function computeLandedLines(
  lines: LandedInput[],
  pools: LandedPools,
  opts?: LandedOptions
): {
  lines: LandedLineResult[];
  residualCents: {
    commission: number;
    freight: number;
    tariff: number;
    tax: number;
  };
  /**
   * Cents of a pool that could not be placed on ANY line (pool > 0 but the
   * sum of its weights is <= 0 — e.g. every line lacks CBM under the "cbm"
   * basis). Behavior is unchanged (the pool still allocates zero cents to
   * every line, same as before this field existed) — this is purely a
   * signal so the caller can surface it instead of the pool silently
   * vanishing.
   */
  unplaceableCents: {
    commission: number;
    freight: number;
    tariff: number;
    tax: number;
  };
  /**
   * Informative only — does NOT change the allocation and does NOT throw.
   * `complete` is true when every line with qty > 0 has a usable
   * (non-null, > 0) cbm_per_unit.
   */
  freightCoverage: {
    linesWithCbm: number;
    linesTotal: number;
    complete: boolean;
  };
} {
  const freightBasis: FreightBasis = opts?.freightBasis ?? "cbm";

  const freightWeights = lines.map((l) => freightWeight(l, freightBasis));

  const comm = allocatePerUnitCents(
    Math.max(0, Math.round(pools.commissionCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.qty }))
  );
  const freight = allocatePerUnitCents(
    Math.max(0, Math.round(pools.freightCents)),
    lines.map((l, i) => ({ qty: l.qty, weight: freightWeights[i] ?? 0 }))
  );
  const tariff = allocatePerUnitCents(
    Math.max(0, Math.round(pools.tariffCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.unit_cost_cents * l.qty }))
  );
  const tax = allocatePerUnitCents(
    Math.max(0, Math.round(pools.taxCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.unit_cost_cents * l.qty }))
  );

  // EXACT line totals, allocated independently of the per-unit figures above.
  // Same weight bases, but no per-unit integer constraint, so each pool lands on
  // the penny. Deliberately additive: the per-unit algorithm is untouched, so
  // already-confirmed bills still recompute to the same stored per-unit values
  // and the drift engine sees no phantom change.
  const weightsQty = lines.map((l) => l.qty);
  const weightsValue = lines.map((l) => l.unit_cost_cents * l.qty);
  const commTotals = allocateLineTotalsCents(
    Math.max(0, Math.round(pools.commissionCents)),
    weightsQty
  );
  const freightTotals = allocateLineTotalsCents(
    Math.max(0, Math.round(pools.freightCents)),
    freightWeights
  );
  const tariffTotals = allocateLineTotalsCents(
    Math.max(0, Math.round(pools.tariffCents)),
    weightsValue
  );
  const taxTotals = allocateLineTotalsCents(
    Math.max(0, Math.round(pools.taxCents)),
    weightsValue
  );

  // `allocatePerUnitCents` can strand its ENTIRE pool as `residualCents` when
  // no line's qty is small enough to receive even a single +1¢/unit bump —
  // a bill with 500u/1000u lines and a $2.97 freight charge has no such line,
  // so all $2.97 used to vanish from `landed_unit_cost_cents` with nothing to
  // show for it (VB-1124 and 8 siblings, 2026-08-21 — ~$40 lost in production
  // across freight and tax). `landed_total_cents` below was never wrong — it
  // comes from `allocateLineTotalsCents`, which has no such constraint — so
  // this only fixes the persisted PER-UNIT figure. The whole residual lands
  // on the single line with the highest `unit_cost_cents × qty` (the same
  // "value" weight tariff/tax already use): that line's per-unit value stops
  // being a clean average, but a total that is off by a few cents on one line
  // beats one that is provably short. If no line has qty > 0, the residual
  // still has nowhere to go and stays lost, exactly as before this fix.
  const commPerUnit = absorbResidualOnHighestValueLine(comm, lines);
  const freightPerUnit = absorbResidualOnHighestValueLine(freight, lines);
  const tariffPerUnit = absorbResidualOnHighestValueLine(tariff, lines);
  const taxPerUnit = absorbResidualOnHighestValueLine(tax, lines);

  const out: LandedLineResult[] = lines.map((l, i) => {
    const commission_per_unit_cents = commPerUnit[i] ?? 0;
    const freight_per_unit_cents = freightPerUnit[i] ?? 0;
    const tariff_per_unit_cents = tariffPerUnit[i] ?? 0;
    const tax_per_unit_cents = taxPerUnit[i] ?? 0;
    return {
      commission_per_unit_cents,
      freight_per_unit_cents,
      tariff_per_unit_cents,
      tax_per_unit_cents,
      landed_unit_cost_cents:
        l.unit_cost_cents +
        commission_per_unit_cents +
        freight_per_unit_cents +
        tariff_per_unit_cents +
        tax_per_unit_cents,
      landed_total_cents:
        l.unit_cost_cents * l.qty +
        (commTotals[i] ?? 0) +
        (freightTotals[i] ?? 0) +
        (tariffTotals[i] ?? 0) +
        (taxTotals[i] ?? 0),
    };
  });

  // A pool is "unplaceable" when it has money to spread (> 0) but nowhere
  // legal to put it (sum of weights <= 0). Same condition
  // `allocatePerUnitCents`/`allocateLineTotalsCents` already use internally
  // to bail out to all-zeros — this just names it for the caller.
  const commWeightTotal = lines.reduce((s, l) => s + Math.max(0, l.qty), 0);
  const freightWeightTotal = freightWeights.reduce(
    (s, w) => s + Math.max(0, w),
    0
  );
  const tariffValueWeightTotal = weightsValue.reduce(
    (s, w) => s + Math.max(0, w),
    0
  );
  const commissionCentsRounded = Math.max(0, Math.round(pools.commissionCents));
  const freightCentsRounded = Math.max(0, Math.round(pools.freightCents));
  const tariffCentsRounded = Math.max(0, Math.round(pools.tariffCents));
  const taxCentsRounded = Math.max(0, Math.round(pools.taxCents));

  const linesTotal = lines.filter((l) => l.qty > 0).length;
  const linesWithCbm = lines.filter(
    (l) => l.qty > 0 && l.cbm_per_unit != null && l.cbm_per_unit > 0
  ).length;

  return {
    lines: out,
    residualCents: {
      commission: comm.residualCents,
      freight: freight.residualCents,
      tariff: tariff.residualCents,
      tax: tax.residualCents,
    },
    unplaceableCents: {
      commission:
        commissionCentsRounded > 0 && commWeightTotal <= 0
          ? commissionCentsRounded
          : 0,
      freight:
        freightCentsRounded > 0 && freightWeightTotal <= 0
          ? freightCentsRounded
          : 0,
      tariff:
        tariffCentsRounded > 0 && tariffValueWeightTotal <= 0
          ? tariffCentsRounded
          : 0,
      tax:
        taxCentsRounded > 0 && tariffValueWeightTotal <= 0
          ? taxCentsRounded
          : 0,
    },
    freightCoverage: {
      linesWithCbm,
      linesTotal,
      complete: linesWithCbm === linesTotal,
    },
  };
}
