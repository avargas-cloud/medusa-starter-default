#!/usr/bin/env node
/**
 * post-build.js
 *
 * Copies patches/ to .medusa/server/ and injects a postinstall script
 * so that when Railpack runs `npm install --omit=dev` in .medusa/server,
 * patch-package automatically re-applies all patches to the fresh node_modules.
 *
 * This is necessary because Railpack (Railway's build tool) runs a SEPARATE
 * npm install in .medusa/server after the build phase, which re-installs
 * unpatched Medusa packages — undoing any patches applied during the build phase.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, '.medusa', 'server');
const PATCHES_SRC = path.join(ROOT, 'patches');
const PATCHES_DEST = path.join(SERVER_DIR, 'patches');
const SERVER_PKG = path.join(SERVER_DIR, 'package.json');

if (!fs.existsSync(SERVER_DIR)) {
    console.error('❌ .medusa/server not found — run medusa build first');
    process.exit(1);
}

if (!fs.existsSync(PATCHES_SRC)) {
    console.log('⚠️  No patches/ directory found, skipping');
    process.exit(0);
}

// Copy patches directory to .medusa/server/patches/
fs.cpSync(PATCHES_SRC, PATCHES_DEST, { recursive: true });
console.log('✅ Patches copied to .medusa/server/patches/');

// Add postinstall: "npx --yes patch-package" to .medusa/server/package.json
const pkg = JSON.parse(fs.readFileSync(SERVER_PKG, 'utf8'));
if (!pkg.scripts) pkg.scripts = {};
pkg.scripts.postinstall = 'npx --yes patch-package';
fs.writeFileSync(SERVER_PKG, JSON.stringify(pkg, null, 2));
console.log('✅ postinstall = "npx --yes patch-package" added to .medusa/server/package.json');
console.log('   → patches will be re-applied when Railpack runs npm install --omit=dev');
