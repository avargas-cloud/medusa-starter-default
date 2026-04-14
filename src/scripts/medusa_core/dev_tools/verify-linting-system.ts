#!/usr/bin/env tsx
/**
 * Script de Verificación: Sistema de Linting
 *
 * Este script verifica que:
 * 1. ESLint está correctamente configurado
 * 2. Prettier está correctamente configurado
 * 3. TypeScript strict mode funciona
 * 4. Los scripts de linting están disponibles
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
    if (details) {
      console.log(`   ${details}`);
    }
  } catch (error) {
    results.push({ name, passed: false, details: String(error) });
    console.log(`❌ ${name}`);
    console.error(`   Error: ${error}`);
  }
}

async function verifyLintingSystem(): Promise<void> {
  console.log("🔍 Verificando Sistema de Linting\n");

  // Test 1: Verificar archivos de configuración
  console.log("📋 Test 1: Verificando archivos de configuración...");

  runTest("eslint.config.mjs existe", () =>
    fs.existsSync(path.join(process.cwd(), "eslint.config.mjs"))
  );

  runTest(".prettierrc existe", () =>
    fs.existsSync(path.join(process.cwd(), ".prettierrc"))
  );

  runTest(".prettierignore existe", () =>
    fs.existsSync(path.join(process.cwd(), ".prettierignore"))
  );

  runTest("tsconfig.json tiene strict mode", () => {
    const tsconfig = JSON.parse(fs.readFileSync("tsconfig.json", "utf-8"));
    return tsconfig.compilerOptions?.strict === true;
  });

  console.log();

  // Test 2: Verificar dependencias instaladas
  console.log("📋 Test 2: Verificando dependencias instaladas...");

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  const devDeps = packageJson.devDependencies || {};

  runTest(
    "eslint instalado",
    () => "eslint" in devDeps,
    `Versión: ${devDeps.eslint || "N/A"}`
  );

  runTest(
    "@typescript-eslint/eslint-plugin instalado",
    () => "@typescript-eslint/eslint-plugin" in devDeps,
    `Versión: ${devDeps["@typescript-eslint/eslint-plugin"] || "N/A"}`
  );

  runTest(
    "prettier instalado",
    () => "prettier" in devDeps,
    `Versión: ${devDeps.prettier || "N/A"}`
  );

  console.log();

  // Test 3: Verificar scripts en package.json
  console.log("📋 Test 3: Verificando scripts de linting...");

  const scripts = packageJson.scripts || {};

  runTest("Script 'lint' disponible", () => "lint" in scripts);
  runTest("Script 'lint:fix' disponible", () => "lint:fix" in scripts);
  runTest("Script 'format' disponible", () => "format" in scripts);
  runTest("Script 'format:check' disponible", () => "format:check" in scripts);
  runTest("Script 'type-check' disponible", () => "type-check" in scripts);
  runTest("Script 'code-quality' disponible", () => "code-quality" in scripts);

  console.log();

  // Test 4: Probar que ESLint funciona
  console.log("📋 Test 4: Probando ESLint...");

  try {
    // Intentar ejecutar ESLint en un archivo de prueba
    const testFile = path.join(__dirname, "verify-linting-system.ts");
    execSync(`npx eslint ${testFile} --max-warnings=999`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    results.push({
      name: "ESLint ejecuta sin errores fatales",
      passed: true,
    });
    console.log("✅ ESLint ejecuta sin errores fatales");
  } catch (error: unknown) {
    // ESLint puede retornar código de error si encuentra problemas,
    // pero eso está bien - significa que funciona
    const errorOutput =
      error instanceof Error && "stdout" in error
        ? String((error as { stdout?: string }).stdout)
        : "";

    if (errorOutput.includes("error") || errorOutput.includes("warning")) {
      results.push({
        name: "ESLint ejecuta y detecta problemas",
        passed: true,
        details: "ESLint funciona correctamente",
      });
      console.log("✅ ESLint ejecuta y detecta problemas");
    } else {
      results.push({
        name: "ESLint ejecuta",
        passed: false,
        details: String(error),
      });
      console.log("❌ ESLint falló al ejecutar");
    }
  }

  console.log();

  // Test 5: Probar que Prettier funciona
  console.log("📋 Test 5: Probando Prettier...");

  try {
    execSync("npx prettier --version", { encoding: "utf-8", stdio: "pipe" });
    results.push({ name: "Prettier ejecuta correctamente", passed: true });
    console.log("✅ Prettier ejecuta correctamente");
  } catch (error) {
    results.push({
      name: "Prettier ejecuta correctamente",
      passed: false,
      details: String(error),
    });
    console.log("❌ Prettier falló");
  }

  console.log();

  // Test 6: Verificar documentación
  console.log("📋 Test 6: Verificando documentación...");

  runTest("LINTING_GUIDE.md existe", () =>
    fs.existsSync(path.join(process.cwd(), "docs", "LINTING_GUIDE.md"))
  );

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
      "🎉 ¡Todos los tests pasaron! El sistema de linting está configurado correctamente."
    );
    process.exit(0);
  } else {
    console.log("⚠️  Algunos tests fallaron. Revisa los errores arriba.");
    process.exit(1);
  }
}

verifyLintingSystem();
