import { addReviewAttachment, validateReviewAttachment } from "../../lib/banking/review-attachments";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const body = { name: "bank statement.pdf", mime_type: "application/pdf", content_base64: pdf.toString("base64") };
const code = (value: unknown) => value instanceof Error && "code" in value ? value.code : null;
function rejected(patch: Partial<typeof body>, expected: string) {
  try { validateReviewAttachment({ ...body, ...patch }); throw new Error("VALIDATION_DID_NOT_REJECT"); }
  catch (error) { expect(code(error)).toBe(expected); }
}

describe("Private review attachment boundary", () => {
  it("returns the exact evidence bytes without normalization", () => {
    expect(validateReviewAttachment(body)).toEqual(pdf);
  });
  test.each(["../statement.pdf", "folder/statement.pdf", "folder\\statement.pdf", "bad\r\nHeader.pdf", "\0file.pdf", " ", "x".repeat(201)])(
    "rejects path/header filename %j", name => rejected({ name }, "BANKING_ATTACHMENT_NAME_INVALID"));
  test.each(["text/html", "image/svg+xml", "application/octet-stream", "image/png", "image/jpeg"])(
    "rejects MIME inconsistent with PDF bytes %s", mime_type => rejected({ mime_type }, "BANKING_ATTACHMENT_TYPE_INVALID"));
  test.each(["", "%%%?", "YWJj\n", "data:application/pdf;base64,JVBERg==", "JVBERg=", "JVBERg==="])(
    "rejects malformed base64 %s", content_base64 => rejected({ content_base64 }, "BANKING_ATTACHMENT_INVALID"));
  it("rejects noncanonical base64 padding bits", () => {
    rejected({ content_base64: "JVBERi==" }, "BANKING_ATTACHMENT_SIZE_INVALID");
  });
  it("rejects a forged extension/MIME over arbitrary executable bytes", () => {
    rejected({ content_base64: Buffer.from("<script>alert(1)</script>").toString("base64") }, "BANKING_ATTACHMENT_TYPE_INVALID");
  });
  it("accepts exactly 5 MiB and rejects 5 MiB plus one byte", () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0x20); pdf.copy(bytes);
    expect(validateReviewAttachment({ ...body, content_base64: bytes.toString("base64") }).length).toBe(bytes.length);
    rejected({ content_base64: Buffer.concat([bytes, Buffer.from("x")]).toString("base64") }, "BANKING_ATTACHMENT_SIZE_INVALID");
  });
  it.each([
    ["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ffe0"],
  ])("preserves validation for historical %s downloads", (mime_type, hex) => {
    const bytes = Buffer.from(hex, "hex");
    expect(validateReviewAttachment({ ...body, mime_type, content_base64: bytes.toString("base64") })).toEqual(bytes);
  });
  it.each(["image/png", "image/jpeg", "text/html"])("rejects new %s uploads before any database write", async mime_type => {
    await expect(addReviewAttachment("unused", "unused", "unused", {
      ...body, mime_type, expected_revision: 0, expected_source_version: 1,
    })).rejects.toMatchObject({ code: "BANKING_ATTACHMENT_TYPE_INVALID" });
  });
});
