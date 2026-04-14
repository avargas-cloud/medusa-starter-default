#!/usr/bin/env tsx

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function check() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const result = await client.query(`
    SELECT 
      p.id,
      p.title,
      p.handle,
      p.status,
      av.value as color_value
    FROM product p
    JOIN product_category_product pcp 
      ON p.id = pcp.product_id
    JOIN product_product_productattributes_attribute_value pal
      ON p.id = pal.product_id
    JOIN attribute_value av 
      ON pal.attribute_value_id = av.id
    JOIN attribute_key ak 
      ON av.attribute_key_id = ak.id
    WHERE ak.handle = 'color-options'
    AND pcp.product_category_id = (SELECT id FROM product_category WHERE handle = 'led-strips')
    AND p.status = 'published'
    ORDER BY av.value, p.title
  `);

  console.log("LED Strips - Products with color-options:\n");

  const byColor: any = {};
  result.rows.forEach((row: any) => {
    if (!byColor[row.color_value]) {
      byColor[row.color_value] = [];
    }
    byColor[row.color_value].push(row);
  });

  Object.keys(byColor)
    .sort()
    .forEach((color) => {
      console.log(`${color}: (${byColor[color].length} products)`);
      byColor[color].forEach((p: any) => {
        console.log(`  - ${p.title}`);
      });
      console.log("");
    });

  console.log(`Total unique colors: ${Object.keys(byColor).length}`);
  console.log(`Total products: ${result.rows.length}`);

  await client.end();
}

check().catch(console.error);
