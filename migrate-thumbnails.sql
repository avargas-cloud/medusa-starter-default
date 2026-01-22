-- Migration: Copy category thumbnails from metadata to thumbnail field
-- Run this in Railway PostgreSQL database console

-- Update categories: copy metadata.thumbnail → thumbnail
UPDATE product_category
SET thumbnail = metadata->>'thumbnail'
WHERE metadata->>'thumbnail' IS NOT NULL
  AND (thumbnail IS NULL OR thumbnail = '');

-- Verify results
SELECT 
  id,
  name,
  thumbnail as "Direct Thumbnail",
  metadata->>'thumbnail' as "Metadata Thumbnail"
FROM product_category
WHERE metadata->>'thumbnail' IS NOT NULL
ORDER BY name;
