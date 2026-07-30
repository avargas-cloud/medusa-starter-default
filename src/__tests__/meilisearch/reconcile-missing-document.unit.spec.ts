/**
 * A document the index does not have is drift, not a read failure.
 *
 * `reconcileEntity` decides that in a catch block, and until 2026-07-29 it decided
 * it wrong: it tested `err.httpStatus === 404`, a property MeiliSearchApiError
 * does not have, so every absent document took the "Meili read failed" branch and
 * was skipped. The sweep could repair a document with wrong fields and never one
 * that was missing — for all five entities — while logging something that looked
 * like a transient hiccup. Four customers were unsearchable since 2026-05-01.
 *
 * The bug lived entirely in error-shape recognition, so this drives it with the
 * real error shape (see meili-errors.unit.spec.ts) and asserts on the OUTCOME: the
 * entity gets re-synced. Asserting on the log line would have passed before too.
 */
import { reconcileEntity } from "../../lib/meilisearch/drift-reconciler";
import type { EntityReconciler } from "../../lib/meilisearch/drift-reconciler";

/** What the real client throws for an id the index does not hold. */
class ApiError extends Error {
  name = "MeiliSearchApiError";
  cause = { code: "document_not_found", type: "invalid_request" };
  response = { status: 404 };
  constructor() {
    super("Document `x` not found.");
  }
}

const mockGetDocument = jest.fn();
jest.mock("meilisearch", () => ({
  MeiliSearch: class {
    index() {
      return { getDocument: (...a: unknown[]) => mockGetDocument(...a) };
    }
  },
}));

/** Swallows everything: this spec never touches a real database. */
function fakeSql() {
  const sql = (() => Promise.resolve([])) as unknown as {
    (...a: unknown[]): Promise<unknown[]>;
  };
  return sql as never;
}

function makeReconciler(syncOne: jest.Mock): EntityReconciler {
  return {
    entityType: "customer",
    meiliIndex: "customers",
    comparableFields: ["email", "first_name"],
    buildExpectedDoc: async () => ({
      email: "arturo@example.com",
      first_name: "Arturo",
    }),
    syncOne,
    fetchUpdatedIdsSince: async () => ["cus_ABC"],
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  process.env.MEILISEARCH_HOST = "http://localhost:7799";
  process.env.MEILISEARCH_API_KEY = "test";
  mockGetDocument.mockReset();
});

describe("reconcileEntity — the document is missing from the index", () => {
  it("counts it as drift and re-syncs it, instead of skipping it", async () => {
    mockGetDocument.mockRejectedValue(new ApiError());
    const syncOne = jest.fn().mockResolvedValue(undefined);

    const stats = await reconcileEntity(makeReconciler(syncOne), fakeSql(), {} as never, {
      sinceIso: "2026-07-29T00:00:00.000Z",
      maxRows: 500,
      dryRun: false,
      logger: silentLogger,
    });

    // This is the assertion the old code failed: it never got here.
    expect(syncOne).toHaveBeenCalledWith("cus_ABC", expect.anything());
    expect(stats).toMatchObject({ checked: 1, drifted: 1, fixed: 1, fix_errors: 0 });
  });

  it("still skips a read that failed for a real reason", async () => {
    // A 403 or a dead socket is not drift — re-syncing on it would hammer Meili
    // with writes derived from nothing.
    const authFailed = Object.assign(new Error("invalid api key"), {
      name: "MeiliSearchApiError",
      cause: { code: "invalid_api_key" },
      response: { status: 403 },
    });
    mockGetDocument.mockRejectedValue(authFailed);
    const syncOne = jest.fn();

    const stats = await reconcileEntity(makeReconciler(syncOne), fakeSql(), {} as never, {
      sinceIso: "2026-07-29T00:00:00.000Z",
      maxRows: 500,
      dryRun: false,
      logger: silentLogger,
    });

    expect(syncOne).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ checked: 1, drifted: 0, fixed: 0 });
  });

  it("does not write when asked not to", async () => {
    mockGetDocument.mockRejectedValue(new ApiError());
    const syncOne = jest.fn();

    const stats = await reconcileEntity(makeReconciler(syncOne), fakeSql(), {} as never, {
      sinceIso: "2026-07-29T00:00:00.000Z",
      maxRows: 500,
      dryRun: true,
      logger: silentLogger,
    });

    expect(syncOne).not.toHaveBeenCalled();
    // Still reported: a dry run is for seeing the damage, not hiding it.
    expect(stats).toMatchObject({ checked: 1, drifted: 1 });
  });
});
