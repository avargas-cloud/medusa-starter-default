#!/usr/bin/env tsx
/**
 * Script: create-pos-sales-channel.ts
 * Creates the POS Sales Channel in Medusa for pos.ecopowertech.com
 */

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function createPosSalesChannel() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // Check if POS channel already exists
    const existing = await client.query(
      `SELECT id, name FROM sales_channel WHERE name = 'POS' OR name ILIKE '%pos%'`
    );

    if (existing.rows.length > 0) {
      console.log("⚠️  POS Sales Channel already exists:");
      console.log(JSON.stringify(existing.rows, null, 2));
      return;
    }

    // Generate a Medusa-style ID
    const { rows: idRows } = await client.query(
      `SELECT gen_random_uuid() as uuid`
    );
    const uuid = idRows[0].uuid
      .replace(/-/g, "")
      .substring(0, 26)
      .toUpperCase();
    const newId = `sc_${uuid}`;

    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO sales_channel (id, name, description, is_disabled, created_at, updated_at)
       VALUES ($1, $2, $3, false, $4, $4)`,
      [
        newId,
        "POS",
        "Point of Sale channel for pos.ecopowertech.com — backorder allowed, no inventory restriction",
        now,
      ]
    );

    console.log("✅ POS Sales Channel created successfully!");
    console.log(`   ID:   ${newId}`);
    console.log(`   Name: POS`);
    console.log(`\n📋 ADD THIS TO YOUR BACKEND .env:`);
    console.log(`   POS_SALES_CHANNEL_ID=${newId}`);
    console.log(`\n📋 ADD THIS TO YOUR POS FRONTEND .env:`);
    console.log(`   NEXT_PUBLIC_SALES_CHANNEL_ID=${newId}`);
  } catch (error) {
    console.error("❌ Error:", error);
    throw error;
  } finally {
    await client.end();
  }
}

createPosSalesChannel();
