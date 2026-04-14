#!/usr/bin/env tsx
/**
 * Test script to debug Save Configuration endpoint
 */

import dotenv from "dotenv";
dotenv.config();

async function testSaveConfiguration() {
  // Test with LED Strips category
  const categoryId = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4";

  const testPayload = {
    active_filters: [
      {
        attribute_id: "01KFK5S9QVXKPTG4Y8ZED3XRVJ",
        order: 0,
        type: "checkbox",
      },
      {
        attribute_id: "01KFK5SBN1R98VGVJ22R25YZQR",
        order: 1,
        type: "checkbox",
      },
    ],
    override_inheritance: false,
  };

  console.log("Testing /generate-filters endpoint...\n");
  console.log("Category ID:", categoryId);
  console.log("Payload:", JSON.stringify(testPayload, null, 2));
  console.log();

  try {
    const response = await fetch(
      `http://localhost:9000/admin/product-categories/${categoryId}/generate-filters`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testPayload),
      }
    );

    console.log("Status:", response.status);
    console.log("Status Text:", response.statusText);

    const text = await response.text();
    console.log("\nResponse body:");
    console.log(text);

    if (response.ok) {
      console.log("\n✅ Success!");
    } else {
      console.log("\n❌ Failed!");
    }
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  }
}

testSaveConfiguration();
