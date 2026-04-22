/**
 * verify-qb-item-pipeline-flow.ts
 *
 * End-to-end verification of the QB item pipeline (F1–F3) against a STUB
 * bridge server. Zero residue: spawns an HTTP server on a free port, overrides
 * QB_BRIDGE_URL for the duration of the test, and deletes every pipeline row
 * it inserts in a finally block (even on crash).
 *
 * Validates:
 *   1. Phase A — waiting + completed bridge response → row goes to synced
 *   2. Phase A — bridge returns failed → row goes to error with next_retry_at
 *   3. Phase B — EditSequence fallback hydrates qb_edit_sequence and resubmits
 *   4. Phase B — 5 consecutive failures → failed_permanent
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-item-pipeline-flow.ts
 */

import http from "node:http";
import { AddressInfo } from "node:net";

import type {
  ExecArgs,
  MedusaContainer,
} from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import qbItemPipelinePoller from "../../jobs/qb-item-pipeline-poller";
import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

// ── Test fixture: a real variant from the dev DB. The variant is NEVER
//    mutated — only used as FK target so qb_item_pipeline rows are valid.
const FIXTURE_VARIANT_ID = "variant_01KPHQ6MAE6R6DEPVHTYZRN0R5"; // test1--35
const FIXTURE_SKU = "test1--35";
const FIXTURE_QB_LIST_ID = "80001C28-1776563785";

type StubResponse =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "raw"; status: number; body: string };

class BridgeStub {
  private server: http.Server | null = null;
  port = 0;
  /** FIFO queue of scripted responses, keyed by `${method} ${pathPrefix}`. */
  private scripts = new Map<string, StubResponse[]>();
  /** Persistent default response (used when no scripted entry left). */
  private defaults = new Map<string, StubResponse>();
  callLog: Array<{ method: string; url: string; body: string }> = [];

  script(method: string, pathPrefix: string, response: StubResponse): void {
    const key = `${method} ${pathPrefix}`;
    const arr = this.scripts.get(key) ?? [];
    arr.push(response);
    this.scripts.set(key, arr);
  }

  setDefault(
    method: string,
    pathPrefix: string,
    response: StubResponse
  ): void {
    this.defaults.set(`${method} ${pathPrefix}`, response);
  }

  reset(): void {
    this.scripts.clear();
    this.defaults.clear();
    this.callLog = [];
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          this.callLog.push({
            method: req.method ?? "?",
            url: req.url ?? "?",
            body,
          });
          const matchKey = this.matchKey(req.method ?? "", req.url ?? "");
          const scripted = matchKey ? this.scripts.get(matchKey)?.shift() : null;
          const fallback = matchKey ? this.defaults.get(matchKey) : null;
          const response = scripted ?? fallback;
          if (!response) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `BridgeStub: no scripted response for ${req.method} ${req.url}`,
              })
            );
            return;
          }
          if (response.kind === "json") {
            res.writeHead(response.status ?? 200, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(response.body));
          } else {
            res.writeHead(response.status, {
              "Content-Type": "application/json",
            });
            res.end(response.body);
          }
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Pick the most-specific registered key that prefixes this URL. */
  private matchKey(method: string, url: string): string | null {
    const keys = [
      ...new Set([
        ...this.scripts.keys(),
        ...this.defaults.keys(),
      ]),
    ].filter((k) => k.startsWith(`${method} `));
    let best: string | null = null;
    for (const key of keys) {
      const prefix = key.slice(method.length + 1);
      if (url.startsWith(prefix)) {
        if (!best || prefix.length > best.slice(method.length + 1).length) {
          best = key;
        }
      }
    }
    return best;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestCtx {
  container: MedusaContainer;
  catalog: any;
  knex: any;
  stub: BridgeStub;
  log: (msg: string) => void;
  trackedRowIds: Set<string>;
}

const insertPipelineRow = async (
  ctx: TestCtx,
  fields: Record<string, any>
): Promise<string> => {
  const row = await ctx.catalog.createQbItemPipelines({
    variant_id: FIXTURE_VARIANT_ID,
    sku: FIXTURE_SKU,
    item_type: "Inventory",
    op_action: "mod",
    qb_id: FIXTURE_QB_LIST_ID,
    ...fields,
  });
  ctx.trackedRowIds.add(row.id);
  return row.id;
};

const getRow = async (ctx: TestCtx, id: string): Promise<any> => {
  const query = ctx.container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "qb_item_pipeline",
    fields: [
      "id",
      "status",
      "qb_operation_id",
      "qb_list_id",
      "qb_edit_sequence",
      "last_error",
      "retries",
      "next_retry_at",
      "failed_at",
      "op_payload",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  return (data as any[])[0];
};

const expect = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioPhaseACompleted(ctx: TestCtx): Promise<void> {
  ctx.log("─── Scenario 1: Phase A — bridge completes → synced ───");
  ctx.stub.reset();
  ctx.stub.setDefault("GET", "/api/sync/status", {
    kind: "json",
    body: {
      operation: {
        status: "completed",
        listId: FIXTURE_QB_LIST_ID,
        editSequence: "9999999999",
      },
    },
  });

  const id = await insertPipelineRow(ctx, {
    status: "waiting",
    qb_operation_id: "stub-op-001",
    op_payload: { ListID: FIXTURE_QB_LIST_ID, Name: FIXTURE_SKU },
  });

  await qbItemPipelinePoller(ctx.container);
  const row = await getRow(ctx, id);
  expect(
    row.status === "synced",
    `expected synced, got ${row.status} (err=${row.last_error})`
  );
  expect(row.qb_list_id === FIXTURE_QB_LIST_ID, "qb_list_id should match");
  expect(
    row.qb_edit_sequence === "9999999999",
    "qb_edit_sequence should be persisted"
  );
  ctx.log("  ✓ row → synced with ListID + EditSequence persisted");
}

async function scenarioPhaseAFailed(ctx: TestCtx): Promise<void> {
  ctx.log("─── Scenario 2: Phase A — bridge failed → error w/ backoff ───");
  ctx.stub.reset();
  ctx.stub.setDefault("GET", "/api/sync/status", {
    kind: "json",
    body: {
      operation: {
        status: "failed",
        error: "QuickBooks Error 3045: stub-injected failure",
      },
    },
  });

  const id = await insertPipelineRow(ctx, {
    status: "waiting",
    qb_operation_id: "stub-op-002",
    op_payload: { ListID: FIXTURE_QB_LIST_ID, Name: FIXTURE_SKU },
  });

  await qbItemPipelinePoller(ctx.container);
  const row = await getRow(ctx, id);
  expect(row.status === "error", `expected error, got ${row.status}`);
  expect(
    row.last_error?.includes("3045"),
    `last_error should mention 3045, got: ${row.last_error}`
  );
  expect(
    row.next_retry_at != null,
    "next_retry_at should be set after Phase A failure"
  );
  ctx.log("  ✓ row → error with last_error + next_retry_at set");
}

async function scenarioEditSequenceFallback(ctx: TestCtx): Promise<void> {
  ctx.log("─── Scenario 3: Phase B — EditSequence fallback hydrates + retries ───");
  ctx.stub.reset();
  // ItemQuery returns a fresh sequence
  ctx.stub.script("GET", `/api/products/${FIXTURE_QB_LIST_ID}`, {
    kind: "json",
    body: { operationId: "stub-itemquery-op" },
  });
  ctx.stub.script("GET", "/api/sync/status/stub-itemquery-op", {
    kind: "json",
    body: {
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              ItemQueryRs: {
                ItemInventoryRet: { EditSequence: "FRESH-SEQ-2024" },
              },
            },
          },
        },
      },
    },
  });
  // PUT (resubmit Mod) returns a new operationId
  ctx.stub.script("PUT", `/api/products/${FIXTURE_QB_LIST_ID}`, {
    kind: "json",
    body: { operationId: "stub-mod-resubmit-op" },
  });

  const id = await insertPipelineRow(ctx, {
    status: "error",
    last_error: "Failed to build XML",
    op_payload: {
      ListID: FIXTURE_QB_LIST_ID,
      EditSequence: "STALE-SEQ-OLD",
      Name: FIXTURE_SKU,
    },
    next_retry_at: new Date(Date.now() - 60_000), // due NOW
    retries: 0,
  });

  await qbItemPipelinePoller(ctx.container);
  const row = await getRow(ctx, id);
  expect(
    row.status === "waiting",
    `expected waiting after resubmit, got ${row.status}`
  );
  expect(
    row.qb_operation_id === "stub-mod-resubmit-op",
    `expected new operationId, got ${row.qb_operation_id}`
  );
  expect(
    row.op_payload?.EditSequence === "FRESH-SEQ-2024",
    `expected fresh EditSequence in op_payload, got ${row.op_payload?.EditSequence}`
  );
  expect(row.retries === 0, "retries must NOT increment on free EditSeq retry");
  ctx.log(
    "  ✓ EditSequence hydrated (FRESH-SEQ-2024), Mod resubmitted, retries=0"
  );
}

async function scenarioFailedPermanent(ctx: TestCtx): Promise<void> {
  ctx.log("─── Scenario 4: Phase B — 5 consecutive fails → failed_permanent ───");
  ctx.stub.reset();
  // Every PUT returns 500 from the bridge
  ctx.stub.setDefault("PUT", `/api/products/${FIXTURE_QB_LIST_ID}`, {
    kind: "raw",
    status: 500,
    body: '{"error":"stub-injected bridge crash"}',
  });

  const id = await insertPipelineRow(ctx, {
    status: "error",
    last_error: "initial error",
    op_payload: { ListID: FIXTURE_QB_LIST_ID, Name: FIXTURE_SKU },
    next_retry_at: new Date(Date.now() - 60_000), // due NOW
    retries: 0,
  });

  // Run poller 5 times — but each tick the next_retry_at gets pushed forward
  // by the backoff. Force-clear next_retry_at between ticks to simulate that
  // the backoff window has elapsed (we don't want to actually wait 60+ min).
  for (let i = 1; i <= 5; i++) {
    await qbItemPipelinePoller(ctx.container);
    // Reset next_retry_at to NOW so the next tick processes it again
    await ctx.catalog.updateQbItemPipelines({
      id,
      next_retry_at: new Date(Date.now() - 60_000),
    });
    const r = await getRow(ctx, id);
    ctx.log(`  tick ${i}: status=${r.status} retries=${r.retries}`);
    if (r.status === "failed_permanent") break;
  }

  const final = await getRow(ctx, id);
  expect(
    final.status === "failed_permanent",
    `expected failed_permanent, got ${final.status} (retries=${final.retries})`
  );
  expect(final.retries >= 5, `expected retries>=5, got ${final.retries}`);
  expect(final.failed_at != null, "failed_at should be set");
  ctx.log(`  ✓ row → failed_permanent after ${final.retries} retries`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export default async function main({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const log = (msg: string) => logger.info(`[verify-pipeline] ${msg}`);

  const stub = new BridgeStub();
  await stub.start();
  const originalBridgeUrl = process.env.QB_BRIDGE_URL;
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:${stub.port}`;
  log(`bridge stub listening on ${process.env.QB_BRIDGE_URL}`);

  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const knex = (container as any).resolve("__pg_connection__");
  const trackedRowIds = new Set<string>();

  const ctx: TestCtx = { container, catalog, knex, stub, log, trackedRowIds };

  let pass = 0;
  let fail = 0;
  const scenarios: Array<[string, (c: TestCtx) => Promise<void>]> = [
    ["phaseACompleted", scenarioPhaseACompleted],
    ["phaseAFailed", scenarioPhaseAFailed],
    ["editSequenceFallback", scenarioEditSequenceFallback],
    ["failedPermanent", scenarioFailedPermanent],
  ];

  // Clean tracked rows between scenarios so each runs in isolation (no leak
  // of error rows from prior scenarios into the next scenario's Phase B).
  const cleanupTracked = async () => {
    for (const id of Array.from(trackedRowIds)) {
      try {
        await catalog.deleteQbItemPipelines(id);
        trackedRowIds.delete(id);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    for (const [name, run] of scenarios) {
      try {
        await run(ctx);
        pass++;
      } catch (e: any) {
        log(`✗ ${name}: ${e.message}`);
        fail++;
      }
      await cleanupTracked();
    }
  } finally {
    // ── Teardown ──────────────────────────────────────────────────────────
    log(`cleaning up ${trackedRowIds.size} test pipeline row(s)...`);
    for (const id of trackedRowIds) {
      try {
        await catalog.deleteQbItemPipelines(id);
      } catch (e: any) {
        log(`  (cleanup) failed to delete ${id}: ${e.message}`);
      }
    }
    // Restore the variant's qb_edit_sequence in case scenario 3 mutated it
    await knex.raw(
      `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('qb_edit_sequence', ?::text)
       WHERE id = ?`,
      ["1776563785", FIXTURE_VARIANT_ID]
    );
    await stub.stop();
    if (originalBridgeUrl !== undefined) {
      process.env.QB_BRIDGE_URL = originalBridgeUrl;
    } else {
      delete process.env.QB_BRIDGE_URL;
    }
    log("teardown complete");
  }

  log("═════════════════════════════════════════");
  log(`  RESULTS: ${pass} passed, ${fail} failed`);
  log("═════════════════════════════════════════");
  if (fail > 0) {
    throw new Error(`${fail} scenario(s) failed`);
  }
  await sleep(50); // let any inflight log flush before exec exits
}
