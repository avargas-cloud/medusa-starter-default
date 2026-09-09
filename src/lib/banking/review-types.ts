export type Review = {
  id: string;
  transaction_id: string;
  revision: number;
  source_version: number;
  status: "draft" | "confirmed" | "excluded";
  mode: "categorize" | "match" | "deposit";
  category_list_id: string | null;
  counterparty_type: "vendor" | "customer" | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  comment: string;
  matched_payment_id: string | null;
  match_snapshot: Record<string, unknown> | null;
  matched_deposit_id: string | null;
  deposit_snapshot: Record<string, unknown> | null;
  category_snapshot: Record<string, unknown> | null;
  origin: "manual" | "rule";
  rule_id: string | null;
  rule_version: number | null;
  manual_override: boolean;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  exclusion_reason: string | null;
};
export const REVIEW_COLUMNS = `id,transaction_id,revision,source_version,status,mode,
  category_list_id,counterparty_type,counterparty_id,counterparty_name,comment,
  matched_payment_id,match_snapshot,category_snapshot,origin,rule_id,rule_version,
  manual_override,confirmed_by,confirmed_at,exclusion_reason,matched_deposit_id,deposit_snapshot`;

export const REVIEW_JSON = `jsonb_build_object(
  'id',r.id,'transaction_id',r.transaction_id,'revision',r.revision,'source_version',r.source_version,
  'status',r.status,'mode',r.mode,'category_list_id',r.category_list_id,
  'counterparty_type',r.counterparty_type,'counterparty_id',r.counterparty_id,
  'counterparty_name',r.counterparty_name,'comment',r.comment,'matched_payment_id',r.matched_payment_id,
  'matched_deposit_id',r.matched_deposit_id,'deposit_snapshot',r.deposit_snapshot,
  'match_snapshot',r.match_snapshot,'category_snapshot',CASE WHEN r.status='draft' AND r.category_list_id IS NOT NULL
    THEN (SELECT jsonb_build_object('id',qa.qb_list_id,'name',qa.full_name,'account_type',qa.account_type)
      FROM qb_account qa WHERE qa.qb_list_id=r.category_list_id AND qa.deleted_at IS NULL
      AND qa.is_active=true AND qa.account_type<>'NonPosting' LIMIT 1)
    ELSE r.category_snapshot END,'origin',r.origin,
  'rule_id',r.rule_id,'rule_version',r.rule_version,'manual_override',r.manual_override,
  'confirmed_by',r.confirmed_by,'confirmed_at',r.confirmed_at,'exclusion_reason',r.exclusion_reason)`;

export type ReviewTransaction = {
  id: string;
  account_id: string;
  transaction_date: string;
  source_version: number;
  amount: string;
  currency: string | null;
  status: string;
  name: string;
  merchant_name: string | null;
  account_type: string;
  review_start_date: string | null;
  opening_bank_balance: string | null;
  opening_reference: string | null;
};
export type ReviewVersions = {
  expected_revision: number;
  expected_source_version: number;
};
