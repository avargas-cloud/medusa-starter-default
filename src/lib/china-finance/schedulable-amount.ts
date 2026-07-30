/**
 * How much of a China-Finance bill can still be put on a wire.
 *
 * One function, so the route that enforces it and the verifier that proves it
 * cannot disagree: a verifier holding its own copy of the arithmetic passes
 * while production does something else.
 *
 * The two directions are NOT symmetric, and that asymmetry is the whole point:
 *
 *   paid short  → amount > confirmed → the difference is a DEBT, schedulable on
 *                 a later wire as a second application against the same bill.
 *   paid long   → confirmed > amount → the difference is a CREDIT, and this
 *                 returns 0. It settles through `china_finance_wire_credit`,
 *                 which reduces the cash of a future wire; scheduling it here
 *                 would pay the vendor money we are owed.
 *
 * That second case is not hypothetical: a bill corrected downward after being
 * paid keeps its confirmed application at the old, larger figure. VB-1045 sits
 * at $3,025.00 with $3,136.50 applied, and its $111.50 excess is a credit row.
 * An unclamped subtraction would have offered −$111.50 as something to schedule.
 *
 * `confirmedCents` counts CONFIRMED applications only. Money on a draft wire is
 * a plan, not a payment, and the reassign path rewrites those rows in place.
 */
export function schedulableCents(
  amountCents: number,
  confirmedCents: number
): number {
  return Math.max(amountCents - confirmedCents, 0);
}
