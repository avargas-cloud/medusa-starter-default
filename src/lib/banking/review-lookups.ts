import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import {
  bankingConfig,
  BankingError,
  requireBankingEnabled,
  bankingEnvSql,
} from "./security";

export type Category = { id: string; name: string; account_type: string };
export type Counterparty = {
  id: string;
  type: "vendor" | "customer";
  name: string;
};
const PARTY_SQL = `SELECT id,'vendor'::text AS type,full_name AS name FROM qb_vendor
  WHERE deleted_at IS NULL AND is_active=true
  UNION ALL SELECT id,'customer'::text AS type,
  COALESCE(NULLIF(company_name,''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email,id) AS name
  FROM customer WHERE deleted_at IS NULL`;
const USAGE_FROM = `FROM bank_transaction_review r JOIN bank_transaction t ON t.id=r.transaction_id
  JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
  WHERE r.deleted_at IS NULL AND r.status<>'excluded' AND t.deleted_at IS NULL
    AND t.status<>'removed' AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}`;

export async function validateCategory(
  client: PoolClient,
  listId: string
): Promise<Category> {
  const result = await client.query<Category>(
    `SELECT qb_list_id AS id,full_name AS name,account_type
    FROM qb_account WHERE qb_list_id=$1 AND deleted_at IS NULL AND is_active=true
    AND account_type <> 'NonPosting' FOR SHARE`,
    [listId]
  );
  if (!result.rows[0]) throw new BankingError("BANKING_CATEGORY_INVALID", 409);
  return result.rows[0];
}

export async function validateCounterparty(
  client: PoolClient,
  type: "vendor" | "customer" | null,
  id: string | null
): Promise<Counterparty | null> {
  if (!type && !id) return null;
  if (!type || !id) throw new BankingError("BANKING_COUNTERPARTY_INVALID");
  const sql =
    type === "vendor"
      ? `SELECT id,'vendor'::text AS type,full_name AS name FROM qb_vendor
       WHERE id=$1 AND deleted_at IS NULL AND is_active=true FOR SHARE`
      : `SELECT id,'customer'::text AS type,
       COALESCE(NULLIF(company_name,''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email,id) AS name
       FROM customer WHERE id=$1 AND deleted_at IS NULL FOR SHARE`;
  const result = await client.query<Counterparty>(sql, [id]);
  if (!result.rows[0])
    throw new BankingError("BANKING_COUNTERPARTY_INVALID", 409);
  return result.rows[0];
}

export async function lookupAccounts(
  q: string
): Promise<{ accounts: Category[]; count: number }> {
  if (!bankingConfig().enabled) return { accounts: [], count: 0 };
  requireBankingEnabled();
  const result = await getDbPool().query<{
    accounts: Category[];
    count: string;
  }>(
    `WITH usage_counts AS (
    SELECT r.category_list_id,COUNT(*)::integer AS usage_count,MAX(r.updated_at) AS last_used
    ${USAGE_FROM} AND r.mode='categorize' AND r.category_list_id IS NOT NULL GROUP BY r.category_list_id
  ), matching AS (
    SELECT qa.qb_list_id AS id,qa.full_name AS name,qa.account_type,
      COALESCE(u.usage_count,0) AS usage_count,u.last_used
    FROM qb_account qa LEFT JOIN usage_counts u ON u.category_list_id=qa.qb_list_id
    WHERE qa.deleted_at IS NULL AND qa.is_active=true AND qa.account_type <> 'NonPosting'
    AND ($1::text='' OR qa.full_name ILIKE '%' || $1 || '%')
  ), page AS (SELECT id,name,account_type,usage_count,last_used FROM matching
    ORDER BY usage_count DESC,last_used DESC NULLS LAST,name,id LIMIT 50)
  SELECT (SELECT COUNT(*)::text FROM matching) AS count,
    COALESCE((SELECT jsonb_agg(page ORDER BY usage_count DESC,last_used DESC NULLS LAST,name,id) FROM page),'[]'::jsonb) AS accounts`,
    [q]
  );
  return {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT de agregados sin FROM siempre devuelve exactamente una fila
    accounts: result.rows[0]!.accounts,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- misma fila única del SELECT de agregados de arriba
    count: Number(result.rows[0]!.count),
  };
}

export async function lookupParties(
  q: string
): Promise<{ parties: Counterparty[]; count: number }> {
  if (!bankingConfig().enabled) return { parties: [], count: 0 };
  requireBankingEnabled();
  const result = await getDbPool().query<{
    parties: Counterparty[];
    count: string;
  }>(
    `WITH usage_counts AS (
    SELECT r.counterparty_type,r.counterparty_id,COUNT(*)::integer AS usage_count,MAX(r.updated_at) AS last_used
    ${USAGE_FROM} AND r.counterparty_id IS NOT NULL GROUP BY r.counterparty_type,r.counterparty_id
  ), parties AS (
    ${PARTY_SQL}
  ), matching AS (SELECT p.id,p.type,p.name,COALESCE(u.usage_count,0) AS usage_count,u.last_used
    FROM parties p LEFT JOIN usage_counts u ON u.counterparty_type=p.type AND u.counterparty_id=p.id
    WHERE $1::text='' OR p.name ILIKE '%' || $1 || '%'),
  page AS (SELECT id,type,name,usage_count,last_used FROM matching
    ORDER BY usage_count DESC,last_used DESC NULLS LAST,name,type,id LIMIT 50)
  SELECT (SELECT COUNT(*)::text FROM matching) AS count,
    COALESCE((SELECT jsonb_agg(page ORDER BY usage_count DESC,last_used DESC NULLS LAST,name,type,id) FROM page),'[]'::jsonb) AS parties`,
    [q]
  );
  return {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT de agregados sin FROM siempre devuelve exactamente una fila
    parties: result.rows[0]!.parties,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- misma fila única del SELECT de agregados de arriba
    count: Number(result.rows[0]!.count),
  };
}
