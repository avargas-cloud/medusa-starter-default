/**
 * Creating a payment term IN QuickBooks.
 *
 * Why this exists: a `VendorMod` carrying a `TermsRef` that QuickBooks does not
 * have in its Terms list is rejected outright. Now that vendors are authored in
 * the POS and pushed to QB, an operator inventing "Net-45" locally would
 * silently produce vendors that can never sync. So creating the term here
 * creates it there.
 *
 * The bridge has NO typed builder for terms — its vendor builder only knows
 * `add` and `query`. These requests therefore go through the raw passthrough
 * (`POST /api/sync/direct-query`), which forwards QBXML verbatim and adds no
 * envelope. That is a feature: no deploy to the remote Windows box is needed.
 *
 * IDEMPOTENCY — read before touching this. A `*TermsAdd` is an ADD, and the
 * project rule is that ADDs are never blindly retried. This one has a property
 * that ordinary ADDs lack: QuickBooks enforces a UNIQUE name on the Terms list,
 * so a duplicate submission is REJECTED (error 3100) rather than minting a
 * second term. That makes "already exists" a success for our purposes and is
 * why `isAlreadyExistsError` is treated as such — but it does NOT license
 * re-sending an ADD whose outcome is unknown for any other reason.
 */

import { bridgeFetch, pollBridgeStatus } from "./bridge-fetch";
import { escapeXml, qbxmlEnvelope } from "./qbxml-escape";

/** QuickBooks caps list-element names at 31 characters. */
export const QB_TERMS_NAME_MAX = 31;

export interface StandardTermInput {
  name: string;
  /** Days from bill date until due. */
  days: number;
}

export interface DateDrivenTermInput {
  name: string;
  /** Day of month the bill comes due, 1-31. */
  dayOfMonthDue: number;
  /** Roll to the following month when the bill lands within this many days. */
  dueNextMonthDays?: number;
}

export class QbTermsAddError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly alreadyExists: boolean
  ) {
    super(message);
    this.name = "QbTermsAddError";
  }
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Term name is required");
  if (trimmed.length > QB_TERMS_NAME_MAX) {
    // Truncating silently would create a term under a name nobody chose, and
    // every vendor pointed at it would carry a TermsRef that does not match.
    throw new Error(
      `Term name "${trimmed}" is ${trimmed.length} characters; QuickBooks allows ${QB_TERMS_NAME_MAX}`
    );
  }
  return trimmed;
}

/**
 * QBXML element order is strict — a wrong order fails the whole request with
 * HRESULT 0x80040400 before QuickBooks looks at any value.
 * StandardTermsAdd: Name → IsActive → StdDueDays → StdDiscountDays → DiscountPct
 */
export function buildStandardTermsAddQbxml(input: StandardTermInput): string {
  const name = assertName(input.name);
  if (
    !Number.isInteger(input.days) ||
    input.days < 0 ||
    input.days > 365
  ) {
    throw new Error(`StdDueDays must be an integer 0-365, got ${input.days}`);
  }
  return qbxmlEnvelope(
    "<StandardTermsAddRq><StandardTermsAdd>" +
      `<Name>${escapeXml(name)}</Name>` +
      "<IsActive>1</IsActive>" +
      `<StdDueDays>${input.days}</StdDueDays>` +
      "</StandardTermsAdd></StandardTermsAddRq>"
  );
}

/**
 * DateDrivenTermsAdd: Name → IsActive → DayOfMonthDue → DueNextMonthDays →
 * DiscountDayOfMonth → DiscountPct
 *
 * `DueNextMonthDays` is REQUIRED by QuickBooks even when zero, unlike most
 * optional elements — omitting it fails the request.
 */
export function buildDateDrivenTermsAddQbxml(
  input: DateDrivenTermInput
): string {
  const name = assertName(input.name);
  if (
    !Number.isInteger(input.dayOfMonthDue) ||
    input.dayOfMonthDue < 1 ||
    input.dayOfMonthDue > 31
  ) {
    throw new Error(
      `DayOfMonthDue must be an integer 1-31, got ${input.dayOfMonthDue}`
    );
  }
  const grace = input.dueNextMonthDays ?? 0;
  if (!Number.isInteger(grace) || grace < 0 || grace > 31) {
    throw new Error(
      `DueNextMonthDays must be an integer 0-31, got ${input.dueNextMonthDays}`
    );
  }
  return qbxmlEnvelope(
    "<DateDrivenTermsAddRq><DateDrivenTermsAdd>" +
      `<Name>${escapeXml(name)}</Name>` +
      "<IsActive>1</IsActive>" +
      `<DayOfMonthDue>${input.dayOfMonthDue}</DayOfMonthDue>` +
      `<DueNextMonthDays>${grace}</DueNextMonthDays>` +
      "</DateDrivenTermsAdd></DateDrivenTermsAddRq>"
  );
}

/**
 * QB 3100 — "The name ... is already in use". For a Terms add this means the
 * term is present, which is the state the caller wanted. Matched on the code
 * AND on the message, because the bridge surfaces errors inconsistently
 * depending on where they were raised.
 */
export function isAlreadyExistsError(
  code: string | null,
  message: string
): boolean {
  if (code === "3100") return true;
  return /already\s+in\s+use|name.*already\s+exists/i.test(message);
}

interface DirectQueryResult {
  statusCode: string | null;
  statusMessage: string;
  response: Record<string, unknown> | undefined;
}

/**
 * Read the status QuickBooks returned for the single request in the envelope.
 *
 * The bridge hands back `operation.result.QBXML.QBXMLMsgsRs` with the response
 * element keyed by name, so the key is not known ahead of time — the caller
 * gets whichever `*Rs` came back.
 */
export function parseDirectQueryStatus(polled: unknown): DirectQueryResult {
  const msgs = (polled as Record<string, any>)?.operation?.result?.QBXML
    ?.QBXMLMsgsRs as Record<string, unknown> | undefined;

  if (!msgs) {
    return { statusCode: null, statusMessage: "", response: undefined };
  }

  const first = Object.values(msgs).find(
    (v) => v && typeof v === "object"
  ) as Record<string, unknown> | undefined;

  const node = Array.isArray(first) ? first[0] : first;
  const rec = (node ?? {}) as Record<string, unknown>;

  return {
    statusCode: rec.statusCode != null ? String(rec.statusCode) : null,
    statusMessage:
      typeof rec.statusMessage === "string" ? rec.statusMessage : "",
    response: rec,
  };
}

export interface CreateTermResult {
  created: boolean;
  /** True when QuickBooks already had a term by this name. */
  alreadyExisted: boolean;
  operationId: string;
}

/**
 * Submit a terms-add and poll it to completion.
 *
 * Never marks success on enqueue — `bridgeFetch` resolves as soon as the bridge
 * accepts the operation, which says nothing about what QuickBooks did with it.
 */
export async function createTermInQuickBooks(
  input: StandardTermInput | DateDrivenTermInput,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<CreateTermResult> {
  const qbxml =
    "days" in input
      ? buildStandardTermsAddQbxml(input)
      : buildDateDrivenTermsAddQbxml(input);

  const enqueued = await bridgeFetch<{ operationId?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 }
  );
  const operationId = enqueued?.operationId;
  if (!operationId) {
    throw new QbTermsAddError(
      "Bridge did not return an operationId for the terms add",
      null,
      false
    );
  }

  const timeoutMs = opts.timeoutMs ?? 2 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const polled = await pollBridgeStatus(operationId);
    if (polled.status === "expired") {
      throw new QbTermsAddError(
        `Terms add ${operationId} expired on the bridge — verify in QuickBooks before retrying`,
        null,
        false
      );
    }
    const op = (polled.data as Record<string, any>)?.operation;
    const status = op?.status;

    if (status === "failed") {
      const message = String(op?.error ?? "Terms add failed on the bridge");
      throw new QbTermsAddError(message, null, false);
    }
    if (status === "completed") {
      const { statusCode, statusMessage } = parseDirectQueryStatus(polled.data);
      if (statusCode === "0" || statusCode === null) {
        return { created: true, alreadyExisted: false, operationId };
      }
      if (isAlreadyExistsError(statusCode, statusMessage)) {
        return { created: false, alreadyExisted: true, operationId };
      }
      throw new QbTermsAddError(
        `QuickBooks rejected the terms add (${statusCode}): ${statusMessage}`,
        statusCode,
        false
      );
    }
  }

  throw new QbTermsAddError(
    `Terms add ${operationId} did not complete within ${Math.round(timeoutMs / 1000)}s — verify in QuickBooks before retrying`,
    null,
    false
  );
}
