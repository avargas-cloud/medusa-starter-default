/**
 * Customer-paid card surcharge, read from `customer_payment.metadata` at
 * create time. `dejavoo_surcharge_cents` (terminal) wins over
 * `bams_surcharge_fee_cents` (online) when both are somehow present — they
 * never should be for the same payment, but the create input is `unknown`
 * so a deliberate order beats a silent double-count. Anything that isn't a
 * finite, non-negative integer is treated as "no surcharge" (0), never
 * thrown: a malformed metadata value must not block the payment write.
 */
export function surchargeCentsFromMetadata(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) return 0;
  const record = metadata as Record<string, unknown>;
  const raw = record.dejavoo_surcharge_cents ?? record.bams_surcharge_fee_cents;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw))
    return 0;
  return raw >= 0 ? raw : 0;
}
