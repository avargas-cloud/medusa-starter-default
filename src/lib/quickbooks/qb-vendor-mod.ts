/**
 * Pushing a vendor EDIT to QuickBooks.
 *
 * Until 2026-08-01 the rule was the opposite: `PATCH /admin/qb-catalog/vendors/:id`
 * deliberately never touched QuickBooks, because QB owned vendor data and the
 * POS only mirrored it. The owner reversed that — vendors are now authored in
 * the POS — so a term changed here has to reach QuickBooks or the two drift.
 *
 * The bridge has no `VendorMod` builder (its vendor builder knows only `add`
 * and `query`), so this goes through the raw passthrough. No deploy to the
 * remote Windows box required.
 *
 * FULL SNAPSHOT, NOT A PATCH. The Mod carries every field the Add carries, even
 * the ones nobody edited. QBXML documents VendorMod as leaving omitted optional
 * elements unchanged, but this codebase has already been burned by trusting
 * exactly that reading on BillMod — where omission DELETES — and the cost was a
 * bill silently going short against a payment that still had to clear. Sending
 * what the Add sent is the rule the project settled on; it costs nothing here.
 */

import { bridgeFetch, pollBridgeStatus } from "./bridge-fetch";
import { parseDirectQueryStatus } from "./qb-terms-add";
import { escapeXml, qbxmlEnvelope } from "./qbxml-escape";

const QB_NAME_MAX = 41;
const QB_COMPANY_MAX = 41;

/** QuickBooks rejects a Mod whose EditSequence is stale. */
export const QB_EDIT_SEQUENCE_STALE_CODES = new Set(["3200", "3210"]);

export interface QbVendorAddress {
  Addr1?: string | null;
  Addr2?: string | null;
  City?: string | null;
  State?: string | null;
  PostalCode?: string | null;
  Country?: string | null;
}

/** The vendor snapshot a Mod sends. Mirrors what the bridge's VendorAdd takes. */
export interface QbVendorSnapshot {
  qb_list_id: string;
  name: string;
  company_name?: string | null;
  first_name?: string | null;
  middle_initial?: string | null;
  last_name?: string | null;
  contact?: string | null;
  alt_contact?: string | null;
  name_on_check?: string | null;
  account_number?: string | null;
  notes?: string | null;
  email?: string | null;
  phone?: string | null;
  alt_phone?: string | null;
  fax?: string | null;
  tax_identity?: string | null;
  is_vendor_eligible_for_1099?: boolean | null;
  credit_limit?: number | string | null;
  vendor_type_ref_name?: string | null;
  /** The payment term's name, exactly as QuickBooks spells it. */
  terms_ref_name?: string | null;
  is_active?: boolean | null;
  address?: QbVendorAddress | null;
}

function trunc(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const tag = (name: string, value: string | null): string =>
  value == null ? "" : `<${name}>${escapeXml(value)}</${name}>`;

function renderAddress(addr: QbVendorAddress | null | undefined): string {
  if (!addr) return "";
  const parts = [
    tag("Addr1", trunc(addr.Addr1, 41)),
    tag("Addr2", trunc(addr.Addr2, 41)),
    tag("City", trunc(addr.City, 31)),
    tag("State", trunc(addr.State, 21)),
    tag("PostalCode", trunc(addr.PostalCode, 13)),
    tag("Country", trunc(addr.Country, 31)),
  ].filter(Boolean);
  return parts.length ? `<VendorAddress>${parts.join("")}</VendorAddress>` : "";
}

/**
 * QB SDK VendorMod element order is STRICT. A wrong order fails the whole
 * request with HRESULT 0x80040400 before QuickBooks looks at the vendor at all:
 *
 *   ListID → EditSequence → Name → IsActive → CompanyName → Salutation →
 *   FirstName → MiddleInitial → LastName → VendorAddress → Phone → AltPhone →
 *   Fax → Email → Contact → AltContact → NameOnCheck → AccountNumber → Notes →
 *   VendorTypeRef → TermsRef → CreditLimit → VendorTaxIdent →
 *   IsVendorEligibleFor1099
 */
export function buildVendorModQbxml(
  vendor: QbVendorSnapshot,
  editSequence: string
): string {
  const listId = vendor.qb_list_id?.trim();
  if (!listId) throw new Error("VendorMod requires a QuickBooks ListID");
  if (listId.startsWith("pending_")) {
    throw new Error(
      `Vendor ${vendor.name} has a placeholder ListID (${listId}) — it was never created in QuickBooks, so there is nothing to modify`
    );
  }
  if (!editSequence?.trim()) {
    throw new Error("VendorMod requires an EditSequence");
  }
  const name = trunc(vendor.name, QB_NAME_MAX);
  if (!name) throw new Error("VendorMod requires a vendor Name");

  const creditLimit =
    vendor.credit_limit == null || vendor.credit_limit === ""
      ? null
      : Number(vendor.credit_limit);
  if (creditLimit != null && !Number.isFinite(creditLimit)) {
    throw new Error(`CreditLimit is not a number: ${vendor.credit_limit}`);
  }

  const body =
    "<VendorModRq><VendorMod>" +
    tag("ListID", listId) +
    tag("EditSequence", editSequence.trim()) +
    tag("Name", name) +
    `<IsActive>${vendor.is_active === false ? 0 : 1}</IsActive>` +
    tag("CompanyName", trunc(vendor.company_name, QB_COMPANY_MAX)) +
    tag("FirstName", trunc(vendor.first_name, 25)) +
    tag("MiddleInitial", trunc(vendor.middle_initial, 5)) +
    tag("LastName", trunc(vendor.last_name, 25)) +
    renderAddress(vendor.address) +
    tag("Phone", trunc(vendor.phone, 21)) +
    tag("AltPhone", trunc(vendor.alt_phone, 21)) +
    tag("Fax", trunc(vendor.fax, 21)) +
    tag("Email", trunc(vendor.email, 1023)) +
    tag("Contact", trunc(vendor.contact, 41)) +
    tag("AltContact", trunc(vendor.alt_contact, 41)) +
    tag("NameOnCheck", trunc(vendor.name_on_check, 41)) +
    tag("AccountNumber", trunc(vendor.account_number, 99)) +
    tag("Notes", trunc(vendor.notes, 4095)) +
    refTag("VendorTypeRef", vendor.vendor_type_ref_name) +
    refTag("TermsRef", vendor.terms_ref_name) +
    (creditLimit == null
      ? ""
      : `<CreditLimit>${creditLimit.toFixed(2)}</CreditLimit>`) +
    tag("VendorTaxIdent", trunc(vendor.tax_identity, 15)) +
    (vendor.is_vendor_eligible_for_1099 == null
      ? ""
      : `<IsVendorEligibleFor1099>${vendor.is_vendor_eligible_for_1099 ? 1 : 0}</IsVendorEligibleFor1099>`) +
    "</VendorMod></VendorModRq>";

  return qbxmlEnvelope(body);
}

function refTag(element: string, fullName: string | null | undefined): string {
  const value = trunc(fullName, 159);
  return value == null
    ? ""
    : `<${element}><FullName>${escapeXml(value)}</FullName></${element}>`;
}

/** VendorQuery narrowed to one ListID — the cheapest way to read an EditSequence. */
export function buildVendorEditSequenceQuery(listId: string): string {
  return qbxmlEnvelope(
    `<VendorQueryRq><ListID>${escapeXml(listId)}</ListID>` +
      "<IncludeRetElement>ListID</IncludeRetElement>" +
      "<IncludeRetElement>EditSequence</IncludeRetElement>" +
      "<IncludeRetElement>Name</IncludeRetElement>" +
      "</VendorQueryRq>"
  );
}

export function parseVendorEditSequence(polled: unknown): string | null {
  const { response } = parseDirectQueryStatus(polled);
  const ret = response?.VendorRet as
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined;
  const first = Array.isArray(ret) ? ret[0] : ret;
  const seq = first?.EditSequence;
  return typeof seq === "string" && seq ? seq : null;
}

async function runDirectQuery(
  qbxml: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<unknown> {
  const enqueued = await bridgeFetch<{ operationId?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 }
  );
  const operationId = enqueued?.operationId;
  if (!operationId) {
    throw new Error("Bridge did not return an operationId");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const polled = await pollBridgeStatus(operationId);
    if (polled.status === "expired") {
      throw new Error(`Bridge operation ${operationId} expired`);
    }
    const status = (polled.data as Record<string, any>)?.operation?.status;
    if (status === "failed") {
      throw new Error(
        String(
          (polled.data as Record<string, any>)?.operation?.error ??
            "Bridge operation failed"
        )
      );
    }
    if (status === "completed") return polled.data;
  }
  throw new Error(
    `Bridge operation ${operationId} did not complete within ${Math.round(timeoutMs / 1000)}s`
  );
}

export interface VendorModResult {
  ok: boolean;
  /** Fresh EditSequence QuickBooks returned, worth caching. */
  editSequence: string | null;
  statusCode: string | null;
  statusMessage: string;
  attempts: number;
}

/**
 * Send the Mod, healing one stale-EditSequence rejection.
 *
 * The EditSequence is QuickBooks' optimistic lock: it changes whenever the
 * record is edited, including by a human in QB Desktop. One refetch-and-retry
 * is the established pattern here. It stops at one on purpose — a second 3200
 * means something is editing the vendor concurrently, and looping would just
 * race it.
 *
 * A VendorMod is safe to retry in a way an ADD is not: it is idempotent by
 * construction, since it carries the complete target state rather than a delta.
 */
export async function pushVendorModToQuickBooks(
  vendor: QbVendorSnapshot,
  opts: {
    editSequence?: string | null;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<VendorModResult> {
  const timeoutMs = opts.timeoutMs ?? 2 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;

  let editSequence = opts.editSequence?.trim() || null;
  let attempts = 0;
  let lastStatus: { code: string | null; message: string } = {
    code: null,
    message: "",
  };

  for (let pass = 0; pass < 2; pass++) {
    if (!editSequence) {
      const queried = await runDirectQuery(
        buildVendorEditSequenceQuery(vendor.qb_list_id),
        timeoutMs,
        pollIntervalMs
      );
      editSequence = parseVendorEditSequence(queried);
      if (!editSequence) {
        throw new Error(
          `QuickBooks returned no EditSequence for vendor ${vendor.name} (${vendor.qb_list_id}) — it may have been deleted there`
        );
      }
    }

    attempts++;
    const polled = await runDirectQuery(
      buildVendorModQbxml(vendor, editSequence),
      timeoutMs,
      pollIntervalMs
    );
    const { statusCode, statusMessage, response } =
      parseDirectQueryStatus(polled);

    if (statusCode === "0" || statusCode === null) {
      return {
        ok: true,
        editSequence: parseVendorEditSequence(polled) ?? editSequence,
        statusCode,
        statusMessage,
        attempts,
      };
    }

    lastStatus = { code: statusCode, message: statusMessage };
    void response;

    if (QB_EDIT_SEQUENCE_STALE_CODES.has(statusCode)) {
      // Someone edited this vendor between our read and our write. Refetch once.
      editSequence = null;
      continue;
    }
    break;
  }

  return {
    ok: false,
    editSequence: null,
    statusCode: lastStatus.code,
    statusMessage: lastStatus.message,
    attempts,
  };
}
