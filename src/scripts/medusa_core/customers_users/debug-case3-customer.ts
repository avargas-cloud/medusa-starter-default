#!/usr/bin/env tsx
/**
 * CASE 3 DEBUGGING SCRIPT
 * Comprehensive diagnostic tool for legacy customer activation issues
 *
 * Usage: npx -y tsx src/scripts/debug-case3-customer.ts email@example.com
 */

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

const email = process.argv[2];

if (!email) {
  console.error(
    "❌ Usage: npx -y tsx src/scripts/debug-case3-customer.ts email@example.com"
  );
  process.exit(1);
}

async function debugCustomer() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🔍 DEBUGGING CUSTOMER: ${email}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // 1. Check customer record
    console.log("📋 STEP 1: Customer Record");
    console.log("─".repeat(50));
    const customerResult = await client.query(
      `
            SELECT id, email, first_name, last_name, has_account, metadata, created_at, updated_at
            FROM customer
            WHERE email = $1
        `,
      [email]
    );

    if (customerResult.rows.length === 0) {
      console.log("❌ Customer not found in database");
      return;
    }

    const customer = customerResult.rows[0];
    console.log("✅ Customer found:");
    console.log("   ID:", customer.id);
    console.log("   Name:", customer.first_name, customer.last_name);
    console.log("   Has Account:", customer.has_account);
    console.log("   Created:", customer.created_at);
    console.log("   Updated:", customer.updated_at);
    console.log("\n📦 Metadata:");
    console.log(JSON.stringify(customer.metadata, null, 2));

    // Parse metadata
    let metadata = customer.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
        console.log("\n⚠️  Metadata was stored as STRING (double-stringified)");
      } catch (e) {
        console.log("\n❌ Failed to parse metadata string");
      }
    }

    if (Array.isArray(metadata)) {
      console.log("\n⚠️  Metadata is an ARRAY");
      metadata.forEach((item, i) => {
        console.log(
          `   [${i}]:`,
          typeof item === "string" ? "STRING" : "OBJECT"
        );
        console.log("       ", JSON.stringify(item, null, 2));
      });
    }

    // 2. Check for activation data
    console.log("\n📋 STEP 2: Activation Data Check");
    console.log("─".repeat(50));

    let hasActivationToken = false;
    let hasTemporaryPassword = false;
    let hasActivationExpires = false;
    let isLegacy = false;

    if (Array.isArray(metadata)) {
      for (const item of metadata) {
        let data = item;
        if (typeof item === "string") {
          try {
            data = JSON.parse(item);
          } catch {
            continue;
          }
        }
        if (data.activation_token) {
          hasActivationToken = true;
          console.log("✅ activation_token:", data.activation_token);
        }
        if (data.temporary_password) {
          hasTemporaryPassword = true;
          console.log("✅ temporary_password: ****** (hidden)");
        }
        if (data.activation_expires) {
          hasActivationExpires = true;
          console.log("✅ activation_expires:", data.activation_expires);
        }
        if (data.legacy_customer) {
          isLegacy = true;
        }
      }
    } else if (metadata && typeof metadata === "object") {
      if (metadata.activation_token) {
        hasActivationToken = true;
        console.log("✅ activation_token:", metadata.activation_token);
      }
      if (metadata.temporary_password) {
        hasTemporaryPassword = true;
        console.log("✅ temporary_password: ****** (hidden)");
      }
      if (metadata.activation_expires) {
        hasActivationExpires = true;
        console.log("✅ activation_expires:", metadata.activation_expires);
      }
      if (metadata.legacy_customer) {
        isLegacy = true;
      }
    }

    console.log("\n📊 Activation Status:");
    console.log("   Legacy Customer:", isLegacy ? "✅ YES" : "❌ NO");
    console.log("   Has Token:", hasActivationToken ? "✅ YES" : "❌ NO");
    console.log(
      "   Has Temp Password:",
      hasTemporaryPassword ? "✅ YES" : "❌ NO"
    );
    console.log(
      "   Has Expiration:",
      hasActivationExpires ? "✅ YES" : "❌ NO"
    );

    // 3. Check auth_identity
    console.log("\n📋 STEP 3: Auth Identity Check");
    console.log("─".repeat(50));
    const authResult = await client.query(
      `
            SELECT ai.id, ai.app_metadata, ai.created_at
            FROM auth_identity ai
            WHERE ai.app_metadata->>'customer_id' = $1
        `,
      [customer.id]
    );

    if (authResult.rows.length === 0) {
      console.log("❌ No auth_identity found for this customer");
      console.log("   This means the activation has NOT been completed");
    } else {
      const auth = authResult.rows[0];
      console.log("✅ Auth identity found:");
      console.log("   ID:", auth.id);
      console.log("   Created:", auth.created_at);
      console.log(
        "   App Metadata:",
        JSON.stringify(auth.app_metadata, null, 2)
      );
    }

    // 4. Check provider_identity
    console.log("\n📋 STEP 4: Provider Identity Check");
    console.log("─".repeat(50));
    const providerResult = await client.query(
      `
            SELECT pi.id, pi.entity_id, pi.provider, pi.created_at
            FROM provider_identity pi
            WHERE pi.entity_id = $1
        `,
      [email]
    );

    if (providerResult.rows.length === 0) {
      console.log("❌ No provider_identity found");
      console.log("   This means NO password has been set");
    } else {
      console.log("✅ Provider identities found:");
      providerResult.rows.forEach((p) => {
        console.log(`   - ${p.provider} (ID: ${p.id})`);
        console.log(`     Created: ${p.created_at}`);
      });
    }

    // 5. Final diagnosis
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🎯 DIAGNOSIS");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    if (
      !customer.has_account &&
      isLegacy &&
      hasActivationToken &&
      hasTemporaryPassword
    ) {
      console.log("📧 Case 3 Registration COMPLETED (Email Sent)");
      console.log("   Status: Waiting for user to click activation link");
      console.log("   Next Step: User must visit activation link in email");
    } else if (!customer.has_account && isLegacy && !hasActivationToken) {
      console.log("⚠️  Case 3 Started but INCOMPLETE");
      console.log(
        "   Status: Registration initiated but activation data not saved"
      );
      console.log(
        "   Possible Issue: Email sending failed or metadata not saved"
      );
    } else if (customer.has_account && authResult.rows.length === 0) {
      console.log("🚨 CRITICAL ISSUE: has_account=true but NO auth_identity");
      console.log('   This is the "False Success" trap');
      console.log("   Fix: Account needs to be reset and re-activated");
    } else if (customer.has_account && providerResult.rows.length === 0) {
      console.log(
        "🚨 CRITICAL ISSUE: has_account=true but NO provider_identity"
      );
      console.log("   This means password was never created");
      console.log("   Fix: Account needs to be reset and re-activated");
    } else if (
      customer.has_account &&
      authResult.rows.length > 0 &&
      providerResult.rows.length > 0
    ) {
      console.log("✅ Account FULLY ACTIVATED");
      console.log("   Status: Customer can login with email/password");
      console.log("   If login fails, check password or frontend auth flow");
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await client.end();
  }
}

debugCustomer();
