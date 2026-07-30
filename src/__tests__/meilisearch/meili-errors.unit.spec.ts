/**
 * The error shapes here are not invented — they were probed off the live
 * MeiliSearch client on 2026-07-29, because the two obvious guesses (`err.code`
 * and `err.httpStatus`) are both `undefined` and a check written from memory
 * therefore never matches. On an error path a never-matching check does not
 * announce itself: it quietly turns into a capability the code claims to have.
 *
 * That is not hypothetical. `drift-reconciler.ts` checked `err.httpStatus === 404`
 * to decide "the document is missing from the index, so re-create it", which never
 * fired — so the 5-minute sweep could heal a document with wrong FIELDS but never
 * one that was absent, for any of the five entities, while logging a warning that
 * read like a transient Meili hiccup.
 *
 * If the client is upgraded and these shapes change, this spec is what says so.
 */
import {
  isDocumentNotFound,
  isIndexNotFound,
} from "../../lib/meilisearch/meili-errors";

/** Exactly what `index('vendors').getDocuments()` throws when the index is gone. */
const indexNotFound = {
  name: "MeiliSearchApiError",
  cause: {
    message: "Index `vendors` not found.",
    code: "index_not_found",
    type: "invalid_request",
    link: "https://docs.meilisearch.com/errors#index_not_found",
  },
  response: { status: 404 },
};

/** Exactly what `getDocument(id)` throws for an id the index does not hold. */
const documentNotFound = {
  name: "MeiliSearchApiError",
  cause: {
    message: "Document `NO_SUCH_ID` not found.",
    code: "document_not_found",
    type: "invalid_request",
  },
  response: { status: 404 },
};

describe("meili error recognition", () => {
  it("does not read the two properties that are always undefined", () => {
    // The regression guard: if someone rewrites these helpers from memory using
    // err.code / err.httpStatus, these assertions are what fails.
    expect((indexNotFound as { code?: unknown }).code).toBeUndefined();
    expect((indexNotFound as { httpStatus?: unknown }).httpStatus).toBeUndefined();
  });

  it("recognises a missing index", () => {
    expect(isIndexNotFound(indexNotFound)).toBe(true);
    expect(isIndexNotFound(documentNotFound)).toBe(false);
  });

  it("recognises a missing document", () => {
    expect(isDocumentNotFound(documentNotFound)).toBe(true);
  });

  it("treats any 404 as a missing document, so an unnamed code still heals", () => {
    // Better to re-sync a document that was already fine than to skip one that
    // was missing: the first costs a write, the second leaves the index wrong.
    expect(isDocumentNotFound({ response: { status: 404 } })).toBe(true);
  });

  it("does not mistake a real failure for something missing", () => {
    const authFailed = {
      name: "MeiliSearchApiError",
      cause: { code: "invalid_api_key", type: "auth" },
      response: { status: 403 },
    };
    expect(isIndexNotFound(authFailed)).toBe(false);
    expect(isDocumentNotFound(authFailed)).toBe(false);

    const networkDown = new Error("fetch failed");
    expect(isIndexNotFound(networkDown)).toBe(false);
    expect(isDocumentNotFound(networkDown)).toBe(false);
  });

  it("survives being handed nothing at all", () => {
    for (const junk of [null, undefined, "", 0, {}, []]) {
      expect(isIndexNotFound(junk)).toBe(false);
      expect(isDocumentNotFound(junk)).toBe(false);
    }
  });

  it("still matches if a client upgrade starts populating the top level", () => {
    expect(isIndexNotFound({ code: "index_not_found" })).toBe(true);
    expect(isDocumentNotFound({ httpStatus: 404 })).toBe(true);
  });
});
