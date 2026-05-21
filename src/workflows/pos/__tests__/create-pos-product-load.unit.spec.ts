/**
 * Workflow LOAD smoke test.
 *
 * `createWorkflow(...)` executes its body at module-load time to build the DSL
 * graph. Calling plain JS (e.g. `.trim()`) on the deferred `input` proxy there
 * throws "X is not a function" at load — which type-check does NOT catch and which
 * crashed the Railway healthcheck (deploy 3a3168b0). Importing the module here
 * reproduces that load, so a broken workflow body fails this test instead of prod.
 */

describe("POS create-product workflows load without DSL proxy errors", () => {
  it("create-pos-product (v1) module loads and exports the workflow", () => {
    const mod = require("../create-pos-product");
    expect(mod.createPosProductWorkflow).toBeDefined();
  });

  it("create-pos-product-v2 module loads and exports the workflow", () => {
    const mod = require("../create-pos-product-v2");
    expect(mod.createPosProductV2Workflow).toBeDefined();
  });
});
