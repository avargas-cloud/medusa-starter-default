/**
 * XML escaping for hand-built QBXML.
 *
 * Two near-identical copies of this already live under
 * `src/api/admin/quickbooks/**`. This is the one `src/lib/quickbooks` builders
 * use; the older two are left alone because consolidating them is not this
 * change's job. If you add a third, consolidate instead.
 */
/**
 * Characters that are legal XML but that QuickBooks' parser rejects, turning a
 * whole request into HRESULT 0x80040400 — the error that says "malformed XML"
 * and therefore sends you hunting for a syntax bug that is not there.
 *
 * Found the hard way on 2026-08-01: vendor "SLT Ligthing (EDECON)" carried three
 * U+00A0 NON-BREAKING SPACES in its Addr2 (34 bytes for 31 characters). Its
 * VendorMod was the only one of 25 to fail, and bisecting the request proved it:
 * dropping the address made QB parse the same XML happily. The bytes were valid
 * UTF-8 and the characters are legal per the XML 1.0 spec — QuickBooks simply
 * does not accept them.
 *
 * Non-breaking spaces arrive by themselves whenever someone pastes an address
 * from a web page or Word, so this is normalisation at the boundary, not a
 * one-off patch: NBSP becomes a plain space (it reads identically and carries
 * no meaning in an address), zero-width marks and BOMs are dropped outright,
 * and control characters — illegal in XML to begin with — go too.
 */
function sanitizeForQb(value: string): string {
  return value
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function escapeXml(value: string): string {
  return sanitizeForQb(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The envelope the bridge's `raw` passthrough does NOT add.
 *
 * `POST /api/sync/direct-query` forwards `qbxml` VERBATIM — unlike the typed
 * builders, which wrap the body themselves. Sending a bare `<TermsQueryRq/>`
 * dies with QB HRESULT 0x80040400, and that exact mistake once produced the
 * conclusion that QB Terms were unreachable from the bridge.
 */
export function qbxmlEnvelope(body: string, version = "10.0"): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<?qbxml version="${version}"?>` +
    '<QBXML><QBXMLMsgsRq onError="stopOnError">' +
    body +
    "</QBXMLMsgsRq></QBXML>"
  );
}
