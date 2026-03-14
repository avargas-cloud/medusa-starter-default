/**
 * Simple query to see price_rules without hanging
 * Run this via: node --loader tsx/esm src/scripts/debug/view-price-rules.ts
 */

// Direct SQL query - no hanging
const query = `
SELECT 
    pr.id as rule_id,
    pr.value as rule_value,
    prt.rule_attribute,
    p.amount as price_amount,
    p.currency_code
FROM price_rule pr
LEFT JOIN price_rule_type prt ON pr.rule_type_id = prt.id
JOIN price p ON pr.price_id = p.id
JOIN product_variant_price_set pvps ON p.price_set_id = pvps.price_set_id
JOIN product_variant pv ON pvps.variant_id = pv.id
WHERE pv.product_id = 'product_01KGAX7RD0E6AS8JDARPEED795'
AND p.deleted_at IS NULL;
`;

console.log('Run this query in your DB:');
console.log(query);
console.log('\nOr paste into Medusa admin SQL console');
