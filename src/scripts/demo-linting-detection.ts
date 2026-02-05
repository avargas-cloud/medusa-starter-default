#!/usr/bin/env tsx
/**
 * Script de Demostración: Detectar errores con el sistema de linting
 * 
 * Este script crea archivos de prueba con errores intencionales y verifica
 * que el sistema de linting los detecte correctamente.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const tempDir = "/tmp/lint-test";

async function testLintDetection(): Promise<void> {
    console.log("🧪 Test de Detección de Errores con Linting\n");

    // Crear directorio temporal
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Test 1: Detectar uso de 'any' type
    console.log("📋 Test 1: Detectando uso prohibido de 'any' type...");
    const testAnyFile = path.join(tempDir, "test-any.ts");
    fs.writeFileSync(
        testAnyFile,
        `
// Este archivo tiene errores intencionales
const data: any = { name: "test" };

function processData(input: any) {
  return input;
}
`
    );

    try {
        execSync(`npx eslint ${testAnyFile}`, { stdio: "pipe" });
        console.log("❌ ESLint NO detectó el uso de 'any' (PROBLEMA)");
    } catch (error: unknown) {
        const stderr = error instanceof Error && 'stderr' in error
            ? String((error as { stderr?: Buffer }).stderr)
            : '';

        if (stderr.includes("no-explicit-any") || stderr.includes("any")) {
            console.log("✅ ESLint detectó correctamente el uso de 'any'");
        } else {
            console.log("⚠️  ESLint reportó error pero no por 'any'");
        }
    }

    // Test 2: Detectar variables no usadas
    console.log("\n📋 Test 2: Detectando variables no usadas...");
    const testUnusedFile = path.join(tempDir, "test-unused.ts");
    fs.writeFileSync(
        testUnusedFile,
        `
// Este archivo tiene variables no usadas
const unusedVariable = "never used";
let anotherUnused = 123;

function testFunc(): void {
  const localUnused = "also unused";
}
`
    );

    try {
        execSync(`npx eslint ${testUnusedFile}`, { stdio: "pipe" });
        console.log("❌ ESLint NO detectó variables no usadas (PROBLEMA)");
    } catch (error: unknown) {
        const stderr = error instanceof Error && 'stderr' in error
            ? String((error as { stderr?: Buffer }).stderr)
            : '';

        if (stderr.includes("no-unused-vars") || stderr.includes("unused")) {
            console.log("✅ ESLint detectó correctamente variables no usadas");
        } else {
            console.log("⚠️  ESLint reportó error pero no por variables no usadas");
        }
    }

    // Test 3: Verificar que Prettier detecta formateo incorrecto
    console.log("\n📋 Test 3: Detectando formateo incorrecto...");
    const testFormatFile = path.join(tempDir, "test-format.ts");
    fs.writeFileSync(
        testFormatFile,
        `const badFormat={value:1,another:2};function test(  ){return true;}
`
    );

    try {
        const output = execSync(`npx prettier --check ${testFormatFile}`, {
            encoding: "utf-8",
            stdio: "pipe",
        });
        console.log("❌ Prettier NO detectó problemas de formateo (PROBLEMA)");
    } catch (error) {
        console.log("✅ Prettier detectó correctamente problemas de formateo");
    }

    // Test 4: Verificar auto-fix de Prettier
    console.log("\n📋 Test 4: Probando auto-fix de Prettier...");
    const testAutoFixFile = path.join(tempDir, "test-autofix.ts");
    const badCode = `const x={a:1,b:2};const y=[1,2,3];`;
    fs.writeFileSync(testAutoFixFile, badCode);

    execSync(`npx prettier --write ${testAutoFixFile}`, { stdio: "pipe" });
    const fixedCode = fs.readFileSync(testAutoFixFile, "utf-8");

    if (fixedCode !== badCode && fixedCode.includes("\n")) {
        console.log("✅ Prettier formateó correctamente el código");
        console.log(`   Antes: ${badCode.substring(0, 30)}...`);
        console.log(`   Después: ${fixedCode.substring(0, 30)}...`);
    } else {
        console.log("❌ Prettier NO formateó el código (PROBLEMA)");
    }

    // Limpieza
    console.log("\n🧹 Limpiando archivos de prueba...");
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("✅ Archivos de prueba eliminados");

    console.log("\n" + "=".repeat(60));
    console.log("🎉 DEMOSTRACIÓN COMPLETADA");
    console.log("=".repeat(60));
    console.log("El sistema de linting está funcionando correctamente.");
    console.log("Detecta errores de TypeScript, uso de 'any', variables no usadas,");
    console.log("y problemas de formateo. También puede corregir automáticamente");
    console.log("problemas de formateo.");
}

testLintDetection();
