/**
 * China Finance — describing an audited adjustment of an already-PAID vendor bill.
 *
 * When a bill that a confirmed wire already paid is corrected under a supervisor
 * PIN, its liability drops while the wire application stays immutable, so the
 * delta engine turns the gap into an overpay CREDIT. The credit itself is
 * derived; these helpers produce the human provenance that travels with it —
 * the sentence the buyer screenshots to the purchasing agent.
 *
 * Pure functions: no DB, no clock. The caller stamps identity and time.
 */

export interface AdjLineState {
  id?: string | null;
  sku: string | null;
  qty: number;
  unit_cost_cents: number;
}

export interface AdjLineChange {
  sku: string;
  from_qty: number;
  to_qty: number;
  from_unit_cost_cents: number;
  to_unit_cost_cents: number;
  /** signed: after − before. Negative = the bill now claims less. */
  delta_cents: number;
}

const money = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Match before→after by line id when both sides carry one, else by SKU. A line
 * present only in `before` counts as removed (to_qty 0); only in `after`, added.
 */
export function diffBillLines(
  before: AdjLineState[],
  after: AdjLineState[]
): AdjLineChange[] {
  const keyOf = (l: AdjLineState): string =>
    l.id ? `id:${l.id}` : `sku:${l.sku ?? ""}`;

  const beforeByKey = new Map<string, AdjLineState>();
  const beforeBySku = new Map<string, AdjLineState>();
  for (const l of before) {
    beforeByKey.set(keyOf(l), l);
    if (l.sku) beforeBySku.set(l.sku, l);
  }

  const changes: AdjLineChange[] = [];
  const consumed = new Set<string>();

  for (const a of after) {
    const direct = beforeByKey.get(keyOf(a));
    const b = direct ?? (a.sku ? beforeBySku.get(a.sku) : undefined);
    if (b) consumed.add(keyOf(b));
    const fromQty = b?.qty ?? 0;
    const fromCost = b?.unit_cost_cents ?? a.unit_cost_cents;
    if (fromQty === a.qty && fromCost === a.unit_cost_cents) continue;
    changes.push({
      sku: a.sku ?? b?.sku ?? "",
      from_qty: fromQty,
      to_qty: a.qty,
      from_unit_cost_cents: fromCost,
      to_unit_cost_cents: a.unit_cost_cents,
      delta_cents: a.qty * a.unit_cost_cents - fromQty * fromCost,
    });
  }

  for (const b of before) {
    if (consumed.has(keyOf(b))) continue;
    changes.push({
      sku: b.sku ?? "",
      from_qty: b.qty,
      to_qty: 0,
      from_unit_cost_cents: b.unit_cost_cents,
      to_unit_cost_cents: b.unit_cost_cents,
      delta_cents: -(b.qty * b.unit_cost_cents),
    });
  }

  return changes;
}

/**
 * The provenance sentence. Written for the purchasing agent, so it names the
 * SKU, both quantities, and the resulting credit — never a bare number.
 */
export function buildAdjustmentNote(input: {
  changes: AdjLineChange[];
  previousTotalCents: number;
  newTotalCents: number;
  billNumber?: string | null;
  sourceLabel?: string | null;
  reason?: string | null;
}): string {
  const { changes, previousTotalCents, newTotalCents, billNumber, sourceLabel, reason } =
    input;
  const delta = newTotalCents - previousTotalCents;

  const parts: string[] = [];
  for (const c of changes) {
    if (c.from_qty !== c.to_qty && c.from_unit_cost_cents === c.to_unit_cost_cents) {
      parts.push(`${c.sku} quantity ${c.from_qty} → ${c.to_qty} (${money(c.delta_cents)})`);
    } else if (c.from_qty === c.to_qty) {
      parts.push(
        `${c.sku} unit cost ${money(c.from_unit_cost_cents)} → ${money(c.to_unit_cost_cents)} (${money(c.delta_cents)})`
      );
    } else {
      parts.push(
        `${c.sku} ${c.from_qty} × ${money(c.from_unit_cost_cents)} → ${c.to_qty} × ${money(c.to_unit_cost_cents)} (${money(c.delta_cents)})`
      );
    }
  }

  const head = billNumber ? `${billNumber} adjusted` : "Bill adjusted";
  const against = sourceLabel ? ` to match ${sourceLabel}` : "";
  const detail = parts.length > 0 ? ` — ${parts.join("; ")}` : "";
  const totals = `. Bill total ${money(previousTotalCents)} → ${money(newTotalCents)}`;
  const effect =
    delta < 0
      ? `. This bill was already paid in full, so the ${money(-delta)} difference is a credit in our favour.`
      : delta > 0
        ? `. This bill was already paid, so ${money(delta)} is still owed on it.`
        : ".";
  const why = reason ? ` Reason: ${reason}` : "";

  return `${head}${against}${detail}${totals}${effect}${why}`;
}
