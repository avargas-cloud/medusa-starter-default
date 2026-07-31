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
