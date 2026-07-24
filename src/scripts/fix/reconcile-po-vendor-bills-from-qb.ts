/**
 * src/scripts/fix/reconcile-po-vendor-bills-from-qb.ts
 *
 * Phase 1a reconciliation for the vendor-bill → QuickBooks feature
 * (docs/VENDOR_BILL_QB_SYNC_PLAN.md §10, enabled by §4.3's bulk BillQuery).
 *
 * Many POs already have a Bill entered by hand in QB Desktop. This script
 * does ONE bulk, paged `BillQuery(IncludeLinkedTxns=true)` sweep (never a
 * per-PO query — D5, too slow), builds the PO↔Bill map locally, classifies
 * every "relevant" PO (submitted/partially_received/received, synced to QB),
 * and — in `apply` mode — ADOPTS already-billed POs by inserting a read-only
 * `vendor_bill` header row (`qb_source='adopted'`) so the UI can show
 * "already billed, nothing to do" instead of silently re-billing.
 *
 * This is why the reconciliation pass must run BEFORE/DURING Phase 1 (§9
 * transition hazard #1): Phase 1's bill poller hard-blocks any `BillAdd` for
 * a PO that already has a synced ItemReceipt or a non-adopted linked Bill in
 * QB — without this classification, that gate has nothing to check against.
 *
 * Scope, safety:
 *   - READ-ONLY against QuickBooks. Only `POST /api/bills/query` (BillQuery)
 *     and `GET /api/sync/status/:opId` are called — never a write endpoint.
 *   - `apply` mode only INSERTs `vendor_bill` rows for QB Bills that don't
 *     already have a matching row (idempotent — re-running skips them).
 *     It NEVER updates/deletes an existing `vendor_bill` row.
 *   - Adopted rows get NO `vendor_bill_line` rows and NO `number` (they don't
 *     consume the gapless VB-#### counter — they're a QB-Bill-shaped header
 *     the UI resolves by `qb_ref_number`/`qb_txn_id`, not a bill we authored).
 *   - Runs no migrations.
 *
 * Modes:
 *   dry-run (default) — classify + report only, no writes anywhere.
 *   apply              — also INSERT the adopted `vendor_bill` header rows.
 *   parseonly          — skip the QB bridge entirely; classify purely from
 *                         Postgres (buckets `clean`/`received_unbilled_legacy`
 *                         only — the QB side is treated as empty). Lets the
 *                         Postgres wiring be smoke-tested before the bridge's
 *                         `/api/bills/query` route is deployed.
 *   Args are positional words, NOT `--flags` (medusa exec's CLI parser eats
 *   dashes) — combine as needed, e.g. `apply parseonly` is nonsensical and
 *   parseonly wins (apply is ignored when parseonly is set, since there is
 *   nothing QB-sourced to adopt).
 *
 * Usage (from backend/):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/reconcile-po-vendor-bills-from-qb.ts            # dry-run
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/reconcile-po-vendor-bills-from-qb.ts apply      # apply
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/reconcile-po-vendor-bills-from-qb.ts parseonly  # PG-only smoke test
 *
 * Full JSON report always written to /tmp/reconcile-po-vendor-bills-report.json.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { writeFileSync } from "fs";
import { generateEntityId } from "@medusajs/utils";

// ─── Config ─────────────────────────────────────────────────────────────────

const REPORT_PATH = "/tmp/reconcile-po-vendor-bills-report.json";
const ITERATOR_PAGE_SIZE = 200;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

// ─── Postgres row shapes ────────────────────────────────────────────────────

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

interface PoRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  qb_purchase_order_list_id: string;
}

interface ExistingBillRow {
  id: string;
  purchase_order_id: string;
  number: string | null;
  status: string;
  qb_txn_id: string | null;
  qb_source: string | null;
  bill_type: string;
}

// ─── QB BillQuery shapes (bridge route pending deploy — parsed defensively) ─

interface QbLinkedTxn {
  TxnID?: string;
  TxnType?: string;
}

interface QbBillRet {
  TxnID?: string;
  TimeCreated?: string;
  RefNumber?: string;
  TxnDate?: string;
  EditSequence?: string;
  VendorRef?: { ListID?: string; FullName?: string };
  AmountDue?: string;
  ItemLineRet?: unknown;
  ExpenseLineRet?: unknown;
  LinkedTxn?: unknown;
}

interface ParsedBill {
  txnId: string;
  refNumber: string | null;
  txnDate: string | null;
  editSequence: string | null;
  vendorFullName: string | null;
  amountDue: string | null;
  linkedPoTxnIds: string[];
  /** Sum of ItemLineRet Quantity, or null if any line's qty wasn't parseable. */
  itemQtySum: number | null;
}

/** Normalizes a QBXML dict-or-array field into an array (empty when absent). */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseBillRet(raw: QbBillRet): ParsedBill | null {
  if (!raw.TxnID) return null;
  const linked = asArray<QbLinkedTxn>(raw.LinkedTxn as QbLinkedTxn | QbLinkedTxn[]);
  const linkedPoTxnIds = linked
    .filter((l) => l.TxnType === "PurchaseOrder" && l.TxnID)
    .map((l) => String(l.TxnID));

  const itemLines = asArray<Record<string, unknown>>(
    raw.ItemLineRet as Record<string, unknown> | Record<string, unknown>[]
  );
  let itemQtySum: number | null = itemLines.length > 0 ? 0 : null;
  for (const line of itemLines) {
    const q = Number(line.Quantity);
    if (!Number.isFinite(q)) {
      itemQtySum = null;
      break;
    }
    itemQtySum = (itemQtySum ?? 0) + q;
  }

  return {
    txnId: raw.TxnID,
    refNumber: raw.RefNumber ?? null,
    txnDate: raw.TxnDate ?? null,
    editSequence: raw.EditSequence ?? null,
    vendorFullName: raw.VendorRef?.FullName ?? null,
    amountDue: raw.AmountDue ?? null,
    linkedPoTxnIds,
    itemQtySum,
  };
}

// ─── Bridge polling ─────────────────────────────────────────────────────────

function bridgeEnv(): { url: string; key: string } {
  const url = process.env.QB_BRIDGE_URL;
  const key = process.env.QB_API_KEY;
  if (!url || !key) {
    throw new Error(
      "QB_BRIDGE_URL and/or QB_API_KEY are not set in the environment — " +
        "cannot query QuickBooks. Source .env before running, or pass " +
        "`parseonly` to smoke-test the Postgres side without the bridge."
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

async function bridgePost(
  path: string,
  body: unknown
): Promise<{ operationId?: string }> {
  const { url, key } = bridgeEnv();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "bypass-tunnel-reminder": "true",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`Bridge POST ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

async function pollUntilDone(
  operationId: string,
  log: (msg: string) => void
): Promise<unknown> {
  const { url, key } = bridgeEnv();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${url}/api/sync/status/${operationId}`, {
      headers: { "x-api-key": key, "bypass-tunnel-reminder": "true" },
    });
    if (!res.ok) {
      log(`  poll ${operationId} → HTTP ${res.status}, retrying`);
      continue;
    }
    const json = (await res.json()) as {
      operation?: { status?: string; error?: string; result?: unknown };
    };
    const op = json.operation;
    if (!op) continue;
    if (op.status === "completed") return op.result;
    if (op.status === "failed") {
      throw new Error(`QB operation ${operationId} failed: ${op.error ?? "unknown"}`);
    }
    log(`  poll ${operationId} → ${op.status ?? "queued"}`);
  }
  throw new Error(`QB operation ${operationId} did not complete within ${POLL_TIMEOUT_MS}ms`);
}

/** Reads a BillQueryRs iterator attribute across likely parser shapes. */
function readIteratorAttr(billQueryRs: Record<string, unknown>, name: string): unknown {
  return (
    billQueryRs[name] ??
    (billQueryRs.$ as Record<string, unknown> | undefined)?.[name] ??
    (billQueryRs["@_" + name] as unknown)
  );
}

function extractBillQueryRs(result: unknown): Record<string, unknown> | null {
  const r = result as Record<string, unknown> | null | undefined;
  const msgs =
    (r?.QBXML as Record<string, unknown> | undefined)?.QBXMLMsgsRs ??
    r?.QBXMLMsgsRs ??
    r ??
    {};
  const rs = (msgs as Record<string, unknown>)?.BillQueryRs;
  return (rs as Record<string, unknown>) ?? null;
}

/** One bulk, paged BillQuery(IncludeLinkedTxns=true) sweep — never per-PO (§10, D5). */
async function fetchAllQbBills(log: (msg: string) => void): Promise<ParsedBill[]> {
  const out: ParsedBill[] = [];
  let iterator: "Start" | "Continue" = "Start";
  let iteratorId: string | undefined;
  let page = 0;

  for (;;) {
    page++;
    const body =
      iterator === "Start"
        ? { iterator: "Start", max_returned: ITERATOR_PAGE_SIZE }
        : { iterator_id: iteratorId, max_returned: ITERATOR_PAGE_SIZE };
    log(`BillQuery page ${page} (${iterator})...`);
    const { operationId } = await bridgePost("/api/bills/query", body);
    if (!operationId) throw new Error("Bridge returned no operationId for /api/bills/query");
    const result = await pollUntilDone(operationId, log);

    const billQueryRs = extractBillQueryRs(result);
    if (!billQueryRs) {
      log(`  page ${page}: no BillQueryRs in response, stopping`);
      break;
    }
    const rawBills = asArray<QbBillRet>(
      billQueryRs.BillRet as QbBillRet | QbBillRet[] | undefined
    );
    for (const raw of rawBills) {
      const parsed = parseBillRet(raw);
      if (parsed) out.push(parsed);
    }
    log(`  page ${page}: ${rawBills.length} bill(s), ${out.length} total so far`);

    const remaining = Number(readIteratorAttr(billQueryRs, "iteratorRemainingCount") ?? 0);
    const nextId = readIteratorAttr(billQueryRs, "iteratorID");
    if (!Number.isFinite(remaining) || remaining <= 0 || !nextId) break;
    iterator = "Continue";
    iteratorId = String(nextId);
  }
  return out;
}

// ─── Postgres loaders ───────────────────────────────────────────────────────

async function loadRelevantPOs(pg: KnexLike): Promise<PoRow[]> {
  const { rows } = await pg.raw(`
    SELECT id, number, status, vendor_id, vendor_name_snapshot,
           vendor_qb_list_id_snapshot, qb_purchase_order_list_id
      FROM purchase_order
     WHERE deleted_at IS NULL
       AND status IN ('submitted', 'partially_received', 'received')
       AND qb_purchase_order_list_id IS NOT NULL
     ORDER BY number`);
  return rows as unknown as PoRow[];
}

async function loadSyncedReceiptCounts(pg: KnexLike): Promise<Map<string, number>> {
  const { rows } = await pg.raw(`
    SELECT purchase_order_id, COUNT(*)::int AS cnt
      FROM purchase_order_receipt
     WHERE qb_item_receipt_list_id IS NOT NULL
       AND voided_at IS NULL
       AND deleted_at IS NULL
     GROUP BY purchase_order_id`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.purchase_order_id), Number(r.cnt));
  return map;
}

async function loadReceivedQty(pg: KnexLike): Promise<Map<string, number>> {
  const { rows } = await pg.raw(`
    SELECT purchase_order_id, COALESCE(SUM(qty_received), 0)::int AS qty
      FROM purchase_order_line
     WHERE deleted_at IS NULL
     GROUP BY purchase_order_id`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.purchase_order_id), Number(r.qty));
  return map;
}

async function loadExistingBills(pg: KnexLike): Promise<Map<string, ExistingBillRow[]>> {
  const { rows } = await pg.raw(`
    SELECT id, purchase_order_id, number, status, qb_txn_id, qb_source, bill_type
      FROM vendor_bill
     WHERE deleted_at IS NULL
       AND purchase_order_id IS NOT NULL`);
  const map = new Map<string, ExistingBillRow[]>();
  for (const r of rows as unknown as ExistingBillRow[]) {
    const list = map.get(r.purchase_order_id) ?? [];
    list.push(r);
    map.set(r.purchase_order_id, list);
  }
  return map;
}

// ─── Classification ─────────────────────────────────────────────────────────

type Bucket =
  | "clean"
  | "received_unbilled_legacy"
  | "adopted_full"
  | "adopted_partial"
  | "needs_manual";

interface Classification {
  po: PoRow;
  bucket: Bucket;
  linkedBills: ParsedBill[];
  syncedReceiptCount: number;
  existingBillCount: number;
  receivedQty: number;
  quantityUncertain: boolean;
  anomalies: string[];
  toAdopt: ParsedBill[];
}

function findAnomalies(
  po: PoRow,
  linkedBills: ParsedBill[],
  existing: ExistingBillRow[],
  billPoLinkCount: (txnId: string) => number
): string[] {
  const anomalies: string[] = [];

  for (const bill of linkedBills) {
    const ownedMatch = existing.find(
      (e) => e.qb_txn_id === bill.txnId && e.qb_source == null
    );
    if (ownedMatch) {
      anomalies.push(
        `Bill ${bill.txnId} already tracked as OUR vendor_bill ${ownedMatch.id} (qb_source=NULL)`
      );
    }
    if (billPoLinkCount(bill.txnId) > 1) {
      anomalies.push(`Bill ${bill.txnId} links >1 relevant PO`);
    }
  }

  const refCounts = new Map<string, number>();
  for (const b of linkedBills) {
    if (!b.refNumber) continue;
    refCounts.set(b.refNumber, (refCounts.get(b.refNumber) ?? 0) + 1);
  }
  for (const [ref, count] of refCounts) {
    if (count > 1) anomalies.push(`${count} bills share RefNumber "${ref}" on PO ${po.number}`);
  }

  return anomalies;
}

function classify(
  po: PoRow,
  linkedBills: ParsedBill[],
  syncedReceiptCount: number,
  existing: ExistingBillRow[],
  receivedQty: number,
  anomalies: string[]
): Classification {
  const existingBillCount = existing.length;

  if (anomalies.length > 0) {
    return {
      po,
      bucket: "needs_manual",
      linkedBills,
      syncedReceiptCount,
      existingBillCount,
      receivedQty,
      quantityUncertain: false,
      anomalies,
      toAdopt: [],
    };
  }

  if (linkedBills.length === 0) {
    const bucket: Bucket = syncedReceiptCount > 0 ? "received_unbilled_legacy" : "clean";
    return {
      po,
      bucket,
      linkedBills,
      syncedReceiptCount,
      existingBillCount,
      receivedQty,
      quantityUncertain: false,
      anomalies,
      toAdopt: [],
    };
  }

  const toAdopt = linkedBills.filter(
    (b) => !existing.some((e) => e.qb_txn_id === b.txnId)
  );

  const allQtyParseable = linkedBills.every((b) => b.itemQtySum != null);
  let bucket: Bucket;
  let quantityUncertain = false;
  if (allQtyParseable) {
    const billedQty = linkedBills.reduce((sum, b) => sum + (b.itemQtySum ?? 0), 0);
    bucket = billedQty >= receivedQty && receivedQty > 0 ? "adopted_full" : "adopted_partial";
  } else {
    quantityUncertain = true;
    bucket = "adopted_partial";
  }

  return {
    po,
    bucket,
    linkedBills,
    syncedReceiptCount,
    existingBillCount,
    receivedQty,
    quantityUncertain,
    anomalies,
    toAdopt,
  };
}

// ─── Adopt (apply mode) ─────────────────────────────────────────────────────

async function adoptBill(
  pg: KnexLike,
  po: PoRow,
  bill: ParsedBill
): Promise<void> {
  const id = generateEntityId("", "vb");
  const documentDate = bill.txnDate ? `${bill.txnDate}T12:00:00Z` : null;
  await pg.raw(
    `
    INSERT INTO vendor_bill (
      id, purchase_order_id, vendor_id, vendor_name_snapshot,
      vendor_qb_list_id_snapshot, bill_type, status, qb_source,
      qb_txn_id, qb_edit_sequence, qb_ref_number, reference_id,
      document_date, qb_synced_at, number, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, 'regular', 'synced', 'adopted',
      ?, ?, ?, ?,
      ?, NOW(), NULL, NOW(), NOW()
    )`,
    [
      id,
      po.id,
      po.vendor_id,
      po.vendor_name_snapshot,
      po.vendor_qb_list_id_snapshot,
      bill.txnId,
      bill.editSequence,
      bill.refNumber,
      bill.refNumber,
      documentDate,
    ]
  );
}

// ─── Report ─────────────────────────────────────────────────────────────────

function fmtBillList(bills: ParsedBill[]): string {
  if (bills.length === 0) return "-";
  return bills.map((b) => `${b.refNumber ?? "?"}@${b.txnId} ($${b.amountDue ?? "?"})`).join(", ");
}

function printReport(classifications: Classification[], ignoredBillCount: number, apply: boolean): void {
  const buckets: Bucket[] = [
    "clean",
    "received_unbilled_legacy",
    "adopted_full",
    "adopted_partial",
    "needs_manual",
  ];

  console.log("\n=== PO ↔ QB Bill reconciliation ===\n");
  for (const bucket of buckets) {
    const rows = classifications.filter((c) => c.bucket === bucket);
    if (rows.length === 0) continue;
    console.log(`--- ${bucket} (${rows.length}) ---`);
    for (const c of rows) {
      const action =
        c.toAdopt.length === 0
          ? "none"
          : apply
            ? `adopted ${c.toAdopt.length} bill(s)`
            : `WOULD adopt ${c.toAdopt.length} bill(s)`;
      const flags = [
        c.quantityUncertain ? "qty-uncertain" : null,
        ...c.anomalies,
      ]
        .filter(Boolean)
        .join(" | ");
      console.log(
        `  PO ${(c.po.number ?? c.po.id).padEnd(10)} | bills: ${fmtBillList(c.linkedBills)} | ` +
          `receipts synced: ${c.syncedReceiptCount} | existing VB rows: ${c.existingBillCount} | ` +
          `action: ${action}${flags ? ` | ${flags}` : ""}`
      );
    }
    console.log("");
  }

  const totals = buckets.map((b) => `${b}=${classifications.filter((c) => c.bucket === b).length}`);
  console.log("--- Totals ---");
  console.log(`  ${totals.join(", ")}, total relevant POs=${classifications.length}`);
  console.log(`  Bills ignored (no relevant linked PO): ${ignoredBillCount}`);
  console.log(`\nFull report: ${REPORT_PATH}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

export default async function reconcilePoVendorBillsFromQb({
  container,
  args,
}: ExecArgs): Promise<void> {
  const argv = args || [];
  const apply = argv.includes("apply");
  const parseonly = argv.includes("parseonly");
  const log = (msg: string) => console.log(msg);

  const pg = container.resolve("__pg_connection__") as unknown as KnexLike;

  console.log(`Mode: ${parseonly ? "PARSEONLY (Postgres-only smoke test)" : apply ? "APPLY" : "DRY-RUN"}`);

  const [pos, syncedReceipts, existingBills, receivedQty] = await Promise.all([
    loadRelevantPOs(pg),
    loadSyncedReceiptCounts(pg),
    loadExistingBills(pg),
    loadReceivedQty(pg),
  ]);
  console.log(`Loaded ${pos.length} relevant PO(s) (submitted/partially_received/received, QB-synced).`);

  const bills = parseonly ? [] : await fetchAllQbBills(log);
  if (!parseonly) console.log(`QB BillQuery returned ${bills.length} bill(s) total.`);

  const relevantTxnIds = new Set(pos.map((p) => p.qb_purchase_order_list_id));
  const billsByPoTxnId = new Map<string, ParsedBill[]>();
  let ignoredBillCount = 0;

  const billPoLinkCount = new Map<string, number>();
  for (const bill of bills) {
    const relevantLinks = bill.linkedPoTxnIds.filter((t) => relevantTxnIds.has(t));
    billPoLinkCount.set(bill.txnId, relevantLinks.length);
    if (relevantLinks.length === 0) {
      ignoredBillCount++;
      continue;
    }
    for (const txnId of relevantLinks) {
      const list = billsByPoTxnId.get(txnId) ?? [];
      list.push(bill);
      billsByPoTxnId.set(txnId, list);
    }
  }
  const linkCount = (txnId: string) => billPoLinkCount.get(txnId) ?? 0;

  const classifications: Classification[] = [];
  for (const po of pos) {
    const linkedBills = billsByPoTxnId.get(po.qb_purchase_order_list_id) ?? [];
    const existing = existingBills.get(po.id) ?? [];
    const anomalies = findAnomalies(po, linkedBills, existing, linkCount);
    classifications.push(
      classify(
        po,
        linkedBills,
        syncedReceipts.get(po.id) ?? 0,
        existing,
        receivedQty.get(po.id) ?? 0,
        anomalies
      )
    );
  }

  if (apply && !parseonly) {
    for (const c of classifications) {
      if (c.bucket !== "adopted_full" && c.bucket !== "adopted_partial") continue;
      for (const bill of c.toAdopt) {
        await adoptBill(pg, c.po, bill);
        console.log(`  ADOPTED PO ${c.po.number} ← Bill ${bill.refNumber ?? "?"}@${bill.txnId}`);
      }
    }
  }

  printReport(classifications, ignoredBillCount, apply && !parseonly);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: parseonly ? "parseonly" : apply ? "apply" : "dry-run",
        totalRelevantPOs: classifications.length,
        ignoredBillCount,
        classifications: classifications.map((c) => ({
          poId: c.po.id,
          poNumber: c.po.number,
          bucket: c.bucket,
          syncedReceiptCount: c.syncedReceiptCount,
          existingBillCount: c.existingBillCount,
          receivedQty: c.receivedQty,
          quantityUncertain: c.quantityUncertain,
          anomalies: c.anomalies,
          linkedBills: c.linkedBills.map((b) => ({
            txnId: b.txnId,
            refNumber: b.refNumber,
            txnDate: b.txnDate,
            amountDue: b.amountDue,
            itemQtySum: b.itemQtySum,
          })),
          adoptedTxnIds: c.toAdopt.map((b) => b.txnId),
        })),
      },
      null,
      2
    )
  );
}
