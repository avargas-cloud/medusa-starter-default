#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function inspectSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // Check tables related to orders
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema='public' AND table_name LIKE '%order%'
    `);
    console.log(
      "Order-related tables:",
      tablesResult.rows.map((r) => r.table_name)
    );

    // Get columns for 'order' table
    if (
      tablesResult.rows.some(
        (r) => r.table_name === "order" || r.table_name === "orders"
      )
    ) {
      const orderTable = tablesResult.rows.find(
        (r) => r.table_name === "order" || r.table_name === "orders"
      ).table_name;
      const columnsResult = await client.query(
        `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema='public' AND table_name=$1
      `,
        [orderTable]
      );
      console.log(
        `\nColumns in ${orderTable}:`,
        columnsResult.rows.map((r) => r.column_name).join(", ")
      );

      // Let's get a sample cancelled order
      const sampleOrder = await client.query(`
        SELECT * FROM "${orderTable}" WHERE status = 'canceled' LIMIT 1
      `);
      console.log("\nSample cancelled order:", sampleOrder.rows[0]);
    }

    // Get columns for 'order_summary' table if it exists
    if (tablesResult.rows.some((r) => r.table_name === "order_summary")) {
      const columnsResult = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='order_summary'
      `);
      console.log(
        `\nColumns in order_summary:`,
        columnsResult.rows.map((r) => r.column_name).join(", ")
      );

      const sampleSummary = await client.query(`
        SELECT * FROM order_summary LIMIT 1
      `);
      console.log("\nSample order_summary:", sampleSummary.rows[0]);
    }
  } catch (error) {
    console.error("❌ Query failed:", error);
  } finally {
    await client.end();
  }
}

inspectSchema();
