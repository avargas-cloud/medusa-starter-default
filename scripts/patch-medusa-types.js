#!/usr/bin/env node
/**
 * patch-medusa-types.js
 * 
 * Patches @medusajs package.json files to add missing "types" fields
 * that are required by TypeScript's Node16 moduleResolution.
 * 
 * Run after: npm install / yarn install
 * Add to package.json scripts: "postinstall": "node scripts/patch-medusa-types.js"
 */

const fs = require('fs');
const path = require('path');

const nodeModules = path.join(__dirname, '..', 'node_modules');

const patches = [
    {
        pkg: '@medusajs/utils',
        // Add "types" to root export and to the package-level
        patch: (json) => {
            if (!json.types) {
                json.types = './dist/index.d.ts';
                console.log('  ✅ Added types to @medusajs/utils');
            }
            // Fix exports map to include types condition
            if (json.exports?.['.'] && typeof json.exports['.'] === 'string') {
                const jsPath = json.exports['.'];
                const dtsPath = jsPath.replace('.js', '.d.ts');
                json.exports['.'] = {
                    types: dtsPath,
                    default: jsPath
                };
                console.log('  ✅ Fixed exports["."] in @medusajs/utils');
            }
            return json;
        }
    },
    {
        pkg: '@medusajs/framework',
        // Add "types" to all subpath exports
        patch: (json) => {
            let changed = false;
            for (const [key, value] of Object.entries(json.exports || {})) {
                if (typeof value === 'string' && value.endsWith('.js')) {
                    const dtsPath = value.replace('/dist/', '/dist/').replace('.js', '.d.ts');
                    json.exports[key] = {
                        types: dtsPath,
                        default: value
                    };
                    changed = true;
                }
            }
            if (changed) {
                console.log('  ✅ Fixed exports map in @medusajs/framework (added types conditions)');
            }
            return json;
        }
    }
];

for (const { pkg, patch } of patches) {
    const pkgJsonPath = path.join(nodeModules, pkg, 'package.json');
    try {
        const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        console.log(`Patching ${pkg}...`);
        const patched = patch(json);
        fs.writeFileSync(pkgJsonPath, JSON.stringify(patched, null, 2));
        console.log(`  Done.\n`);
    } catch (err) {
        console.error(`  ❌ Failed to patch ${pkg}:`, err.message);
    }
}

console.log('Patching complete!');
