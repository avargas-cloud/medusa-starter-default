// Regression test: QB Error 3175 ("…already in use. The transaction could not
// be locked.") is a transient LOCK, not a permanent DUPLICATE. Its message
// contains "already in use" (a RX_DUPLICATE signal), so without 3175 in RX_LOCK
// it was mis-classified as duplicate → failOrRetryPipelineRow treated it as
// terminal → no auto-retry, requiring a manual Retry every time an invoice was
// briefly locked in QB Desktop.

import { classifyQbError } from "../../lib/quickbooks/error-classifier";

describe("classifyQbError — 3175 lock vs duplicate", () => {
  const MSG_3175 =
    "QuickBooks Error 3175: There was an error adding, modifying or deleting 1C5D12-1780069371 because it is already in use.  QuickBooks error message: The transaction could not be locked.";

  it("classifies 3175 as a transient lock (auto-retryable), NOT a duplicate", () => {
    const c = classifyQbError({ message: MSG_3175 });
    expect(c.class).toBe("lock");
    expect(c.isTransient).toBe(true);
  });

  it("matches the bare 'could not be locked' phrase as lock", () => {
    expect(classifyQbError({ message: "The transaction could not be locked." }).class).toBe(
      "lock"
    );
  });

  it("still classifies 3170 as lock (regression)", () => {
    expect(classifyQbError({ code: "3170", message: "modified by another user" }).class).toBe(
      "lock"
    );
  });

  it("still classifies a genuine 3200 duplicate as duplicate (regression)", () => {
    const c = classifyQbError({
      code: "3200",
      message: "The name already exists.",
    });
    expect(c.class).toBe("duplicate");
  });
});
