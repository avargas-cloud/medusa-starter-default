/**
 * A customer that is gone loses its document — and a customer we merely FAILED TO
 * READ does not.
 *
 * The second half is the one worth testing. Until 2026-07-29 nothing deleted a
 * document at all, so a soft-deleted customer stayed searchable (three of them
 * since 2026-05-01). The obvious fix — "if we could not load the customer, delete
 * the document" — trades that bug for a worse one: a Postgres hiccup would remove
 * a LIVE customer from search, and unlike a stale document nobody would ever see
 * it come back. So the delete is gated on Medusa's `type: "not_found"`, verified
 * against the real module in the sandbox, and these specs pin both directions.
 */
const mockUpdateDocuments = jest.fn();
const mockDeleteDocument = jest.fn();

jest.mock("meilisearch", () => ({
  MeiliSearch: class {
    index() {
      return {
        updateDocuments: (...a: unknown[]) => mockUpdateDocuments(...a),
        deleteDocument: (...a: unknown[]) => mockDeleteDocument(...a),
      };
    }
  },
}));

import { Modules } from "@medusajs/utils";

import { syncCustomerToMeili } from "../../lib/meilisearch/sync-customer";

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** Container whose customer module fails however the test says. */
function containerThatThrows(err: unknown) {
  return {
    resolve: (key: string) => {
      if (key === Modules.CUSTOMER) {
        return { retrieveCustomer: () => Promise.reject(err) };
      }
      return logger;
    },
  };
}

/** What Medusa actually throws for a soft-deleted or missing customer. */
function notFound(id: string) {
  return Object.assign(new Error(`Customer with id: ${id} was not found`), {
    type: "not_found",
  });
}

beforeEach(() => {
  process.env.MEILISEARCH_HOST = "http://localhost:7799";
  process.env.MEILISEARCH_API_KEY = "test";
  mockUpdateDocuments.mockReset();
  mockDeleteDocument.mockReset().mockResolvedValue({ taskUid: 1 });
  logger.info.mockReset();
  logger.error.mockReset();
});

describe("syncCustomerToMeili — the customer is gone", () => {
  it("deletes the document", async () => {
    const id = "cus_GONE";
    await syncCustomerToMeili(id, containerThatThrows(notFound(id)), logger);

    expect(mockDeleteDocument).toHaveBeenCalledWith(id);
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
  });

  it("rethrows when the delete itself fails, so the queue retries it", async () => {
    // Nothing else can repair a failed delete: the sweep enumerates rows by
    // updated_at and a deleted row is never enumerated. Swallowing here is
    // precisely how a permanent orphan gets created.
    const id = "cus_GONE";
    mockDeleteDocument.mockRejectedValue(new Error("meili unreachable"));

    await expect(
      syncCustomerToMeili(id, containerThatThrows(notFound(id)), logger)
    ).rejects.toThrow("meili unreachable");
  });
});

describe("syncCustomerToMeili — we just could not read the customer", () => {
  it.each([
    ["a dead socket", new Error("ECONNREFUSED")],
    ["a Postgres error", Object.assign(new Error("deadlock detected"), { code: "40P01" })],
    ["an error with no type at all", new Error("something went wrong")],
    ["a different Medusa error", Object.assign(new Error("nope"), { type: "not_allowed" })],
  ])("does NOT delete the document on %s", async (_label, err) => {
    await syncCustomerToMeili("cus_LIVE", containerThatThrows(err), logger);

    // The whole safety property: a live customer must not vanish from search
    // because one read failed.
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("stays non-throwing on a read failure, so a caller's primary write survives", async () => {
    // The QB mapping routes call this after creating a customer. It must not turn
    // a successful customer creation into a 500.
    await expect(
      syncCustomerToMeili("cus_LIVE", containerThatThrows(new Error("ECONNREFUSED")), logger)
    ).resolves.toBeUndefined();
  });
});
