import type { PoolClient } from "pg";

import { reviewDate } from "../banking/review-date";
import { BankingError } from "../banking/security";

import type { SqlClient } from "./month-close-data";

/** The same key is used by pg banking commands and knex Month Close writers. */
function periodKey(day: string): string {
  if (!reviewDate.safeParse(day).success)
    throw new BankingError("BANKING_INVALID_ACCOUNTING_DATE");
  return `accounting-period:${day.slice(0, 7)}`;
}

/** Every Banking or Month Close writer acquires banking-review before a period lock. */
export async function acquireBankAccountingPeriodLock(
  client: PoolClient,
  day: string
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7242))",
    [periodKey(day)]
  );
}

/** Compare calendar dates, without casting a business day through the server timezone. */
export async function assertBankAccountingPeriodOpen(
  client: PoolClient,
  day: string
): Promise<void> {
  periodKey(day);
  const closed = await client.query(
    `SELECT id FROM accounting_period_close
    WHERE status='closed' AND $1::date >= period_start AND $1::date < period_end LIMIT 1`,
    [day]
  );
  if (closed.rowCount)
    throw new BankingError("BANKING_ACCOUNTING_PERIOD_CLOSED", 423);
}

export type TransactionalAccountingDb = SqlClient & {
  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
};

/** Return data from the callback; send the HTTP response only after this promise commits. */
export async function withBankAccountingMonthLock<T>(
  db: TransactionalAccountingDb,
  month: string,
  callback: (client: SqlClient) => Promise<T>
): Promise<T> {
  const key = periodKey(`${month}-01`);
  return db.transaction(async (client) => {
    await client.raw(
      "SELECT pg_advisory_xact_lock(hashtextextended('banking-review', 7241))",
      []
    );
    await client.raw(
      "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 7242))",
      [key]
    );
    return callback(client);
  });
}
