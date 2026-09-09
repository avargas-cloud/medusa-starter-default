import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { openingClearProjection } from "./opening-guards";
import { stableReviewHash, withReviewLock } from "./review-common";
import { reviewDate, reviewToday } from "./review-date";
import { REVIEW_JOINS, REVIEW_SELECT_SQL } from "./review-projection";
import { BankingError, requireBankingEnabled, bankingEnvSql } from "./security";
import { transaction } from "./store";
import type { BankAccountView, BankTransactionView } from "./views";

type DailyAccount = BankAccountView & {
  history_complete: boolean;
  last_synced_at: Date | null;
  connection_status: string;
};
type AttachmentEvidence = {
  id: string;
  transaction_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
};
type DailyTransaction = BankTransactionView & {
  attachments: AttachmentEvidence[];
};
export type DailyTotal = {
  currency: string;
  money_in: string;
  money_out: string;
  net: string;
};
export type DailyBlock = {
  account: BankAccountView;
  transactions: DailyTransaction[];
  pending_count: number;
  totals: DailyTotal[];
  applicable: boolean;
};
export type DailySnapshot = { date: string; accounts: DailyBlock[] };
export type DailyHistory = {
  revision: number;
  status: "closed";
  closed_by: string | null;
  closed_at: Date | string | null;
  reopened_by: string;
  reopened_at: string;
  reopen_reason: string;
  snapshot: DailySnapshot;
  input_hash: string;
};
export type DayClose = {
  id: string;
  day: string;
  revision: number;
  status: "open" | "closed";
  snapshot: DailySnapshot | null;
  input_hash: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  needs_review: boolean;
  history: DailyHistory[];
};

type DailyEvidenceAccount = Pick<
  BankAccountView,
  | "id"
  | "connection_id"
  | "type"
  | "currency"
  | "qb_list_id"
  | "review_start_date"
  | "setup_revision"
  | "opening_bank_balance"
  | "opening_balance_date"
  | "opening_reference"
  | "opening_book_balance"
>;
type DailyEvidenceTransaction = Omit<
  DailyTransaction,
  "day_closed" | "review_status"
>;
type DailyEvidenceBlock = {
  account: DailyEvidenceAccount;
  transactions: DailyEvidenceTransaction[];
};

/** Presentation order, current balances and selection do not amend historical evidence. */
export function dailyEvidence(snapshot: DailySnapshot): DailyEvidenceBlock[] {
  return snapshot.accounts
    .map((block) => ({
      account: {
        id: block.account.id,
        connection_id: block.account.connection_id,
        type: block.account.type,
        currency: block.account.currency,
        qb_list_id: block.account.qb_list_id,
        review_start_date: block.account.review_start_date,
        setup_revision: block.account.setup_revision,
        opening_bank_balance: block.account.opening_bank_balance,
        opening_balance_date: block.account.opening_balance_date,
        opening_reference: block.account.opening_reference,
        opening_book_balance: block.account.opening_book_balance,
      },
      transactions: block.transactions
        .map(({ day_closed: _closed, review_status: _status, ...row }) => row)
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.account.id.localeCompare(b.account.id));
}

type DailyDifferences = {
  added_transaction_ids: string[];
  removed_transaction_ids: string[];
  changed_transaction_ids: string[];
  changed_account_ids: string[];
};

export function dailyDifferences(
  previous: DailySnapshot,
  current: DailySnapshot
): DailyDifferences {
  const before = dailyEvidence(previous);
  const after = dailyEvidence(current);
  const oldRows = new Map(
    before.flatMap((block) => block.transactions).map((row) => [row.id, row])
  );
  const newRows = new Map(
    after.flatMap((block) => block.transactions).map((row) => [row.id, row])
  );
  const oldAccounts = new Map(
    before.map((block) => [block.account.id, block.account])
  );
  const newAccounts = new Map(
    after.map((block) => [block.account.id, block.account])
  );
  return {
    added_transaction_ids: [...newRows.keys()]
      .filter((id) => !oldRows.has(id))
      .sort(),
    removed_transaction_ids: [...oldRows.keys()]
      .filter((id) => !newRows.has(id))
      .sort(),
    changed_transaction_ids: [...newRows.keys()]
      .filter(
        (id) =>
          oldRows.has(id) &&
          stableReviewHash(oldRows.get(id)) !==
            stableReviewHash(newRows.get(id))
      )
      .sort(),
    changed_account_ids: [
      ...new Set([...oldAccounts.keys(), ...newAccounts.keys()]),
    ]
      .filter(
        (id) =>
          !oldAccounts.has(id) ||
          !newAccounts.has(id) ||
          stableReviewHash(oldAccounts.get(id)) !==
            stableReviewHash(newAccounts.get(id))
      )
      .sort(),
  };
}

export async function loadDayClose(
  client: PoolClient,
  date: string
): Promise<DayClose | null> {
  return (
    (
      await client.query<DayClose>(
        `SELECT id,day,revision,status,snapshot,input_hash,
    closed_by,closed_at,needs_review,history FROM bank_day_close WHERE day=$1 AND deleted_at IS NULL`,
        [date]
      )
    ).rows[0] ?? null
  );
}

type DailyInputs = {
  snapshot: DailySnapshot;
  input_hash: string;
  blockers: string[];
};

/** Bounded Sandbox universe: all accounts, irrespective of the selection in Banks. */
export async function loadDailyInputs(
  client: PoolClient,
  date: string
): Promise<DailyInputs> {
  const accounts = (
    await client.query<DailyAccount>(`SELECT a.id,a.connection_id,a.name,a.mask,
    a.type,a.subtype,a.currency,a.is_active,a.is_selected AS selected,a.qb_list_id,
    a.balances->>'current' AS current_balance,a.balances->>'available' AS available_balance,
    a.review_start_date,a.opening_bank_balance,a.opening_balance_date,a.opening_reference,
    a.opening_book_balance,a.setup_revision,c.historical_sync_complete AS history_complete,
    c.last_successful_sync_at AS last_synced_at,c.status AS connection_status
    FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
    WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
    ORDER BY a.connection_id,a.name,a.id`)
  ).rows;
  const rows = (
    await client.query<BankTransactionView>(
      `SELECT ${REVIEW_SELECT_SQL}
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
    JOIN bank_connection c ON c.id=a.connection_id ${REVIEW_JOINS}
    WHERE t.transaction_date=$1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} ORDER BY t.account_id,t.id`,
      [date]
    )
  ).rows;
  const attachments = (
    await client.query<AttachmentEvidence>(
      `SELECT att.id,att.transaction_id,
    att.original_name,att.mime_type,att.size_bytes,att.sha256,att.uploaded_by
    FROM bank_review_attachment att JOIN bank_transaction t ON t.id=att.transaction_id
    JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.transaction_date=$1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} AND att.deleted_at IS NULL
      AND att.detached_at IS NULL ORDER BY att.id`,
      [date]
    )
  ).rows;
  // SUM in numeric preserves cents and separate currencies; no attachment/event join multiplies money.
  const totals = (
    await client.query<DailyTotal & { account_id: string }>(
      `SELECT t.account_id,t.currency,
    COALESCE(SUM(-t.amount::numeric) FILTER (WHERE t.amount::numeric<0),0)::text AS money_in,
    COALESCE(SUM(t.amount::numeric) FILTER (WHERE t.amount::numeric>0),0)::text AS money_out,
    SUM(-t.amount::numeric)::text AS net FROM bank_transaction t
    JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.transaction_date=$1 AND t.status='posted' AND t.deleted_at IS NULL
      AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
      AND t.currency IS NOT NULL GROUP BY t.account_id,t.currency ORDER BY t.account_id,t.currency`,
      [date]
    )
  ).rows;
  const blockers: string[] = [];
  if (date > reviewToday()) blockers.push("Future days cannot be closed.");
  if (!accounts.length)
    blockers.push("Connect a bank account before closing a day.");
  let applicableCount = 0;
  const blocks: DailyBlock[] = accounts.map((source) => {
    const { history_complete, last_synced_at, connection_status, ...account } =
      source;
    const applicable =
      !account.review_start_date || account.review_start_date <= date;
    const transactions = rows
      .filter((row) => row.account_id === account.id)
      .map((row) => ({
        ...row,
        attachments: attachments.filter((att) => att.transaction_id === row.id),
      }));
    const pending = transactions.filter(
      (row) =>
        row.status === "posted" &&
        (row.stale ||
          !row.review ||
          !["confirmed", "excluded"].includes(row.review.status))
    ).length;
    if (applicable) {
      applicableCount++;
      if (
        !account.review_start_date ||
        account.opening_bank_balance === null ||
        !account.opening_reference
      ) {
        blockers.push(
          `${account.name}: Set the start date and opening balance with its reference.`
        );
      }
      if (!history_complete || !last_synced_at)
        blockers.push(
          `${account.name}: Wait for the initial bank history sync.`
        );
      if (
        account.is_active &&
        (!last_synced_at ||
          Date.now() - new Date(last_synced_at).getTime() > 26 * 3600000)
      ) {
        blockers.push(`${account.name}: Update the bank feed before closing.`);
      }
      if (account.is_active && connection_status !== "active")
        blockers.push(`${account.name}: Resolve the bank connection status.`);
      if (pending)
        blockers.push(
          `${account.name}: ${pending} settled movement(s) need review.`
        );
      if (transactions.some((row) => row.status === "posted" && !row.currency))
        blockers.push(`${account.name}: A movement has no currency.`);
    }
    return {
      account,
      transactions,
      pending_count: applicable ? pending : 0,
      applicable,
      totals: totals
        .filter((total) => total.account_id === account.id)
        .map(({ currency, money_in, money_out, net }) => ({
          currency,
          money_in,
          money_out,
          net,
        })),
    };
  });
  if (accounts.length && !applicableCount)
    blockers.push("This day is before the review start date of every account.");
  const snapshot: DailySnapshot = { date, accounts: blocks };
  // Live balances, selection, sync timestamps and closed UI flags are not evidence of this day's review.
  const evidence = dailyEvidence(snapshot);
  return {
    snapshot,
    input_hash: stableReviewHash({ date, evidence }),
    blockers,
  };
}

type ReviewAccountBlock = Omit<DailyBlock, "transactions"> & {
  transactions: Array<
    DailyTransaction & {
      opening_clear?: { id: string; item_id: string; reference: string };
    }
  >;
};
type ReadDailyReviewResult = {
  date: string;
  status: "open" | "closed";
  revision: number;
  input_hash: string;
  can_close: boolean;
  blockers: string[];
  accounts: ReviewAccountBlock[];
  closed_by: string | null;
  closed_at: Date | null;
  needs_review: boolean;
  differences: DailyDifferences | null;
  history: Omit<DailyHistory, "snapshot" | "input_hash">[];
};

export async function readDailyReview(
  date: string
): Promise<ReadDailyReviewResult> {
  requireBankingEnabled();
  if (!reviewDate.safeParse(date).success)
    throw new BankingError("BANKING_DATE_INVALID", 400);
  const client = await getDbPool().connect();
  try {
    return await transaction(client, async () => {
      await withReviewLock(client);
      const day = await loadDayClose(client, date);
      const live = await loadDailyInputs(client, date);
      const closed = day?.status === "closed";
      const needsReview =
        closed && (day.needs_review || day.input_hash !== live.input_hash);
      const accounts = [];
      for (const block of closed
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- closed implica status==="closed"; todo día cerrado persiste su snapshot al cerrar (invariante de negocio), nunca queda closed sin snapshot
          day.snapshot!.accounts
        : live.snapshot.accounts) {
        accounts.push({
          ...block,
          transactions: await openingClearProjection(
            client,
            block.transactions
          ),
        });
      }
      return {
        date,
        status: day?.status ?? "open",
        revision: day?.revision ?? 0,
        input_hash: live.input_hash,
        can_close: !closed && live.blockers.length === 0,
        blockers: closed ? [] : live.blockers,
        accounts,
        closed_by: day?.closed_by ?? null,
        closed_at: day?.closed_at ?? null,
        needs_review: needsReview,
        differences: closed
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- mismo invariante: closed implica snapshot persistido (review-daily.ts escribe status y snapshot juntos)
            dailyDifferences(day.snapshot!, live.snapshot)
          : null,
        history: (day?.history ?? []).map(
          ({ snapshot: _snapshot, input_hash: _hash, ...entry }) => entry
        ),
      };
    });
  } finally {
    client.release();
  }
}
