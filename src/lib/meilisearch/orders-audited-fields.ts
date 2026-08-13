/**
 * Fields whose drift changes what the operator sees or which tab an order is in.
 *
 * Its own module on purpose. The daily audit and the 5-minute reconciliation
 * sweep must agree on what "drifted" means — when this list lived as two separate
 * literals they had already diverged by three fields, so the sweep and the report
 * were measuring different things. Sharing it from either side instead creates an
 * import cycle: the reconciler spreads this into its object literal while its
 * module evaluates, so whichever file loaded second would receive a
 * half-initialised namespace and produce `[...undefined]` — the reconciliation
 * sweep dead on boot, with a green type-check and no unit test able to see it.
 * A leaf module both can import is the fix that has no failure mode.
 *
 * `updated_at_ts` is deliberately absent: it moves on every touch and would
 * report drift on rows that are otherwise identical.
 */
export const ORDER_AUDITED_FIELDS = [
  "display_id",
  "document_number",
  "status",
  "effective_payment",
  "fulfillment_status",
  "is_unpaid",
  "is_open",
  "is_closed",
  "is_separated",
  "separation_state",
  "is_canceled",
  "is_voided",
  "is_web",
  "is_draft",
  "total_cents",
  "sales_rep_initials",
  "effective_date_ts",
  "customer_name",
  "company_name",
  "customer_email",
] as const;

export type OrderAuditedField = (typeof ORDER_AUDITED_FIELDS)[number];
