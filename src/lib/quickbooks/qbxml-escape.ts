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
/**
 * 2026-09-11, second bite of the same bug: the first real `VendorCreditMod`
 * (VC-1002) died with the same HRESULT because its memo carried a MIDDLE DOT
 * (U+00B7, our own separator) and a MULTIPLICATION SIGN (U+00D7, typed by the
 * operator). Probed read-only against the live company file with a fake TxnID
 * plus positive and negative controls: the identical request parses (QB 3120,
 * "object not found") once the memo is plain ASCII, and it fails 0x80040400
 * with `é`, `ñ`, an en dash or curly quotes just the same. So the rule is not
 * "avoid NBSP": through this bridge QuickBooks accepts NOTHING outside 7-bit
 * ASCII, whatever the XML declaration promises. Folding at the boundary keeps
 * the document readable (`×` → `x`, `–` → `-`, `é` → `e`); what has no ASCII
 * shape is dropped rather than shipped — a lost emoji beats a lost document.
 */
const ASCII_FOLDS: Record<string, string> = {
  "\u00A0": " ",
  "\u00B7": "-",
  "\u2022": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u00D7": "x",
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u2032": "'",
  "\u2039": "'",
  "\u203A": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u2033": '"',
  "\u00AB": '"',
  "\u00BB": '"',
  "\u2026": "...",
  "\u00B0": " deg",
  "\u00BC": "1/4",
  "\u00BD": "1/2",
  "\u00BE": "3/4",
  "\u00A9": "(C)",
  "\u00AE": "(R)",
  "\u2122": "(TM)",
  "\u20AC": "EUR",
  "\u00A3": "GBP",
  "\u00B5": "u",
  "\u00DF": "ss",
  "\u00C6": "AE",
  "\u00E6": "ae",
  "\u0152": "OE",
  "\u0153": "oe",
  "\u00D8": "O",
  "\u00F8": "o",
  "\u0141": "L",
  "\u0142": "l",
  "\u0110": "D",
  "\u0111": "d",
};

/** `é` → `e`, `ñ` → `n`: strip the combining marks NFD exposes; anything that
 *  still is not printable ASCII after that has no fold and is dropped. */
function foldToAscii(ch: string): string {
  const mapped = ASCII_FOLDS[ch];
  if (mapped !== undefined) return mapped;
  const base = ch.normalize("NFD").replace(/[\u0300-\u036F]/g, "");
  return /^[\x20-\x7E]+$/.test(base) ? base : "";
}

export function sanitizeForQb(value: string): string {
  return (
    value
      .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[^\u0000-\u007F]/g, foldToAscii)
  );
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
