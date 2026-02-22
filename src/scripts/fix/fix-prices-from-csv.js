#!/usr/bin/env node
/**
 * Script: Fix Prices from CSV
 * 
 * Reads sku.csv and corrects all variant prices in Medusa
 * Converts prices from dollars (CSV) to cents (Medusa DB)
 * 
 * Usage: node fix-prices-from-csv.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('🔧 Starting price correction from CSV...\n');

    // Read CSV
    const csvPath = path.join(__dirname, 'sku.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const lines = csvContent.split('\n').filter(line => line.trim());

    // Parse CSV (skip header)
    const priceMap = new Map();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r/g, ''); // Remove Windows line endings
        const [sku, listId, mpn, salesPrice, qty] = line.split(',');

        if (!sku || !salesPrice) continue;

        const priceInDollars = parseFloat(salesPrice);
        const priceInCents = Math.round(priceInDollars * 100);

        priceMap.set(sku.trim(), priceInCents);
    }

    console.log(`📋 Parsed ${priceMap.size} prices from CSV\n`);

    // Query Medusa database
    const { MedusaModule } = await import('@medusajs/framework/modules-sdk');
    const { Modules } = await import('@medusajs/framework/utils');

    const productModuleService = MedusaModule.getModuleService(Modules.PRODUCT);

    // Get all variants
    const variants = await productModuleService.listProductVariants({}, {
        select: ['id', 'sku', 'prices'],
        relations: ['prices'],
        take: 10000
    });

    console.log(`🔍 Found ${variants.length} variants in database\n`);

    // Update prices
    let updated = 0;
    let skipped = 0;
    let notFound = 0;

    for (const variant of variants) {
        const sku = variant.sku;
        if (!sku) {
            skipped++;
            continue;
        }

        const correctPriceInCents = priceMap.get(sku);
        if (!correctPriceInCents) {
            notFound++;
            console.log(`⚠️  SKU not in CSV: ${sku}`);
            continue;
        }

        // Get current price
        const currentPrice = variant.prices?.[0];
        if (!currentPrice) {
            console.log(`⚠️  No price for SKU: ${sku}`);
            continue;
        }

        const currentAmount = currentPrice.amount;

        if (currentAmount === correctPriceInCents) {
            // Already correct
            continue;
        }

        // Update price
        try {
            await productModuleService.updateProductVariantPrices(variant.id, {
                id: currentPrice.id,
                amount: correctPriceInCents,
                currency_code: currentPrice.currency_code || 'USD'
            });

            updated++;
            const oldDollars = (currentAmount / 100).toFixed(2);
            const newDollars = (correct PriceInCents / 100).toFixed(2);
            console.log(`✅ Updated ${sku}: $${oldDollars} → $${newDollars}`);
        } catch (error) {
            console.error(`❌ Error updating ${sku}:`, error.message);
        }
    }

    console.log('\n📊 Summary:');
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped (no SKU): ${skipped}`);
    console.log(`   Not in CSV: ${notFound}`);
    console.log(`   Already correct: ${variants.length - updated - skipped - notFound}`);
}

main().catch(console.error);
