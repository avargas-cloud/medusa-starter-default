import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadOpeningAccountMap } from "../accounts";
import {
  buildOpeningBalanceLines,
  OpeningBalanceItem,
} from "../lines/opening-balance";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerAccount, LedgerError, PostResult, ReverseResult } from "../types";

/** Banking-on-GL §2/§3: cuentas de balance elegibles para un OBE. */
export const OPENING_BALANCE_ACCOUNT_TYPES = [
  "Bank",
  "AccountsReceivable",
  "OtherCurrentAsset",
  "FixedAsset",
  "OtherAsset",
  "AccountsPayable",
  "CreditCard",
  "OtherCurrentLiability",
  "LongTermLiability",
  "Equity",
] as const;

/**
 * `2025-12-31` cierre — el corte del libro (Banking-on-GL §2, movido el
 * 2026-09-11 desde `2026-04-13`): con el reporte General Ledger de QuickBooks
 * importado desde el 1 de enero (qb-gl-import), la apertura va al cierre del
 * ejercicio anterior. Sigue fuera de la ventana del replay (`GL_REPLAY_FROM`).
 */
export const DEFAULT_OPENING_DAY = "2025-12-31";

type AccountRow = {
  qb_list_id: string;
  account_number: string | null;
  full_name: string;
  account_type: string;
  normal_balance: string | null;
};

async function loadEligibleAccount(
  client: PoolClient,
  accountListId: string
): Promise<{ account: LedgerAccount; account_number: string | null }> {
  const { rows } = await client.query<AccountRow>(
    `SELECT qb_list_id, account_number, full_name, account_type, normal_balance
     FROM qb_account
     WHERE qb_list_id = $1 AND is_active = true AND deleted_at IS NULL
       AND account_type = ANY($2::text[])
     LIMIT 1`,
    [accountListId, OPENING_BALANCE_ACCOUNT_TYPES]
  );
  const row = rows[0];
  if (!row)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "account_not_eligible",
      account_list_id: accountListId,
    });
  return {
    account: {
      id: row.qb_list_id,
      name: row.full_name,
      account_type: row.account_type,
      currency: "USD",
      normal_balance:
        row.normal_balance === "debit" || row.normal_balance === "credit"
          ? row.normal_balance
          : null,
    },
    account_number: row.account_number,
  };
}

type EvidenceRow = { id: string; original_name: string; sha256: string };

async function loadEvidence(
  client: PoolClient,
  evidenceIds: string[]
): Promise<EvidenceRow[]> {
  if (evidenceIds.length === 0)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "no_evidence" });
  const unique = [...new Set(evidenceIds)];
  const { rows } = await client.query<EvidenceRow>(
    `SELECT id, original_name, sha256 FROM bank_opening_evidence
     WHERE id = ANY($1::text[]) AND deleted_at IS NULL AND mime_type = 'application/pdf'`,
    [unique]
  );
  if (rows.length !== unique.length)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "evidence_not_found_or_not_pdf",
      requested: unique,
      found: rows.map((r) => r.id),
    });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)!);
}

export interface PostOpeningBalanceInput {
  account_list_id: string;
  /** YYYY-MM-DD en ET; default `2025-12-31` (`DEFAULT_OPENING_DAY`, §2). */
  day?: string;
  balance_cents: bigint;
  evidence_ids: string[];
  items: OpeningBalanceItem[];
  actor_id: string;
}

/**
 * Banking-on-GL §2/§4 — postea el documento `opening_balance` de una cuenta
 * de balance: carga la cuenta y `opening_balance_equity` (la única key que
 * este documento exige — §6, key opcional), arma las líneas puras, y las
 * lleva al motor. `source_snapshot` congela cuenta + saldo + items + la
 * evidencia (nombre y sha256, nunca el PDF) para que un futuro repin del
 * trial balance no dependa de que `bank_opening_evidence` siga viva.
 */
export async function postOpeningBalance(
  client: PoolClient,
  input: PostOpeningBalanceInput
): Promise<PostResult> {
  const day = input.day ?? DEFAULT_OPENING_DAY;
  const { account, account_number } = await loadEligibleAccount(
    client,
    input.account_list_id
  );
  const map = await loadOpeningAccountMap(client);
  const evidence = await loadEvidence(client, input.evidence_ids);

  const lines = buildOpeningBalanceLines({
    account,
    balance_cents: input.balance_cents,
    items: input.items,
    equity: map.opening_balance_equity,
  });

  const sourceSnapshot = {
    account,
    balance_cents: input.balance_cents.toString(),
    items: input.items.map((item) => ({
      ...item,
      amount_cents: item.amount_cents.toString(),
    })),
    evidence: evidence.map((e) => ({
      id: e.id,
      name: e.original_name,
      sha256: e.sha256,
    })),
  };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "opening_balance",
    source_id: input.account_list_id,
    document_number: `OBE-${account_number ?? input.account_list_id}`,
    day,
    reference: `Opening balance ${account.name} ${day}`,
    description: `Opening balance ${account.name} ${day}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: input.actor_id,
  });
}

/**
 * Reversa el OBE activo de una cuenta. El día de la reversa es hoy (ET) salvo
 * que el asiento original tenga una fecha POSTERIOR a hoy — `gl_document_source_unique`
 * rechaza `NEW.day < original.day`, así que en ese caso se usa la fecha original.
 */
export async function reverseOpeningBalance(
  client: PoolClient,
  accountListId: string,
  reason: string,
  actorId: string
): Promise<ReverseResult> {
  // La fecha del asiento MÁS RECIENTE, activo o ya reversado — a diferencia
  // de `activeDocumentEntry`, esto no filtra por reversado: si ya se
  // reversó, `reverseDocumentJournal` de abajo es quien tiene que contestar
  // `already_reversed` (necesita ver el original para eso), no esta función
  // adelantándose con un `nothing_to_reverse` que perdería la distinción.
  const { rows } = await client.query<{ day: string }>(
    `SELECT day FROM bank_journal_entry
     WHERE source_kind = 'opening_balance' AND source_id = $1 AND kind = 'document'
     ORDER BY created_at DESC LIMIT 1`,
    [accountListId]
  );
  const originalDay = rows[0]?.day;
  if (!originalDay) return { status: "nothing_to_reverse" };

  const today = getBusinessDateString();
  const day = originalDay > today ? originalDay : today;

  return reverseDocumentJournal(client, {
    source_kind: "opening_balance",
    source_id: accountListId,
    day,
    reason,
    actor_id: actorId,
  });
}

interface EntryRow {
  id: string;
  source_id: string;
  day: string;
  amount_cents: string;
  reference: string;
  description: string;
  actor_id: string;
  posted_by: string | null;
  created_at: string;
  source_snapshot: {
    items?: Array<Record<string, unknown>>;
    evidence?: Array<{ id: string; name: string; sha256: string }>;
  };
}

interface LineRow {
  entry_id: string;
  role: string;
  account_list_id: string;
  account_snapshot: Record<string, unknown>;
  debit_cents: string;
  credit_cents: string;
}

export interface OpeningBalanceListItem {
  account: {
    qb_list_id: string;
    account_number: string | null;
    name: string;
    account_type: string;
    normal_balance: string | null;
  };
  entry: {
    id: string;
    day: string;
    amount_cents: string;
    reference: string;
    description: string;
    actor_id: string;
    posted_by: string | null;
    created_at: string;
    lines: Array<{
      role: string;
      account_list_id: string;
      account_snapshot: Record<string, unknown>;
      debit_cents: string;
      credit_cents: string;
    }>;
    items: Array<Record<string, unknown>>;
    evidence: Array<{ id: string; name: string; sha256: string }>;
  } | null;
}

/**
 * Toda cuenta de balance elegible con su OBE activo (o `null` si nunca se
 * posteó), más si `opening_balance_equity` resuelve — la pantalla lo muestra
 * en rojo si no, tal como especifica §6.
 */
export async function listOpeningBalances(client: PoolClient): Promise<{
  equity: { mapped: boolean; account: LedgerAccount | null };
  accounts: OpeningBalanceListItem[];
}> {
  const { rows: accounts } = await client.query<AccountRow>(
    `SELECT qb_list_id, account_number, full_name, account_type, normal_balance
     FROM qb_account
     WHERE is_active = true AND deleted_at IS NULL AND account_type = ANY($1::text[])
     ORDER BY account_type, account_number NULLS LAST, full_name`,
    [OPENING_BALANCE_ACCOUNT_TYPES]
  );

  const listIds = accounts.map((a) => a.qb_list_id);
  const entries: EntryRow[] = listIds.length
    ? (
        await client.query<EntryRow>(
          `SELECT e.id, e.source_id, e.day, e.amount_cents::text, e.reference, e.description,
                  e.actor_id, e.posted_by, e.created_at::text, e.source_snapshot
           FROM bank_journal_entry e
           WHERE e.source_kind = 'opening_balance' AND e.source_id = ANY($1::text[])
             AND e.kind = 'document'
             AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)`,
          [listIds]
        )
      ).rows
    : [];
  const entryBySource = new Map(entries.map((e) => [e.source_id, e]));

  const entryIds = entries.map((e) => e.id);
  const lines: LineRow[] = entryIds.length
    ? (
        await client.query<LineRow>(
          `SELECT entry_id, role, account_list_id, account_snapshot,
                  debit_cents::text, credit_cents::text
           FROM bank_journal_line WHERE entry_id = ANY($1::text[]) ORDER BY entry_id, role`,
          [entryIds]
        )
      ).rows
    : [];
  const linesByEntry = new Map<string, LineRow[]>();
  for (const line of lines) {
    const bucket = linesByEntry.get(line.entry_id) ?? [];
    bucket.push(line);
    linesByEntry.set(line.entry_id, bucket);
  }

  // The equity key is optional for listing: an unmapped environment shows the banner instead of failing.
  let equity: { mapped: boolean; account: LedgerAccount | null } = { mapped: false, account: null };
  try {
    const map = await loadOpeningAccountMap(client);
    equity = { mapped: true, account: map.opening_balance_equity };
  } catch (error) {
    if (!(error instanceof LedgerError && error.code === "GL_ACCOUNT_MAP_MISSING")) throw error;
  }

  return {
    equity,
    accounts: accounts.map((row) => {
      const entry = entryBySource.get(row.qb_list_id);
      return {
        account: {
          qb_list_id: row.qb_list_id,
          account_number: row.account_number,
          name: row.full_name,
          account_type: row.account_type,
          normal_balance:
            row.normal_balance === "debit" || row.normal_balance === "credit"
              ? row.normal_balance
              : null,
        },
        entry: entry
          ? {
              id: entry.id,
              day: entry.day,
              amount_cents: entry.amount_cents,
              reference: entry.reference,
              description: entry.description,
              actor_id: entry.actor_id,
              posted_by: entry.posted_by,
              created_at: entry.created_at,
              lines: (linesByEntry.get(entry.id) ?? []).map((line) => ({
                role: line.role,
                account_list_id: line.account_list_id,
                account_snapshot: line.account_snapshot,
                debit_cents: line.debit_cents,
                credit_cents: line.credit_cents,
              })),
              items: entry.source_snapshot.items ?? [],
              evidence: entry.source_snapshot.evidence ?? [],
            }
          : null,
      };
    }),
  };
}
