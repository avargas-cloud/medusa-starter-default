/**
 * Script: Fix Prices from CSV
 * 
 * Reads sku.csv and corrects all variant prices in Medusa
 * Converts prices from dollars (CSV) to cents (Medusa DB)
 * 
 * CRITICAL: This script multiplies CSV prices by 100
 * because Medusa stores prices as integers in CENTS
 * 
 * Usage: node --loader tsx fix-prices-from-csv.ts
 */

import fs from 'fs';
import postgres from 'postgres';
import { config } from 'dotenv';

// Load environment variables
config();

async function main() {
    console.log('🔧 Starting price correction from CSV...\n');

    // Read CSV
    const csvContent = fs.readFileSync('./sku.csv', 'utf-8');
    const lines = csvContent.split('\n').filter(line => line.trim());

    // Parse CSV (skip header): SKU,ListID,MPN,SalesPrice,QuantityOnHand
    const priceMap = new Map<string, number>();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r/g, '');
        if (!line) continue;

        const parts = line.split(',');
        const sku = parts[0]?.trim();
        const salesPrice = parts[3]?.trim();

        if (!sku || !salesPrice) continue;

        const priceInDollars = parseFloat(salesPrice);
        const priceInCents = Math.round(priceInDollars * 100);

        priceMap.set(sku, priceInCents);
    }

    console.log(`📋 Parsed ${priceMap.size} prices from CSV\n`);

    // Connect to database
    const sql = postgres(process.env.DATABASE_URL!, {
        max: 1
    });

    // Get all variants with their prices
    const variants = await sql`
    SELECT 
      pv.id as variant_id,
      pv.sku,
      p.id as price_id,
      p.amount as current_amount,
      p.currency_code
    FROM product_variant pv
    LEFT JOIN price p ON p.variant_id = pv.id
    WHERE pv.sku IS NOT NULL
    ORDER BY pv.sku
  `;

    console.log(`🔍 Found ${variants.length} variants in database\n`);

    // Update prices
    let updated = 0;
    let skipped = 0;
    let notFound = 0;
    let alreadyCorrect = 0;

    for (const row of variants) {
        const sku = row.sku;
        const correctPriceInCents = priceMap.get(sku);

        if (!correctPriceInCents) {
            notFound++;
            console.log(`⚠️  SKU not in CSV: ${sku}`);
            continue;
        }

        if (!row.price_id) {
            console.log(`⚠️  No price for SKU: ${sku}`);
            skipped++;
            continue;
        }

        const currentAmount = row.current_amount;

        if (currentAmount === correctPriceInCents) {
            alreadyCorrect++;
            continue;
        }

        // Update price in database
        await sql`
      UPDATE price
      SET amount = ${correctPriceInCents}
      WHERE id = ${row.price_id}
    `;

        updated++;
        const oldDollars = (currentAmount / 100).toFixed(2);
        const newDollars = (correctPriceInCents / 100).toFixed(2);
        console.log(`✅ Updated ${sku}: $${oldDollars} → $${newDollars}`);
    }

    await sql.end();

    console.log('\n📊 Summary:');
    console.log(`   ✅ Updated: ${updated}`);
    console.log(`   ✓  Already correct: ${alreadyCorrect}`);
    console.log(`   ⚠️  No price in DB: ${skipped}`);
    console.log(`   ⚠️  Not in CSV: ${notFound}`);
    console.log('\n✨ Price correction complete!');
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});
