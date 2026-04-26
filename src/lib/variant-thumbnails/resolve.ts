export interface VariantImageShape {
  id: string;
  url: string;
}

export interface VariantShape {
  id: string;
  thumbnail: string | null;
  images: VariantImageShape[];
}

export interface ProductShape {
  id: string;
  thumbnail: string | null;
  variants: VariantShape[];
}

export interface VariantThumbnailUpdate {
  variantId: string;
  thumbnail: string;
}

/**
 * Returns which variants need their thumbnail field updated.
 *
 * An image is "variant-specific" when it appears in exactly ONE variant's
 * image list within the same product. The first such image (in the order
 * the caller provides) becomes the thumbnail.
 *
 * Skips:
 * - Single-variant products (product.thumbnail already handles the fallback)
 * - Variants with no unique image (all images shared with siblings)
 * - Variants where the proposed thumbnail equals product.thumbnail (redundant)
 * - Variants where the thumbnail is already correct (idempotent)
 *
 * The caller is responsible for sorting variant.images by created_at ascending
 * before passing them in, so "first" is deterministic.
 */
export function resolveVariantThumbnails(
  product: ProductShape
): VariantThumbnailUpdate[] {
  const { variants } = product;

  if (variants.length <= 1) return [];

  const imageShareCount = new Map<string, number>();
  for (const variant of variants) {
    for (const img of variant.images) {
      imageShareCount.set(img.id, (imageShareCount.get(img.id) ?? 0) + 1);
    }
  }

  const updates: VariantThumbnailUpdate[] = [];

  for (const variant of variants) {
    const firstUniqueImage = variant.images.find(
      (img) => (imageShareCount.get(img.id) ?? 0) === 1
    );

    if (!firstUniqueImage) continue;
    if (firstUniqueImage.url === product.thumbnail) continue;
    if (firstUniqueImage.url === variant.thumbnail) continue;

    updates.push({ variantId: variant.id, thumbnail: firstUniqueImage.url });
  }

  return updates;
}
