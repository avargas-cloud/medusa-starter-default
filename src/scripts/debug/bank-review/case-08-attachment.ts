/**
 * Case 08 · PDF attachment and replacement: two uploads with the SAME file name on the Utilities row.
 * Proves: only PDFs (magic bytes) are accepted; the second upload REPLACES the first (one current; the previous file is
 * deleted — operator rule 2026-09-09: no PDF history); the replace event keeps only the old file's metadata;
 * download is authenticated and byte-exact.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, API, type Json } from "./_lib";

function tinyPdf(text: string): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length + 40} >>\nstream\nBT /F1 14 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

void run("case-08", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).utilities!;
  const versions = () => baseAccount(api, pool).then(b => ({ expected_revision: Number(record(b.utilities!.review)?.revision ?? 0), expected_source_version: Number(b.utilities!.source_version) }));
  const name = "FPL-factura-2026-09.pdf";
  const first = tinyPdf("FPL invoice v1 - Caso 08"), second = tinyPdf("FPL invoice v2 (replacement) - Caso 08");
  const notPdf = await api.call(`/admin/banking/transactions/${tx.id}/attachments`, { method: "POST", allow: [400], headers: { "Idempotency-Key": `case-08-${randomUUID()}` },
    body: { ...(await versions()), name, mime_type: "application/pdf", content_base64: Buffer.from("hello, not a pdf").toString("base64") } });
  const up1 = await api.post(`/admin/banking/transactions/${tx.id}/attachments`, { ...(await versions()), name, mime_type: "application/pdf", content_base64: first.toString("base64") }, { "Idempotency-Key": `case-08-${randomUUID()}` });
  const up2 = await api.post(`/admin/banking/transactions/${tx.id}/attachments`, { ...(await versions()), name, mime_type: "application/pdf", content_base64: second.toString("base64") }, { "Idempotency-Key": `case-08-${randomUUID()}` });
  const a1 = record(up1.attachment) ?? {}, a2 = record(up2.attachment) ?? {};
  const detail = await api.get(`/admin/banking/transactions/${tx.id}/review`);
  const current = (detail.attachments as Json[]);
  const history = await pool.query<{ id: string; original_name: string; sha256: string; detached: boolean }>(
    "SELECT id,original_name,sha256,(detached_at IS NOT NULL) AS detached FROM bank_review_attachment WHERE transaction_id=$1 AND deleted_at IS NULL ORDER BY created_at", [tx.id]);
  const anon = await fetch(`${API}/admin/banking/attachments/${a2.id}/download`);
  const dl = await fetch(`${API}/admin/banking/attachments/${a2.id}/download`, { headers: { Authorization: `Bearer ${api.jwt}` } });
  const bytes = Buffer.from(await dl.arrayBuffer());
  const row = (await baseAccount(api, pool)).utilities!;
  const events = ((await api.get(`/admin/banking/transactions/${tx.id}/review`)).events as Json[]).map(e => e.action).filter(a => String(a).startsWith("attachment"));

  assert.equal(notPdf.status, 400, "non-PDF bytes are refused even with a .pdf name");
  assert.equal(current.length, 1, "exactly one current attachment"); assert.equal(current[0]!.id, a2.id);
  assert.equal(history.rowCount, 1, "the replaced PDF is gone from the table (no history of superseded files)");
  assert.equal(history.rows[0]!.id, a2.id);
  const replacedEvent = ((await api.get(`/admin/banking/transactions/${tx.id}/review`)).events as Json[]).find(e => e.action === "attachment_replaced");
  assert(JSON.stringify(replacedEvent?.details).includes(createHash("sha256").update(first).digest("hex")), "the replace event records the old file's sha256, not its bytes");
  assert.equal(anon.status, 401, "download without a session is refused");
  assert.equal(dl.status, 200); assert.equal(dl.headers.get("content-type")?.split(";")[0], "application/pdf");
  assert(bytes.equals(second), "download returns the replacement byte-for-byte");
  assert.equal(row.attachment_count, 1, "feed row counts one PDF");
  assert.equal(await journalCount(pool), 0);

  block("Qué hice", { transaction_id: tx.id, uploads: [{ name, bytes: first.length, sha256: a1.sha256 }, { name, bytes: second.length, sha256: a2.sha256 }], rejected_first: "texto plano con nombre .pdf", downloads: ["sin sesión", "con sesión"] });
  block("Qué esperamos", { not_pdf: { status: notPdf.status, code: notPdf.body.code }, current_attachments: current.map(a => ({ id: a.id, name: a.original_name, size: a.size_bytes })),
    history: history.rows, download: { anonymous_status: anon.status, authenticated_status: dl.status, content_type: dl.headers.get("content-type"), byte_exact: bytes.equals(second) },
    feed_row_attachment_count: row.attachment_count, events, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → fila 2026-09-02 · columna PDF (1 vigente: FPL-factura-2026-09.pdf, se descarga con tu sesión); el anterior ya no existe; historial: attachment_added → attachment_replaced");
});
