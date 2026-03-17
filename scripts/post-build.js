#!/usr/bin/env node
/**
 * post-build.js
 * Runs after `medusa build` on Railway (via "build": "medusa build && node scripts/post-build.js").
 *
 * PURPOSE:
 * `medusa build` generates .medusa/server/ with a FRESH npm install that
 * overwrites our patched node_modules. This script:
 *
 *   1. Copies our patches/ directory into .medusa/server/patches/
 *   2. Injects "postinstall": "npx --yes patch-package" into .medusa/server/package.json
 *
 * The actual patch-package execution happens LATER, when Railway runs:
 *   cd .medusa/server && npm install --omit=dev --legacy-peer-deps
 *
 * That npm install triggers the postinstall hook, which runs patch-package
 * AFTER node_modules are fully installed — which is the only valid timing.
 *
 * NOTE: Do NOT run patch-package here directly. .medusa/server/node_modules
 * does not exist at this point (npm install hasn't run yet), so patch-package
 * would fail with "package not present at node_modules/...".
 */

const fs = require("fs");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "../.medusa/server");
const PATCHES_SRC = path.resolve(__dirname, "../patches");
const PATCHES_DST = path.join(SERVER_DIR, "patches");
const PKG_JSON = path.join(SERVER_DIR, "package.json");

// ─── 1. Verify .medusa/server exists ──────────────────────────────────────────
if (!fs.existsSync(SERVER_DIR)) {
  console.log("⚠️  post-build.js: .medusa/server not found — skipping patch injection.");
  console.log("    (This is normal when running locally without `medusa build`)");
  process.exit(0);
}

// ─── 2. Copy patches/ into .medusa/server/patches/ ───────────────────────────
if (!fs.existsSync(PATCHES_SRC)) {
  console.error("❌  post-build.js: patches/ directory not found at:", PATCHES_SRC);
  process.exit(1);
}

console.log("📋  Copying patches/ →", PATCHES_DST);
fs.cpSync(PATCHES_SRC, PATCHES_DST, { recursive: true });
console.log("✅  patches/ copied.");

// ─── 3. Inject postinstall hook into .medusa/server/package.json ─────────────
// This hook fires when Railway runs "npm install" in .medusa/server during deploy.
// At that point node_modules exist, so patch-package can apply the patches.
// We use "npx --yes patch-package" because patch-package is not a dependency
// of .medusa/server — npx downloads and runs it on-demand.
if (fs.existsSync(PKG_JSON)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
  pkg.scripts = pkg.scripts ?? {};
  const POSTINSTALL_CMD = "npx --yes patch-package";
  if (pkg.scripts.postinstall !== POSTINSTALL_CMD) {
    pkg.scripts.postinstall = POSTINSTALL_CMD;
    fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2));
    console.log("✅  Injected postinstall='npx --yes patch-package' into .medusa/server/package.json");
  } else {
    console.log("ℹ️   postinstall hook already correct in .medusa/server/package.json");
  }
} else {
  console.warn("⚠️  .medusa/server/package.json not found — postinstall hook not injected.");
}

console.log("✅  post-build.js complete. Patches will be applied during 'npm install' on deploy.");
