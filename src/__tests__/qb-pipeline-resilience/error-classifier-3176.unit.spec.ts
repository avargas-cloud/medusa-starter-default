// Regression test: QB Error 3176 ("…already in use. …failed to acquire the
// lock.") is a transient LOCK, not a permanent DUPLICATE. Its message contains
// "already in use" (a RX_DUPLICATE signal), so without 3176 in RX_LOCK it was
// mis-classified as duplicate → failOrRetryPipelineRow treated it as terminal
// → no auto-retry, requiring a manual Retry every time an invoice was briefly
// locked in QB Desktop. Same bug class as 3175 (see error-classifier-3175.unit.spec.ts).

import { classifyQbError } from "../../lib/quickbooks/error-classifier";

describe("classifyQbError — 3176 lock vs duplicate", () => {
  const MSG_3176 =
    "QuickBooks Error 3176: There was an error adding, modifying or deleting 1C5D12-1780069371 because it is already in use.  QuickBooks error message: The application failed to acquire the lock.";

  it("classifies 3176 as a transient lock (auto-retryable), NOT a duplicate", () => {
    const c = classifyQbError({ message: MSG_3176 });
    expect(c.class).toBe("lock");
    expect(c.isTransient).toBe(true);
  });

  it("matches the bare 'failed to acquire the lock' phrase as lock", () => {
    expect(
      classifyQbError({ message: "The application failed to acquire the lock." }).class
    ).toBe("lock");
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
