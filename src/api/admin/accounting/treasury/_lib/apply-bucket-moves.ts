/**
 * Registered bucket assignments (credit-memo "moved" rows, payment-credit
 * picks) MOVE money between the day's splits — and therefore between the wire
 * amounts, which aggregate from these splits.
 *
 * Two invariants, both pure:
 *   · sum-zero: every applied move takes from one bucket and gives to another,
 *     so sum(splits) === net cash stays untouched;
 *   · floor at zero: a move that would leave its SOURCE bucket negative is
 *     rejected whole (never half-applied). The caller decides what a rejection
 *     means (2026-09-17: the payment's pick is treated as stale and blocks the
 *     lock again, plus a BUCKET_MOVE_EXCEEDS_SOURCE warning). Before this
 *     floor a $23,535.76 pick drained an Operating bucket holding $15,836.22
 *     and the screen showed a −$8,473.45 wire.
 *
 * Moves are applied in order: a later move sees the source already reduced
 * by earlier applied ones. Returns NEW split objects — inputs are not mutated.
 */
import type { TreasuryBucketCode } from "./compute-splits";

export interface BucketMove {
  from: TreasuryBucketCode;
  to: TreasuryBucketCode;
  cents: number;
  /** Caller's handle to map a rejection back to its row (payment id, application id). */
  ref: string;
}

export interface RejectedBucketMove extends BucketMove {
  /** What the source bucket held when the move was attempted. */
  available_cents: number;
}

export interface BucketMoveResult<S extends { code: TreasuryBucketCode; amount_cents: number }> {
  splits: S[];
  applied: BucketMove[];
  rejected: RejectedBucketMove[];
  /** No-ops: same bucket, non-positive cents, or a bucket absent from this range. */
  skipped: BucketMove[];
}

export function applyBucketMoves<
  S extends { code: TreasuryBucketCode; amount_cents: number },
>(splits: ReadonlyArray<S>, moves: ReadonlyArray<BucketMove>): BucketMoveResult<S> {
  const next = splits.map((s) => ({ ...s }));
  const byCode = new Map<TreasuryBucketCode, S>(next.map((s) => [s.code, s]));
  const applied: BucketMove[] = [];
  const rejected: RejectedBucketMove[] = [];
  const skipped: BucketMove[] = [];

  for (const move of moves) {
    const from = byCode.get(move.from);
    const to = byCode.get(move.to);
    if (!from || !to || move.cents <= 0 || move.from === move.to) {
      skipped.push(move);
      continue;
    }
    if (from.amount_cents - move.cents < 0) {
      rejected.push({ ...move, available_cents: from.amount_cents });
      continue;
    }
    from.amount_cents -= move.cents;
    to.amount_cents += move.cents;
    applied.push(move);
  }

  return { splits: next, applied, rejected, skipped };
}
