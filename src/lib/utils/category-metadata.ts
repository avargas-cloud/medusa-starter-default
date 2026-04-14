/**
 * Utility functions for optimizing category metadata for different contexts
 *
 * Admin API needs full metadata (including available_attributes for UI)
 * Store API should only get customer-facing fields (filters, thumbnail, etc)
 */

export interface CategoryMetadata {
  filters?: any[];
  filter_config?: {
    active_filters: string[];
    override_inheritance: boolean;
  };
  filters_metadata?: {
    total_products?: number;
    filter_logic?: string;
    total_filters?: number;
    generated_at?: string;
  };
  thumbnail?: string;
  available_attributes?: string[]; // Admin-only
  original_wc_url?: string; // Legacy, unused
  [key: string]: any;
}

/**
 * Clean metadata for Store API responses
 * Removes admin-only and legacy fields to reduce payload size
 *
 * @param metadata - Full category metadata
 * @returns Cleaned metadata with only customer-facing fields
 *
 * Reduction: ~800 bytes (33% lighter)
 */
export function cleanMetadataForStore(
  metadata: CategoryMetadata | null | undefined
): CategoryMetadata {
  if (!metadata) return {};

  const {
    available_attributes, // Remove: Only needed in Admin UI
    original_wc_url, // Remove: Legacy WooCommerce field
    ...cleanMetadata
  } = metadata;

  return cleanMetadata;
}

/**
 * Clean metadata for multiple categories
 */
export function cleanCategoriesForStore<
  T extends { metadata?: CategoryMetadata },
>(categories: T[]): T[] {
  return categories.map((cat) => ({
    ...cat,
    metadata: cleanMetadataForStore(cat.metadata),
  }));
}

/**
 * Example usage in Store API route:
 *
 * ```typescript
 * import { cleanMetadataForStore } from '@/lib/utils/category-metadata'
 *
 * export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
 *     const category = await fetchCategory(id)
 *
 *     return res.json({
 *         category: {
 *             ...category,
 *             metadata: cleanMetadataForStore(category.metadata)
 *         }
 *     })
 * }
 * ```
 */
