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

export interface LandedInput {
  qty: number;
  unit_cost_cents: number;
  /** null when the product has no CBM yet — line gets no freight share. */
  cbm_per_unit: number | null;
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
}

/**
 * Full landed-cost breakdown for a set of lines: allocates each pool with
 * largest-remainder and returns per-unit commission / freight / tariff / landed.
 * This is the ONE source of truth the confirm route and the store-pos preview
 * both call so the estimate always equals the locked value.
 *
 * Weight bases:
 *   commission → qty (flat per unit)
 *   freight    → cbm_per_unit × qty (by volume; lines without CBM get none)
 *   tariff     → unit_cost_cents × qty (by value)
 *   tax        → unit_cost_cents × qty (by value — sales tax is levied on the
 *                taxable value of the goods, so value is the faithful basis)
 */
export function computeLandedLines(
  lines: LandedInput[],
  pools: LandedPools
): {
  lines: LandedLineResult[];
  residualCents: {
    commission: number;
    freight: number;
    tariff: number;
    tax: number;
  };
} {
  const comm = allocatePerUnitCents(
    Math.max(0, Math.round(pools.commissionCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.qty }))
  );
  const freight = allocatePerUnitCents(
    Math.max(0, Math.round(pools.freightCents)),
    lines.map((l) => ({
      qty: l.qty,
      weight: l.cbm_per_unit != null ? l.cbm_per_unit * l.qty : 0,
    }))
  );
  const tariff = allocatePerUnitCents(
    Math.max(0, Math.round(pools.tariffCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.unit_cost_cents * l.qty }))
  );
  const tax = allocatePerUnitCents(
    Math.max(0, Math.round(pools.taxCents)),
    lines.map((l) => ({ qty: l.qty, weight: l.unit_cost_cents * l.qty }))
  );

  const out: LandedLineResult[] = lines.map((l, i) => {
    const commission_per_unit_cents = comm.perUnit[i] ?? 0;
    const freight_per_unit_cents = freight.perUnit[i] ?? 0;
    const tariff_per_unit_cents = tariff.perUnit[i] ?? 0;
    const tax_per_unit_cents = tax.perUnit[i] ?? 0;
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
    };
  });

  return {
    lines: out,
    residualCents: {
      commission: comm.residualCents,
      freight: freight.residualCents,
      tariff: tariff.residualCents,
      tax: tax.residualCents,
    },
  };
}
