#!/usr/bin/env tsx
/**
 * Simple Registration Test - Direct HTTP Call (no hanging)
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function testRegistration() {
  console.log("🧪 Testing Case 3 Registration");
  console.log("━".repeat(50));

  const curlCommand = `
        timeout 10 curl -X POST http://localhost:9000/store/auth/register \\
          -H "Content-Type: application/json" \\
          -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
          -d '{"email": "a.vargas@ecopowertech.com", "password": "TestPassword123!", "first_name": "Alejandro", "last_name": "Vargas"}' \\
          2>&1
    `;

  try {
    const { stdout, stderr } = await execAsync(curlCommand);
    console.log("📊 Response:");
    console.log(stdout);
    if (stderr) {
      console.log("\n⚠️  Stderr:", stderr);
    }
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    if (error.stdout) console.log("Stdout:", error.stdout);
    if (error.stderr) console.log("Stderr:", error.stderr);
  }
}

testRegistration();
