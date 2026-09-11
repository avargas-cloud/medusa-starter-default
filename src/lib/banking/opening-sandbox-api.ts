/**
 * Real HTTP helpers for the owned v10 E2E; never imported by application routes.
 *
 * banking-on-gl: the retired `/admin/banking/accounting/openings*` routes (draft →
 * preview → adopt, one opening per bank/clearing account with its own revision) are
 * gone. The replacement is the GL `opening_balance` document:
 *   POST /admin/accounting/ledger/opening-balances
 *     { account_list_id, day?, balance_cents, evidence_ids[], items?[] }
 * posted ATOMICALLY (no separate preview/adopt step) and idempotent by
 * `(account_list_id)` — a second post with the SAME body returns 409
 * `GL_ALREADY_POSTED` and the existing `entry_id`. There is one active document
 * per account; to post a DIFFERENT balance/items, reverse the active one first
 * (`POST .../opening-balances/:accountListId/reverse`).
 *
 * `openingApiBase` now points at the GL route (kept exported under the same name
 * so callers that only ever used it as a URL prefix — e.g. for `/evidence` —
 * don't need to know the route moved).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { OpeningBalanceItemKind } from "../ledger";

export type TestValue = Record<string, unknown>;
export const openingApiBase = "/admin/accounting/ledger/opening-balances";
const SANDBOX_API_BASE =
  process.env.BANKING_SANDBOX_API_BASE ?? "http://localhost:9099";

export type OpeningBalanceItemInput = {
  key: string;
  kind: OpeningBalanceItemKind;
  original_day: string;
  amount_cents: number;
  reference: string;
  description?: string;
};

export type OpeningBalancePostInput = {
  account_list_id: string;
  day?: string;
  balance_cents: number;
  evidence_ids: string[];
  items?: OpeningBalanceItemInput[];
};

/** One posted GL `opening_balance` document, its lines keyed by `role`
 * (`opening` / `equity` / `uncleared_<key>`), and the underlying journal
 * lines for every `uncleared_<key>` role (id needed to match statement lines
 * against `book_kind: "journal_line"`). */
export type OpeningBalanceAdopted = {
  entry_id: string;
  lines: Record<string, TestValue>;
  uncleared: Record<string, { id: string; role: string }>;
};

export class OpeningSandboxApi {
  checks = 0;
  jwt = "";
  pdfBase64 = "";
  check(value: unknown, label: string): void {
    assert(value, label);
    this.checks++;
    // eslint-disable-next-line no-console -- salida del harness E2E, es el reporte de progreso que consume el operador
    console.log(`PASS ${label}`);
  }
  async api(
    path: string,
    body?: object,
    expected: number | number[] = 200,
    key: string = randomUUID(),
    anonymous = false
  ): Promise<TestValue> {
    const response = await fetch(`${SANDBOX_API_BASE}${path}`, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(60000),
      headers: {
        "Content-Type": "application/json",
        ...(!anonymous && this.jwt
          ? { Authorization: `Bearer ${this.jwt}` }
          : {}),
        ...(body ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = (await response.json()) as TestValue;
    this.check(
      (Array.isArray(expected) ? expected : [expected]).includes(
        response.status
      ),
      `${path}: HTTP ${response.status} expected ${expected}; ${String(result.code ?? result.message ?? "ok")}`
    );
    return result;
  }
  async login(): Promise<void> {
    this.jwt = String(
      (
        await this.api("/auth/user/emailpass", {
          email: "sandbox@test.com",
          password: "sandbox123",
        })
      ).token
    );
    assert(this.jwt);
  }
  async setup(cutDate = "2026-09-01"): Promise<void> {
    const ctx = await this.api("/admin/banking/accounting/setup");
    this.check(ctx.setup === null, "No existing operator setup is replaced");
    const ar = (ctx.ar_accounts as TestValue[])[0];
    const uf = (ctx.clearing_accounts as TestValue[]).find((row) =>
      /undeposited/i.test(String(row.name))
    );
    assert(ar && uf);
    await this.api("/admin/banking/accounting/setup", {
      expected_revision: 0,
      cut_date: cutDate,
      ar_account_list_id: ar.id,
      clearing_account_list_id: uf.id,
      local_usd_attested: true,
    });
  }
  async evidence(name: string): Promise<string> {
    // A real minimal one-page PDF, with byte offsets calculated rather than a fake MIME-only payload.
    const stream =
      "BT /F1 10 Tf 10 50 Td (Synthetic opening evidence only) Tj ET\n";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, content] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${content}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join(
        ""
      )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.pdfBase64 = Buffer.from(pdf).toString("base64");
    const result = await this.api(openingApiBase + "/evidence", {
      name,
      mime_type: "application/pdf",
      content_base64: this.pdfBase64,
    });
    return String((result.evidence as TestValue).id);
  }
  private async activeOpening(accountListId: string): Promise<TestValue> {
    const listed = (await this.api(openingApiBase)) as {
      accounts: TestValue[];
    };
    const row = listed.accounts.find(
      (a) =>
        (a.account as TestValue | undefined)?.qb_list_id === accountListId
    );
    assert(row, `${accountListId} present in opening-balances listing`);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `row` just asserted present above
    return row!.entry as TestValue;
  }
  private static projectOpening(entry: TestValue): OpeningBalanceAdopted {
    const lines = (entry.lines as TestValue[]).reduce<
      Record<string, TestValue>
    >((acc, line) => ({ ...acc, [String(line.role)]: line }), {});
    const uncleared: Record<string, { id: string; role: string }> = {};
    for (const [role, line] of Object.entries(lines)) {
      if (role.startsWith("uncleared_"))
        uncleared[role] = { id: String(line.id), role };
    }
    return { entry_id: String(entry.id), lines, uncleared };
  }
  /** Posts the GL `opening_balance` document for `input.account_list_id`. If
   * one is already active (409 `GL_ALREADY_POSTED`) with the SAME balance and
   * item count, reuse it; if it differs, reverse it first and re-post — an
   * account carries exactly one active opening, there is no "adopt a new
   * revision over the old one" concept anymore. */
  async adopt(input: OpeningBalancePostInput): Promise<OpeningBalanceAdopted> {
    const posted = await this.api(openingApiBase, input, [201, 409]);
    assert(
      String(posted.entry_id ?? "").length > 0,
      "opening balance entry id present (either freshly posted or GL_ALREADY_POSTED)"
    );
    let entry = await this.activeOpening(input.account_list_id);
    if (posted.code === "GL_ALREADY_POSTED") {
      const openingLine = (entry.lines as TestValue[]).find(
        (line) => line.role === "opening"
      );
      const currentBalance = openingLine
        ? Number(openingLine.debit_cents) + Number(openingLine.credit_cents)
        : 0;
      const unclearedCount = (entry.lines as TestValue[]).filter((line) =>
        String(line.role).startsWith("uncleared_")
      ).length;
      const matches =
        currentBalance === input.balance_cents &&
        unclearedCount === (input.items?.length ?? 0);
      if (!matches) {
        await this.revoke(
          input.account_list_id,
          "Sandbox harness: re-adopting with a different balance/items"
        );
        await this.api(openingApiBase, input, 201);
        entry = await this.activeOpening(input.account_list_id);
      }
    }
    return OpeningSandboxApi.projectOpening(entry);
  }
  /** Reverses the active opening balance of `accountListId`; `nothing_to_reverse`
   * (404) and `already_reversed` (409) are both acceptable — the caller only
   * needs the account left WITHOUT the balance it had. */
  async revoke(accountListId: string, reason: string): Promise<TestValue> {
    return this.api(
      `${openingApiBase}/${accountListId}/reverse`,
      { reason },
      [201, 404, 409]
    );
  }
}

/** GL equivalent of the retired `openingItem()`: an `outstanding_check` or
 * `deposit_in_transit` line item for the `items[]` array of an opening-balance
 * POST. `key` replaces the retired `external_key`/`evidence_id`/`payment_id`
 * fields — the GL document has ONE evidence set (`evidence_ids`) for the whole
 * entry, not one per item. */
export const openingItem = (
  kind: OpeningBalanceItemKind,
  cents: number,
  key: string,
  reference: string = key
): OpeningBalanceItemInput => ({
  key,
  kind,
  original_day: "1999-12-31",
  amount_cents: cents,
  reference,
  description: "Synthetic documented opening item",
});

/** The old opening-item flow addressed a `bank_account_id` (an internal
 * `bank_account.id`); the GL route addresses `account_list_id` (the QB List
 * ID). Both call sites that still adopt an opening already hold `client`. */
export async function accountListIdFor(
  client: PoolClient,
  bankAccountId: string
): Promise<string> {
  const row = (
    await client.query<{ qb_list_id: string }>(
      "SELECT qb_list_id FROM bank_account WHERE id=$1",
      [bankAccountId]
    )
  ).rows[0];
  assert(row, `bank_account ${bankAccountId} has a qb_list_id`);
  return row.qb_list_id;
}
