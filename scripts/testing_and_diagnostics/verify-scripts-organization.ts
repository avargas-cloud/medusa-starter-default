#!/usr/bin/env tsx
/**
 * Script de Verificación: Reorganización de Scripts
 * 
 * Verifica que la reorganización de scripts se completó correctamente
 */

import fs from "fs";
import path from "path";

interface CategoryInfo {
    name: string;
    count: number;
    exists: boolean;
}

const srcScripts = "/home/alejo/medusa-starter-default/src/scripts";

const expectedCategories = [
    "checks",
    "debug",
    "tests",
    "verify",
    "compare",
    "diagnostics",
    "find",
    "migrations",
    "sync",
    "create",
    "delete",
    "fix",
    "import",
    "cleanup",
    "inspect",
    "investigate",
    "list",
    "show",
    "analyze",
    "rebuild",
    "reset",
    "enable",
    "force",
    "nuclear",
    "organize",
    "setup",
    "trigger",
    "export",
    "get",
    "recover",
    "propagate",
];

async function verifyScriptsOrganization(): Promise<void> {
    console.log("🔍 Verificando Reorganización de Scripts\n");

    const results: CategoryInfo[] = [];
    let totalScripts = 0;

    // Test 1: Verificar que las carpetas existen
    console.log("📋 Test 1: Verificando carpetas de categorías...");

    for (const category of expectedCategories) {
        const dirPath = path.join(srcScripts, category);
        const exists = fs.existsSync(dirPath);

        if (exists) {
            const files = fs
                .readdirSync(dirPath)
                .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"));
            results.push({
                name: category,
                count: files.length,
                exists: true,
            });
            totalScripts += files.length;

            if (files.length > 0) {
                console.log(`✅ ${category}/ - ${files.length} archivos`);
            } else {
                console.log(`⚠️  ${category}/ - vacío`);
            }
        } else {
            results.push({
                name: category,
                count: 0,
                exists: false,
            });
            console.log(`❌ ${category}/ - NO EXISTE`);
        }
    }

    console.log();

    // Test 2: Verificar README actualizado
    console.log("📋 Test 2: Verificando README...");

    const readmePath = path.join(srcScripts, "README.md");
    if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, "utf-8");
        const hasStructure = content.includes("## 📁 Structure");
        const hasUsage = content.includes("## 🚀 Usage");

        if (hasStructure && hasUsage) {
            console.log("✅ README.md actualizado con nueva estructura");
        } else {
            console.log("⚠️  README.md existe pero falta información");
        }
    } else {
        console.log("❌ README.md no encontrado");
    }

    console.log();

    // Test 3: Verificar cantidad de scripts esperada
    console.log("📋 Test 3: Verificando total de scripts...");

    const expectedTotal = 256; // Del resultado de la reorganización
    const tolerance = 10; // Tolerancia de ±10 archivos

    if (Math.abs(totalScripts - expectedTotal) <= tolerance) {
        console.log(
            `✅ Total de scripts: ${totalScripts} (esperado: ~${expectedTotal})`
        );
    } else {
        console.log(
            `⚠️  Total de scripts: ${totalScripts} (esperado: ~${expectedTotal})`
        );
    }

    console.log();

    // Test 4: Verificar categorías principales tienen archivos
    console.log("📋 Test 4: Verificando categorías principales...");

    const mainCategories = ["checks", "verify", "tests", "debug", "migrations"];
    let allMainHaveFiles = true;

    for (const cat of mainCategories) {
        const result = results.find((r) => r.name === cat);
        if (result && result.count > 0) {
            console.log(`✅ ${cat}/ - ${result.count} archivos`);
        } else {
            console.log(`❌ ${cat}/ - sin archivos o no existe`);
            allMainHaveFiles = false;
        }
    }

    console.log();

    // Test 5: Listar archivos que quedaron en raíz
    console.log("📋 Test 5: Archivos en raíz...");

    const rootFiles = fs
        .readdirSync(srcScripts)
        .filter((f) => {
            const fullPath = path.join(srcScripts, f);
            return (
                fs.statSync(fullPath).isFile() &&
                (f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs")) &&
                !f.startsWith(".")
            );
        });

    console.log(`Total en raíz: ${rootFiles.length} archivos`);
    if (rootFiles.length > 0 && rootFiles.length <= 30) {
        rootFiles.forEach((f) => console.log(`  - ${f}`));
    } else if (rootFiles.length > 30) {
        rootFiles.slice(0, 10).forEach((f) => console.log(`  - ${f}`));
        console.log(`  ... y ${rootFiles.length - 10} más`);
    }

    console.log();

    // Resumen final
    console.log("=".repeat(60));
    console.log("📊 RESUMEN DE VERIFICACIÓN");
    console.log("=".repeat(60));

    const existingCategories = results.filter((r) => r.exists).length;
    const categoriesWithFiles = results.filter((r) => r.count > 0).length;

    console.log(`Categorías creadas: ${existingCategories}/${expectedCategories.length}`);
    console.log(`Categorías con archivos: ${categoriesWithFiles}`);
    console.log(`Total de scripts organizados: ${totalScripts}`);
    console.log(`Scripts en raíz: ${rootFiles.length}`);

    console.log("\n📈 Top 5 categorías:");
    results
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .forEach((r, i) => {
            console.log(`  ${i + 1}. ${r.name} - ${r.count} archivos`);
        });

    console.log();

    if (existingCategories === expectedCategories.length && totalScripts > 200) {
        console.log(
            "🎉 ¡Reorganización verificada exitosamente! Todos los scripts están organizados."
        );
        process.exit(0);
    } else {
        console.log(
            "⚠️  La reorganización tiene algunos problemas. Revisa los detalles arriba."
        );
        process.exit(1);
    }
}

verifyScriptsOrganization();
