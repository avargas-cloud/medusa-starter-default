-- Fix shipping options to use calculated pricing instead of flat rate
-- This will make Medusa call the provider modules' calculatePrice methods

-- Update all shipping options to use calculated pricing
UPDATE shipping_option 
SET price_type = 'calculated'
WHERE price_type = 'flat_rate';

-- Verify the changes
SELECT 
    id,
    name,
    provider_id,
    price_type,
    amount
FROM shipping_option
ORDER BY name;
