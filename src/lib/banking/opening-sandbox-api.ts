/** Real HTTP helpers for the owned v10 E2E; never imported by application routes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { DepositCandidate } from "./deposit-read";
import type { BankDeposit } from "./deposit-types";
import type {
  OpeningContext,
  OpeningItemInput,
  OpeningPreview,
  OpeningSaveInput,
} from "./opening-types";
import type { ReceiptContext } from "./receipts-types";

export type TestValue = Record<string, unknown>;
export const openingApiBase = "/admin/banking/accounting/openings";
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
    const response = await fetch(`http://localhost:9099${path}`, {
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
  async opening(id: string): Promise<OpeningContext> {
    return (await this.api(`${openingApiBase}/${id}`)) as OpeningContext;
  }
  async save(body: OpeningSaveInput): Promise<OpeningContext> {
    return (await this.api(openingApiBase, body)) as OpeningContext;
  }
  async preview(id: string): Promise<OpeningPreview> {
    const context = await this.opening(id);
    return (await this.api(`${openingApiBase}/${id}/preview`, {
      expected_revision: context.opening.revision,
    })) as OpeningPreview;
  }
  async adopt(id: string): Promise<OpeningContext> {
    const preview = await this.preview(id);
    return (await this.api(`${openingApiBase}/${id}/adopt`, {
      expected_revision: preview.revision,
      preview_hash: preview.preview_hash,
      evidence_attested: true,
    })) as OpeningContext;
  }
  async receipt(id: string, deposit = false): Promise<ReceiptContext> {
    return (await this.api(
      `/admin/banking/accounting/${deposit ? "deposits" : "receipts"}/${id}`
    )) as ReceiptContext;
  }
  async postReceipt(id: string, deposit = false): Promise<ReceiptContext> {
    const context = await this.receipt(id, deposit),
      base = `/admin/banking/accounting/${deposit ? "deposits" : "receipts"}/${id}`;
    const body = {
      expected_source_hash: context.source_hash,
      ...(context.source.fee_cents ? { fee_attested: true } : {}),
    };
    const preview = await this.api(base + "/preview", body);
    return (await this.api(base + "/post", {
      ...body,
      preview_hash: preview.preview_hash,
    })) as ReceiptContext;
  }
  async makeDeposit(
    accountId: string,
    reference: string,
    lines: Array<{ id: string; amount: string; opening?: boolean }>,
    feeAccount?: string
  ): Promise<BankDeposit> {
    const candidates = (
      await this.api(
        `/admin/banking/deposit-candidates?account_id=${accountId}&q=${encodeURIComponent("bank_e2e_")}`
      )
    ).candidates as DepositCandidate[];
    const saved = (
      await this.api("/admin/banking/deposits", {
        expected_revision: 0,
        account_id: accountId,
        date: "2026-09-02",
        reference,
        memo: "Owned v10 verification",
        fee_amount: feeAccount ? "2.00" : "0.00",
        fee_account_list_id: feeAccount ?? null,
        fee_reference: feeAccount ? reference + " new fee" : null,
        lines: lines.map((line) => {
          const source = candidates.find((row) => row.id === line.id);
          assert(source, `Candidate available ${line.id}`);
          return {
            ...(line.opening
              ? { opening_item_id: line.id }
              : { payment_id: line.id }),
            amount: line.amount,
            expected_source_hash: source.source_hash,
          };
        }),
      })
    ).deposit as BankDeposit;
    return (
      await this.api(`/admin/banking/deposits/${saved.id}/ready`, {
        expected_revision: saved.revision,
        expected_source_hash: saved.source_hash,
      })
    ).deposit as BankDeposit;
  }
}
export const openingItem = (
  kind: OpeningItemInput["kind"],
  cents: number,
  reference: string,
  evidenceId: string,
  paymentId?: string
): OpeningItemInput => ({
  kind,
  original_day: "1999-12-31",
  amount_cents: cents,
  external_key: reference,
  reference,
  description: "Synthetic documented opening item",
  evidence_id: evidenceId,
  payment_id: paymentId ?? null,
});
