#!/usr/bin/env node
/**
 * post-build.js
 * Runs after `medusa build` (via "build": "medusa build && node scripts/post-build.js").
 *
 * PURPOSE:
 *   1. Copies patches/ into .medusa/server/patches/
 *   2. Injects "postinstall": "npx --yes patch-package" into .medusa/server/package.json
 *   3. Runs `npm install --omit=dev --legacy-peer-deps` inside .medusa/server/
 *      so node_modules is baked into the build image. The postinstall hook
 *      from step 2 fires here and applies the patches.
 *
 * Why install during build (not deploy):
 *   Railway's deploy phase used to run `npm install` on every deploy (~7 min,
 *   2000+ packages). Doing it during the build means node_modules ships with
 *   the image and the deploy start command becomes just `npm start`.
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
// This hook fires when Railway runs "npm install" in .medusa/server during deploy.
// At that point node_modules exist, so patch-package can apply the patches.
// We use "npx --yes patch-package" because patch-package is not a dependency
// of .medusa/server — npx downloads and runs it on-demand.
if (fs.existsSync(PKG_JSON)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
  let dirty = false;

  // 3a. Inject postinstall hook for patch-package
  pkg.scripts = pkg.scripts ?? {};
  const POSTINSTALL_CMD = "npx --yes patch-package";
  if (pkg.scripts.postinstall !== POSTINSTALL_CMD) {
    pkg.scripts.postinstall = POSTINSTALL_CMD;
    dirty = true;
    console.log("✅  Injected postinstall='npx --yes patch-package' into .medusa/server/package.json");
  }

  // 3b. Strip the root-level "npm: DO NOT USE NPM" guard from engines so that
  //     `npm install` actually works inside .medusa/server (we use npm there
  //     because that's what Railway's deploy phase historically used, and the
  //     install runs against this package.json — yarn would re-resolve from
  //     the wrong workspace root).
  if (pkg.engines && typeof pkg.engines.npm === "string" && pkg.engines.npm.includes("DO NOT USE")) {
    delete pkg.engines.npm;
    dirty = true;
    console.log("✅  Stripped 'engines.npm' guard from .medusa/server/package.json");
  }

  if (dirty) {
    fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2));
  } else {
    console.log("ℹ️   .medusa/server/package.json already correct.");
  }
} else {
  console.warn("⚠️  .medusa/server/package.json not found — skipping injection.");
}

// ─── 4. Run yarn install inside .medusa/server so node_modules is baked into image ─
// Skip when SKIP_MEDUSA_SERVER_INSTALL=1 (useful for local quick rebuilds where the
// dev runs from /app/node_modules and doesn't need .medusa/server/node_modules).
if (process.env.SKIP_MEDUSA_SERVER_INSTALL === "1") {
  console.log("⏭️   SKIP_MEDUSA_SERVER_INSTALL=1 — skipping yarn install in .medusa/server.");
} else {
  // medusa build emits a yarn.lock alongside package.json. We use yarn for
  // consistency with the rest of the project (npm has historically caused
  // issues here). Remove any package-lock.json that a previous npm run left.
  const PKG_LOCK = path.join(SERVER_DIR, "package-lock.json");
  if (fs.existsSync(PKG_LOCK)) {
    fs.rmSync(PKG_LOCK);
    console.log("🧹  Removed stale package-lock.json from .medusa/server.");
  }

  console.log("📦  Running 'yarn install --production --frozen-lockfile' in .medusa/server …");
  const installStart = Date.now();
  try {
    execSync("yarn install --production --frozen-lockfile --ignore-engines", {
      cwd: SERVER_DIR,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    const elapsed = ((Date.now() - installStart) / 1000).toFixed(1);
    console.log(`✅  yarn install complete in ${elapsed}s — node_modules baked into image.`);
  } catch (err) {
    console.error("❌  yarn install in .medusa/server failed:", err.message);
    process.exit(1);
  }
}

console.log("✅  post-build.js complete.");
