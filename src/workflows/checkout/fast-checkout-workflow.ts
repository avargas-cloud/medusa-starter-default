// NOTE: The fast-checkout orchestration logic lives entirely in:
// src/api/store/fast-checkout/route.ts
//
// This file is kept as a placeholder in case we need to expose the full
// checkout as a reusable composable workflow in the future (e.g. for
// webhook retries, admin-triggered reorders, etc.).
//
// For now, the route calls each step workflow individually with .run()
// which gives us fine-grained error handling and logging at each stage.

export {};
