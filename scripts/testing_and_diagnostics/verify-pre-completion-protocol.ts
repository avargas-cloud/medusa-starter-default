#!/usr/bin/env tsx
/**
 * Script de Verificación: Protocolo Pre-Completitud
 * 
 * Verifica que el protocolo de verificación pre-completitud se implementó correctamente
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

interface TestResult {
    name: string;
    passed: boolean;
    details?: string;
}

const results: TestResult[] = [];

function runTest(name: string, testFn: () => boolean, details?: string): void {
    try {
        const passed = testFn();
        results.push({ name, passed, details });
        console.log(passed ? `✅ ${name}` : `❌ ${name}`);
        if (details && !passed) {
            console.log(`   ${details}`);
        }
    } catch (error) {
        results.push({ name, passed: false, details: String(error) });
        console.log(`❌ ${name}`);
        console.error(`   Error: ${error}`);
    }
}

async function verifyPreCompletionProtocol(): Promise<void> {
    console.log("🔍 Verificando Protocolo de Pre-Completitud\n");

    // Test 1: Agent-Policy.md actualizado
    console.log("📋 Test 1: Verificando Agent-Policy.md...");

    runTest(
        "Agent-Policy.md contiene sección 10",
        () => {
            const content = fs.readFileSync(
                ".agent/Agent-Policy.md",
                "utf-8"
            );
            return content.includes(
                "## 10. Protocolo de Verificación Pre-Completitud"
            );
        }
    );

    runTest(
        "Protocolo menciona 'OBLIGATORIO'",
        () => {
            const content = fs.readFileSync(
                ".agent/Agent-Policy.md",
                "utf-8"
            );
            return content.includes("OBLIGATORIO");
        }
    );

    runTest(
        "Protocolo incluye checklist de verificación",
        () => {
            const content = fs.readFileSync(
                ".agent/Agent-Policy.md",
                "utf-8"
            );
            return (
                content.includes("Checklist de Verificación") &&
                content.includes("Script de verificación creado")
            );
        }
    );

    console.log();

    // Test 2: Workflow creado
    console.log("📋 Test 2: Verificando workflow...");

    runTest(
        "verify-before-completion.md existe",
        () =>
            fs.existsSync(
                ".agent/workflows/verify-before-completion.md"
            )
    );

    runTest(
        "Workflow tiene frontmatter YAML",
        () => {
            const content = fs.readFileSync(
                ".agent/workflows/verify-before-completion.md",
                "utf-8"
            );
            return content.startsWith("---\ndescription:");
        }
    );

    runTest(
        "Workflow incluye steps del protocolo",
        () => {
            const content = fs.readFileSync(
                ".agent/workflows/verify-before-completion.md",
                "utf-8"
            );
            return (
                content.includes("Crear Script de Verificación") &&
                content.includes("Ejecutar Script de Verificación")
            );
        }
    );

    console.log();

    // Test 3: Script pre-completion-check.mjs
    console.log("📋 Test 3: Verificando script pre-completion-check.mjs...");

    runTest(
        "scripts/ directorio existe",
        () => fs.existsSync("scripts")
    );

    runTest(
        "pre-completion-check.mjs existe",
        () => fs.existsSync("scripts/pre-completion-check.mjs")
    );

    runTest(
        "Script tiene shebang correcto",
        () => {
            const content = fs.readFileSync(
                "scripts/pre-completion-check.mjs",
                "utf-8"
            );
            return content.startsWith("#!/usr/bin/env node");
        }
    );

    runTest(
        "Script ejecuta checks de TypeScript",
        () => {
            const content = fs.readFileSync(
                "scripts/pre-completion-check.mjs",
                "utf-8"
            );
            return content.includes("tsc --noEmit");
        }
    );

    console.log();

    // Test 4: package.json actualizado
    console.log("📋 Test 4: Verificando package.json...");

    const packageJson = JSON.parse(
        fs.readFileSync("package.json", "utf-8")
    );

    runTest(
        "Script 'pre-complete' existe",
        () => "pre-complete" in (packageJson.scripts || {})
    );

    runTest(
        "Script apunta a pre-completion-check.mjs",
        () => {
            const script = packageJson.scripts?.["pre-complete"] || "";
            return script.includes("pre-completion-check.mjs");
        }
    );

    console.log();

    // Test 5: Ejecutar el script pre-complete
    console.log("📋 Test 5: Ejecutando 'yarn run pre-complete'...");

    try {
        const output = execSync("yarn run pre-complete", {
            encoding: "utf-8",
            stdio: "pipe",
        });

        const hasResumen = output.includes("RESUMEN DE PRE-COMPLETION CHECK");
        results.push({
            name: "pre-complete ejecuta correctamente",
            passed: hasResumen,
        });

        if (hasResumen) {
            console.log("✅ pre-complete ejecuta correctamente");
            console.log("   Output incluye resumen de checks");
        } else {
            console.log("❌ pre-complete no muestra resumen esperado");
        }
    } catch (error: unknown) {
        results.push({
            name: "pre-complete ejecuta correctamente",
            passed: false,
            details: String(error),
        });
        console.log("❌ pre-complete falló al ejecutar");
    }

    console.log();

    // Resumen final
    console.log("=".repeat(60));
    console.log("📊 RESUMEN DE VERIFICACIÓN");
    console.log("=".repeat(60));

    const totalTests = results.length;
    const passedTests = results.filter((r) => r.passed).length;
    const failedTests = totalTests - passedTests;

    console.log(`Total de tests: ${totalTests}`);
    console.log(`✅ Pasados: ${passedTests}`);
    console.log(`❌ Fallados: ${failedTests}`);

    if (failedTests > 0) {
        console.log("\n❌ Tests fallados:");
        results
            .filter((r) => !r.passed)
            .forEach((r) => {
                console.log(`  - ${r.name}`);
                if (r.details) {
                    console.log(`    ${r.details}`);
                }
            });
    }

    console.log();

    if (failedTests === 0) {
        console.log(
            "🎉 ¡Todos los tests pasaron! El protocolo de pre-completitud está implementado correctamente."
        );
        process.exit(0);
    } else {
        console.log(
            "⚠️  Algunos tests fallaron. Revisa los errores arriba."
        );
        process.exit(1);
    }
}

verifyPreCompletionProtocol();
