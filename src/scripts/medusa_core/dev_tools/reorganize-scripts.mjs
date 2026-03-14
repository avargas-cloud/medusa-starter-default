#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const srcScripts = '/home/alejo/medusa-starter-default/src/scripts';

console.log('🔄 Reorganizando Scripts\n');
console.log('='.repeat(60));

// Definir categorías y sus patrones
const categories = {
    checks: /^check-.*\.ts$/,
    debug: /^debug.*\.ts$/,
    tests: /^test-.*\.ts$/,
    verify: /^verify-.*\.ts$/,
    compare: /^compare-.*\.ts$/,
    diagnostics: /^diagnose-.*\.ts$/,
    find: /^find-.*\.ts$/,
    migrations: /^(migrate|migration)-.*\.ts$/,
    sync: /^(sync|resync|force-sync)-.*\.(ts|mjs|js)$/,
    create: /^create-.*\.ts$/,
    delete: /^delete-.*\.(ts|js)$/,
    fix: /^(fix|repair|heal|quick-fix)-.*\.ts$/,
    import: /^import-.*\.ts$/,
    cleanup: /^clean(up)?-.*\.ts$/,
    inspect: /^inspect.*\.ts$/,
    investigate: /^investigate-.*\.ts$/,
    list: /^list-.*\.ts$/,
    show: /^show-.*\.ts$/,
    analyze: /^analyze-.*\.ts$/,
    rebuild: /^rebuild-.*\.ts$/,
    reset: /^reset-.*\.(ts|js)$/,
    enable: /^(enable|activate|disable)-.*\.ts$/,
    force: /^force-.*\.ts$/,
    nuclear: /^(nuclear|true-nuclear)-.*\.ts$/,
    organize: /^organize-.*\.ts$/,
    setup: /^setup-.*\.ts$/,
    trigger: /^trigger-.*\.ts$/,
    export: /^export-.*\.ts$/,
    get: /^get-.*\.ts$/,
    recover: /^recover-.*\.ts$/,
    propagate: /^propagate-.*\.ts$/,
};

// Paso 1: Crear directorios
console.log('\n📁 Paso 1: Creando directorios...');
let dirsCreated = 0;

Object.keys(categories).forEach(cat => {
    const dir = path.join(srcScripts, cat);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`  ✓ Creado: ${cat}/`);
        dirsCreated++;
    } else {
        console.log(`  → Ya existe: ${cat}/`);
    }
});

console.log(`\n  Total: ${dirsCreated} directorios creados`);

// Paso 2: Categorizar y mover archivos
console.log('\n📦 Paso 2: Categorizando archivos...');
const files = fs.readdirSync(srcScripts);
const moves = [];
const uncategorized = [];

files.forEach(file => {
    // Ignorar directorios, archivos que no sean TS/JS, y archivos especiales
    if (fs.statSync(path.join(srcScripts, file)).isDirectory()) return;
    if (!['.ts', '.js', '.mjs'].includes(path.extname(file))) return;
    if (['seed.ts', 'add-legacy-flag.js'].includes(file)) return; // Mantener en raíz

    let categorized = false;

    for (const [category, pattern] of Object.entries(categories)) {
        if (pattern.test(file)) {
            const src = path.join(srcScripts, file);
            const dest = path.join(srcScripts, category, file);
            moves.push({ src, dest, category, file });
            categorized = true;
            break;
        }
    }

    if (!categorized && file.endsWith('.ts')) {
        uncategorized.push(file);
    }
});

console.log(`\n  Archivos a mover: ${moves.length}`);
console.log(`  Sin categoría: ${uncategorized.length}`);

// Paso 3: Ejecutar movimientos
console.log('\n🚚 Paso 3: Moviendo archivos...');
let moved = 0;

moves.forEach(({ src, dest, category, file }) => {
    try {
        fs.renameSync(src, dest);
        moved++;
        if (moved <= 10 || moved % 50 === 0) {
            console.log(`  ${moved}. ${file} → ${category}/`);
        }
    } catch (error) {
        console.error(`  ❌ Error moviendo ${file}:`, error.message);
    }
});

if (moved > 10) {
    console.log(`  ... (mostrando 10 de ${moved})`);
}

// Paso 4: Reportar archivos sin categoría
if (uncategorized.length > 0) {
    console.log('\n⚠️  Archivos sin categoría (quedaron en raíz):');
    uncategorized.slice(0, 20).forEach(file => {
        console.log(`  - ${file}`);
    });
    if (uncategorized.length > 20) {
        console.log(`  ... y ${uncategorized.length - 20} más`);
    }
}

// Resumen final
console.log(`\n${'='.repeat(60)}`);
console.log('📊 RESUMEN DE REORGANIZACIÓN');
console.log('='.repeat(60));
console.log(`Directorios creados: ${dirsCreated}`);
console.log(`Archivos movidos: ${moved}`);
console.log(`Archivos sin categoría: ${uncategorized.length}`);

// Mostrar conteo por categoría
console.log('\n📈 Archivos por categoría:');
const categoryCounts = {};
moves.forEach(({ category }) => {
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
});

Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
        console.log(`  ${cat.padEnd(15)} : ${count} archivos`);
    });

console.log('\n✅ Reorganización completa!');
