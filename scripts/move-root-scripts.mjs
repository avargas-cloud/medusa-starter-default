#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const projectRoot = '/home/alejo/medusa-starter-default';
const scriptsDir = path.join(projectRoot, 'src', 'scripts');

console.log('🔍 Buscando Scripts en Raíz del Proyecto\n');
console.log('='.repeat(60));

// Scripts encontrados en la raíz que deberían moverse
const scriptsToMove = [
    // Check scripts
    { file: 'check-customer-defaults.ts', category: 'checks' },
    { file: 'check-native-address-schema.ts', category: 'checks' },
    { file: 'check-token.mjs', category: 'checks' },

    // Find scripts
    { file: 'find-customer-table.ts', category: 'find' },

    // Get scripts
    { file: 'get-publishable-key.ts', category: 'get' },
    { file: 'get-token.ts', category: 'get' },

    // Show scripts
    { file: 'show-customer-schema.ts', category: 'show' },

    // Test scripts
    { file: 'test-native-addresses.ts', category: 'tests' },
    { file: 'test-native-customer-query.ts', category: 'tests' },
    { file: 'test-password-reset-e2e.ts', category: 'tests' },

    // Verify scripts
    { file: 'verify-address-defaults.ts', category: 'verify' },
    { file: 'verify-meili-sync.ts', category: 'verify' },
];

// Archivos que NO deben moverse (configuración del proyecto)
const excludeFiles = [
    'eslint.config.mjs',     // Configuración de ESLint
    'jest.config.js',        // Configuración de Jest
    'medusa-config.ts',      // Configuración de Medusa
    'migrate.js',            // Script de migración de Medusa
    'instrumentation.ts',    // Configuración de OpenTelemetry
];

console.log('\n📦 Scripts encontrados para mover:');
scriptsToMove.forEach(({ file, category }) => {
    const src = path.join(projectRoot, file);
    const exists = fs.existsSync(src);
    console.log(`  ${exists ? '✅' : '❌'} ${file} → ${category}/`);
});

console.log(`\nTotal: ${scriptsToMove.length} archivos`);

// Confirmar antes de mover
console.log('\n🚚 Moviendo archivos...');
let moved = 0;
let notFound = 0;

scriptsToMove.forEach(({ file, category }) => {
    const src = path.join(projectRoot, file);
    const dest = path.join(scriptsDir, category, file);

    if (!fs.existsSync(src)) {
        console.log(`  ⚠️  No encontrado: ${file}`);
        notFound++;
        return;
    }

    try {
        fs.renameSync(src, dest);
        console.log(`  ✓ ${file} → src/scripts/${category}/`);
        moved++;
    } catch (error) {
        console.error(`  ❌ Error moviendo ${file}:`, error.message);
    }
});

// Resumen final
console.log(`\n${'='.repeat(60)}`);
console.log('📊 RESUMEN');
console.log('='.repeat(60));
console.log(`Scripts movidos: ${moved}`);
console.log(`No encontrados: ${notFound}`);
console.log(`Total procesados: ${scriptsToMove.length}`);

console.log('\n✅ Organización de scripts en raíz completa!');
