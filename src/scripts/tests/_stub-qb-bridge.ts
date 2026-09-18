/**
 * _stub-qb-bridge — a QuickBooks bridge impersonator for sandbox E2Es.
 *
 * WHY THIS EXISTS
 * The sandbox points QB_BRIDGE_URL at http://localhost:9999/disabled, so every
 * QB call dies on connection-refused BEFORE the payload is built. That is fine
 * when you only care that nothing reaches QuickBooks, and useless when the thing
 * under test IS the payload — which applications would we send, and how many
 * times.
 *
 * WHAT MAKES IT HONEST
 * It does not answer "OK" to everything. It keeps a per-document EditSequence and
 * enforces QuickBooks' optimistic lock: a ReceivePaymentMod carrying a stale
 * EditSequence is rejected with the verbatim `QuickBooks Error 3200` envelope the
 * live bridge returns. So a duplicate dispatch does not merely show up as a
 * second line in a log — it FAILS, exactly the way it failed in production on
 * 2026-07-30 (op df50b55c, order 2866 / PAY-3309 / INV-21259).
 *
 * Every request is appended to a JSONL journal so a test can count dispatches per
 * (txnId, invoiceId) instead of trusting console output.
 *
 * Run:
 *   ./node_modules/.bin/tsx src/scripts/tests/_stub-qb-bridge.ts [port] [journal]
 * Defaults: port 9999, journal /tmp/stub-qb-bridge.jsonl
 */
import { createServer, type IncomingMessage, type Server } from "http";
import { appendFileSync, writeFileSync } from "fs";

type Op = {
  id: string;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  /**
   * Epoch ms before which this op reports `processing`. Used to hold a payment
   * ADD open long enough that the invoice confirms while the SERVER's direct-exec
   * is still polling it — the exact 7-second overlap that produced the real
   * collision on 2026-07-30 and that cannot be hit reliably by luck.
   */
  completeAfter?: number;
};

/** ms to hold a payment ADD in `processing`. 0 = complete immediately. */
const PAYMENT_ADD_DELAY_MS = Number(process.env.STUB_PAYMENT_ADD_DELAY_MS ?? 0);

export type StubState = {
  /** TxnID → current EditSequence, the optimistic-lock token. */
  editSequences: Map<string, string>;
  /** TxnID → applications currently on that ReceivePayment. */
  applied: Map<string, Array<{ invoiceId: string; amount: number }>>;
  ops: Map<string, Op>;
  journalPath: string;
  seq: number;
  /** direct-query: force the NEXT request to be rejected by QB, or to die without a verdict. */
  directQueryMode?: "ok" | "reject" | "unknown_outcome";
  /**
   * Bill TxnID → vendor credits linked to it by a $0 BillPayment*Add + SetCredit
   * (vendor_credit_apply). Mirrors what QuickBooks really does (measured in prod
   * 2026-09-15, 6×): the Add answers statusCode 0 with NO TxnID — no document is
   * minted — and the link only shows up on a later BillQuery with LinkedTxns.
   */
  billCredits: Map<string, Array<{ creditTxnId: string; amount: string }>>;
  /** bills/query: force the NEXT BillRet to hide its LinkedTxn (readback negative control). */
  billQueryMode?: "ok" | "no_links";
};

/** Monotonic, timestamp-shaped ids so they read like real QB TxnIDs. */
function mintTxnId(state: StubState, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq.toString(16).toUpperCase().padStart(4, "0")}-${
    1785400000 + state.seq
  }`;
}

function nextEditSequence(state: StubState): string {
  state.seq += 1;
  return String(1785400000 + state.seq);
}

function journal(state: StubState, entry: Record<string, unknown>): void {
  appendFileSync(
    state.journalPath,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  );
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __unparsed: raw });
      }
    });
  });
}

/** The verbatim shape the live bridge returns for a stale EditSequence. */
function staleEditSequenceError(sent: string): string {
  return `QuickBooks Error 3200: The provided edit sequence &quot;${sent}&quot; is out-of-date.`;
}

export function handle(
  state: StubState,
  method: string,
  url: string,
  body: Record<string, any>
): { code: number; payload: unknown } {
  // ── Status polling ────────────────────────────────────────────────────────
  const statusMatch = url.match(/^\/api\/sync\/status\/([^/?]+)/);
  if (statusMatch) {
    const op = state.ops.get(statusMatch[1]);
    if (!op) return { code: 404, payload: { error: "Operation not found" } };
    if (op.completeAfter && Date.now() < op.completeAfter) {
      return {
        code: 200,
        payload: { success: true, operation: { id: op.id, status: "processing" } },
      };
    }
    return { code: 200, payload: { success: true, operation: op } };
  }

  const mint = (op: Omit<Op, "id">): { code: number; payload: unknown } => {
    state.seq += 1;
    const id = `stub-op-${state.seq}`;
    state.ops.set(id, { id, ...op });
    return { code: 200, payload: { success: true, operationId: id } };
  };

  // ── ReceivePayment: merge-apply (the operation under test) ────────────────
  const mergeMatch = url.match(/^\/api\/payments\/([^/?]+)\/merge-apply/);
  if (mergeMatch && method === "POST") {
    const txnId = mergeMatch[1];
    const sent = String(body.editSequence ?? "");
    const current = state.editSequences.get(txnId);
    const applications = Array.isArray(body.applications)
      ? body.applications
      : [];

    journal(state, {
      event: "merge_apply",
      txnId,
      sentEditSequence: sent,
      currentEditSequence: current ?? null,
      stale: current !== undefined && sent !== current,
      applications,
    });

    if (current !== undefined && sent !== current) {
      // Exactly what QuickBooks does — and exactly why a duplicate dispatch is
      // visible instead of silently overwriting the winner's work.
      return mint({ status: "failed", error: staleEditSequenceError(sent) });
    }

    const fresh = nextEditSequence(state);
    state.editSequences.set(txnId, fresh);
    state.applied.set(
      txnId,
      applications.map((a: any) => ({
        invoiceId: String(a.invoiceId),
        amount: Number(a.amount),
      }))
    );
    return mint({
      status: "completed",
      result: {
        QBXML: {
          QBXMLMsgsRs: {
            ReceivePaymentModRs: {
              $: { statusCode: "0", statusMessage: "Status OK" },
              ReceivePaymentRet: { TxnID: txnId, EditSequence: fresh },
            },
          },
        },
      },
    });
  }

  // ── ReceivePayment: query current state ──────────────────────────────────
  const payQueryMatch = url.match(/^\/api\/payments\/([^/?]+)$/);
  if (payQueryMatch && method === "GET") {
    const txnId = payQueryMatch[1];
    const editSequence = state.editSequences.get(txnId) ?? nextEditSequence(state);
    state.editSequences.set(txnId, editSequence);
    const apps = state.applied.get(txnId) ?? [];
    journal(state, {
      event: "payment_query",
      txnId,
      editSequence,
      appliedCount: apps.length,
    });
    return mint({
      status: "completed",
      result: {
        QBXML: {
          QBXMLMsgsRs: {
            ReceivePaymentQueryRs: {
              $: { statusCode: "0", statusMessage: "Status OK" },
              ReceivePaymentRet: {
                TxnID: txnId,
                EditSequence: editSequence,
                TotalAmount: "0.00",
                ...(apps.length
                  ? {
                      AppliedToTxnRet: apps.map((a) => ({
                        TxnID: a.invoiceId,
                        TxnType: "Invoice",
                        PaymentAmount: a.amount.toFixed(2),
                      })),
                    }
                  : {}),
              },
            },
          },
        },
      },
    });
  }

  // ── Raw passthrough (gl-docs-to-qb-20260914) ─────────────────────────────
  // `POST /api/sync/direct-query { qbxml }` — the lane the GL bank documents
  // (and vendor credits / bill payments) use. The stub answers with the SAME
  // shape the live bridge stores: attributes under `$` (xml2js), so a reader
  // that only looks at the flat `statusCode` is caught here, not in prod.
  //   <XxxAddRq>  → { XxxAddRs: { $: {statusCode:"0"}, XxxRet: {TxnID, EditSequence} } }
  //   <TxnVoidRq> → { TxnVoidRs: { $: {statusCode:"0"} } }
  // `state.directQueryMode` (set by a test) forces one rejection or one
  // unknown-outcome failure for the NEXT request.
  if (method === "POST" && url.startsWith("/api/sync/direct-query")) {
    const qbxml = String(body.qbxml ?? "");
    const rqMatch = qbxml.match(/<([A-Za-z]+)AddRq>/);
    const queryMatch = qbxml.match(/<([A-Za-z]+)QueryRq>/);
    const modMatch = qbxml.match(/<([A-Za-z]+)ModRq>/);
    const rqName = rqMatch?.[1] ?? queryMatch?.[1] ?? modMatch?.[1] ?? "Unknown";
    const isVoid = /<TxnVoidRq>/.test(qbxml);
    const mode = state.directQueryMode ?? "ok";
    state.directQueryMode = undefined;
    journal(state, { event: "direct_query", rqName, isVoid, isQuery: !!queryMatch, isMod: !!modMatch, mode, bytes: Buffer.byteLength(qbxml), qbxml });
    if (mode === "unknown_outcome") {
      return mint({ status: "failed", error: "QB HRESULT 0x8004041C: session aborted before submitted state" });
    }
    // check-revise-20260918: `<Tipo>QueryRq` por TxnID → el EditSequence VIVO;
    // `<Tipo>ModRq` → lock optimista igual que ReceivePaymentMod (3200 con
    // EditSequence viejo), y en éxito bumpea el EditSequence y devuelve el Ret.
    if (queryMatch && !rqMatch) {
      const txnId = qbxml.match(/<TxnID>([^<]+)<\/TxnID>/)?.[1] ?? "";
      const current = state.editSequences.get(txnId);
      if (!current || mode === "reject") {
        return mint({
          status: "completed",
          result: { QBXML: { QBXMLMsgsRs: { [`${rqName}QueryRs`]: { $: { statusCode: "3120", statusSeverity: "Error", statusMessage: `Object "${txnId}" specified in the request cannot be found.` } } } } },
        });
      }
      return mint({
        status: "completed",
        result: { QBXML: { QBXMLMsgsRs: { [`${rqName}QueryRs`]: { $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" }, [`${rqName}Ret`]: { TxnID: txnId, EditSequence: current } } } } },
      });
    }
    if (modMatch && !rqMatch) {
      const txnId = qbxml.match(/<TxnID>([^<]+)<\/TxnID>/)?.[1] ?? "";
      const sent = qbxml.match(/<EditSequence>([^<]+)<\/EditSequence>/)?.[1] ?? "";
      const current = state.editSequences.get(txnId);
      const rsKey = `${rqName}ModRs`;
      if (!current || mode === "reject") {
        return mint({
          status: "completed",
          result: { QBXML: { QBXMLMsgsRs: { [rsKey]: { $: { statusCode: "3120", statusSeverity: "Error", statusMessage: `Object "${txnId}" specified in the request cannot be found.` } } } } },
        });
      }
      if (sent !== current) {
        return mint({
          status: "completed",
          result: { QBXML: { QBXMLMsgsRs: { [rsKey]: { $: { statusCode: "3200", statusSeverity: "Error", statusMessage: "The provided edit sequence is out-of-date." } } } } },
        });
      }
      const bumped = nextEditSequence(state);
      state.editSequences.set(txnId, bumped);
      const lines = (qbxml.match(/<ExpenseLineMod>/g) ?? []).length;
      journal(state, { event: "document_mod", rqName, txnId, editSequence: sent, newEditSequence: bumped, lines, clear: /<ClearExpenseLines>true</.test(qbxml) });
      return mint({
        status: "completed",
        result: { QBXML: { QBXMLMsgsRs: { [rsKey]: { $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" }, [`${rqName}Ret`]: { TxnID: txnId, EditSequence: bumped } } } } },
      });
    }
    if (isVoid) {
      return mint({
        status: "completed",
        result: { QBXML: { QBXMLMsgsRs: { TxnVoidRs: { $: { statusCode: mode === "reject" ? "3120" : "0", statusSeverity: mode === "reject" ? "Error" : "Info", statusMessage: mode === "reject" ? "Object not found" : "Status OK" } } } } },
      });
    }
    // $0 Pay Bills with credits: QuickBooks links the credit to the bill and
    // returns NO TxnID (no payment document exists). AppliedToTxnRet only.
    const zeroPay = /<PaymentAmount>0\.00<\/PaymentAmount>/.test(qbxml) && /^BillPayment(CreditCard|Check)$/.test(rqName);
    if (zeroPay && mode === "ok") {
      const billTxnId = qbxml.match(/<AppliedToTxnAdd><TxnID>([^<]+)<\/TxnID>/)?.[1] ?? "";
      const credits = [...qbxml.matchAll(/<SetCredit><CreditTxnID>([^<]+)<\/CreditTxnID><AppliedAmount>([^<]+)<\/AppliedAmount><\/SetCredit>/g)]
        .map((m) => ({ creditTxnId: m[1]!, amount: m[2]! }));
      state.billCredits.set(billTxnId, [...(state.billCredits.get(billTxnId) ?? []), ...credits]);
      journal(state, { event: "bill_credit_apply", billTxnId, credits });
      return mint({
        status: "completed",
        result: { QBXML: { QBXMLMsgsRs: { [`${rqName}AddRs`]: { $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" }, [`${rqName}Ret`]: { AppliedToTxnRet: { TxnID: billTxnId, TxnType: "Bill" } } } } } },
      });
    }
    const txnId = mintTxnId(state, "1DGL");
    const editSequence = nextEditSequence(state);
    state.editSequences.set(txnId, editSequence);
    const rsKey = `${rqName}AddRs`;
    const retKey = `${rqName}Ret`;
    if (mode === "reject") {
      return mint({
        status: "completed",
        result: { QBXML: { QBXMLMsgsRs: { [rsKey]: { $: { statusCode: "3140", statusSeverity: "Error", statusMessage: "There is an invalid reference to QuickBooks Account in the Check." } } } } },
      });
    }
    return mint({
      status: "completed",
      result: {
        QBXML: {
          QBXMLMsgsRs: {
            [rsKey]: {
              $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" },
              [retKey]: { TxnID: txnId, EditSequence: editSequence, TxnNumber: String(150000 + state.seq) },
            },
          },
        },
      },
    });
  }

  // `POST /api/bills/query { txn_id }` — the readback the vendor_credit_apply
  // lane confirms with. Same shape the live bridge returns for BillQueryRq with
  // IncludeLinkedTxns: BillRet.LinkedTxn (a dict for one link, a list for many).
  if (method === "POST" && url.startsWith("/api/bills/query")) {
    const billTxnId = String(body.txn_id ?? "");
    const mode = state.billQueryMode ?? "ok";
    state.billQueryMode = undefined;
    const credits = mode === "no_links" ? [] : (state.billCredits.get(billTxnId) ?? []);
    journal(state, { event: "bill_query", billTxnId, mode, links: credits.length });
    const linked = credits.map((c) => ({ TxnID: c.creditTxnId, TxnType: "VendorCredit", LinkType: "AMTTYPE", Amount: `-${c.amount}` }));
    const billRet: Record<string, unknown> = { TxnID: billTxnId, IsPaid: credits.length > 0 ? "true" : "false", EditSequence: nextEditSequence(state) };
    if (linked.length === 1) billRet.LinkedTxn = linked[0];
    else if (linked.length > 1) billRet.LinkedTxn = linked;
    return mint({
      status: "completed",
      result: { QBXML: { QBXMLMsgsRs: { BillQueryRs: { $: { statusCode: "0", statusSeverity: "Info", statusMessage: "Status OK" }, BillRet: billRet } } } },
    });
  }

  // ── Document ADDs (payment / invoice / sales order / estimate / …) ───────
  if (method === "POST") {
    const kind = url.split("?")[0].replace(/^\/api\//, "").split("/")[0];
    const prefix = kind === "payments" ? "1CBB" : "1CBC";
    const txnId = mintTxnId(state, prefix);
    const editSequence = nextEditSequence(state);
    state.editSequences.set(txnId, editSequence);
    journal(state, { event: "document_add", kind, url, txnId, body });

    const retKey =
      kind === "payments"
        ? "ReceivePaymentAddRs"
        : kind === "invoices"
          ? "InvoiceAddRs"
          : kind === "sales-orders"
            ? "SalesOrderAddRs"
            : kind === "estimates"
              ? "EstimateAddRs"
              : "GenericAddRs";
    const retName = retKey.replace("AddRs", "Ret");

    return mint({
      status: "completed",
      ...(kind === "payments" && PAYMENT_ADD_DELAY_MS > 0
        ? { completeAfter: Date.now() + PAYMENT_ADD_DELAY_MS }
        : {}),
      result: {
        QBXML: {
          QBXMLMsgsRs: {
            [retKey]: {
              $: { statusCode: "0", statusMessage: "Status OK" },
              [retName]: {
                TxnID: txnId,
                EditSequence: editSequence,
                RefNumber: String(90000 + state.seq),
              },
            },
          },
        },
        TxnID: txnId,
        RefNumber: String(90000 + state.seq),
        EditSequence: editSequence,
      },
    });
  }

  journal(state, { event: "unhandled", method, url });
  return { code: 404, payload: { error: `stub bridge: unhandled ${method} ${url}` } };
}

export function startStubBridge(
  port: number,
  journalPath: string
): Promise<{ server: Server; state: StubState }> {
  writeFileSync(journalPath, "");
  const state: StubState = {
    editSequences: new Map(),
    applied: new Map(),
    billCredits: new Map(),
    ops: new Map(),
    journalPath,
    seq: 0,
  };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const { code, payload } = handle(
      state,
      req.method ?? "GET",
      req.url ?? "",
      body
    );
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) =>
    server.listen(port, () => resolve({ server, state }))
  );
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 9999);
  const journalPath = process.argv[3] ?? "/tmp/stub-qb-bridge.jsonl";
  startStubBridge(port, journalPath).then(() => {
    console.log(`stub QB bridge listening on :${port} → ${journalPath}`);
  });
}
