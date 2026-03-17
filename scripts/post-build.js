#!/usr/bin/env node
/**
 * post-build.js
 * Runs after `medusa build` on Railway (via nixpacks.toml build phase).
 *
 * Purpose: `medusa build` generates .medusa/server/ with a FRESH npm install
 * that overwrites our patched node_modules. This script:
 *   1. Copies our patches/ directory into .medusa/server/patches/
 *   2. Injects "postinstall": "patch-package" into .medusa/server/package.json
 *   3. Runs `npx --yes patch-package` inside .medusa/server/ to apply patches immediately
 *
 * This ensures our @medusajs/order and @medusajs/core-flows patches
 * are always active in the deployed server bundle.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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
if (fs.existsSync(PKG_JSON)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
  pkg.scripts = pkg.scripts ?? {};
  if (pkg.scripts.postinstall !== "patch-package") {
    pkg.scripts.postinstall = "patch-package";
    fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2));
    console.log("✅  Injected postinstall=patch-package into .medusa/server/package.json");
  } else {
    console.log("ℹ️   postinstall hook already present in .medusa/server/package.json");
  }
}

// ─── 4. Apply patches immediately inside .medusa/server ──────────────────────
console.log("🩹  Applying patches inside .medusa/server ...");
try {
  execSync("npx --yes patch-package", {
    cwd: SERVER_DIR,
    stdio: "inherit",
  });
  console.log("✅  Patches applied successfully in .medusa/server.");
} catch (err) {
  // A failed patch is a hard error — missing patch = wrong totals in production
  console.error("❌  patch-package failed inside .medusa/server:", err.message);
  process.exit(1);
}

console.log("✅  post-build.js complete.");
