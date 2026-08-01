/**
 * XML escaping for hand-built QBXML.
 *
 * Two near-identical copies of this already live under
 * `src/api/admin/quickbooks/**`. This is the one `src/lib/quickbooks` builders
 * use; the older two are left alone because consolidating them is not this
 * change's job. If you add a third, consolidate instead.
 */
export function escapeXml(value: string): string {
  return value
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
