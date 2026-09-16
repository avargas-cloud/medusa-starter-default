/**
 * Constantes del ranking de categorías de la tienda y de los conectores ECN
 * que se están dando de alta manualmente en "For Multi-Color LED Strips".
 * Consumidas por `scripts/fix/set-shop-category-ranks.ts`,
 * `scripts/fix/assign-ecn-connectors.ts` y `scripts/verify/verify-shop-ranking.ts`.
 */

export interface ShopCategoryRank {
  handle: string;
  rank: number;
}

export const SHOP_CATEGORY_RANKS: ReadonlyArray<ShopCategoryRank> = [
  { handle: "led-strips", rank: 10 },
  { handle: "led-neon", rank: 15 },
  { handle: "easyled", rank: 20 },
  { handle: "led-channels", rank: 30 },
  { handle: "led-drivers", rank: 40 },
  { handle: "controllers", rank: 50 },
  { handle: "sign-backlighting", rank: 60 },
  { handle: "linear-lighting-accessories", rank: 70 },
  { handle: "cables", rank: 80 },
];

export interface EcnConnector {
  sku: string;
  shopTitle: string;
}

/** `sku` == `product.title` actual (los productos aún no tienen un SKU propio). */
export const ECN_CONNECTORS: ReadonlyArray<EcnConnector> = [
  {
    sku: "ECN-EDG-CR3P-10",
    shopTitle: "Edge Corner Connector, 3-pin 10mm (CCT)",
  },
  {
    sku: "ECN-EDG-CR4P-10",
    shopTitle: "Edge Corner Connector, 4-pin 10mm (RGB)",
  },
  {
    sku: "ECN-EDG-CR5P-12",
    shopTitle: "Edge Corner Connector, 5-pin 12mm (RGBW)",
  },
  {
    sku: "ECN-EDG-SS3P-10",
    shopTitle: "Edge Strip-to-Strip Connector, 3-pin 10mm (CCT)",
  },
  {
    sku: "ECN-EDG-SS4P-10",
    shopTitle: "Edge Strip-to-Strip Connector, 4-pin 10mm (RGB)",
  },
  {
    sku: "ECN-EDG-SS5P-12",
    shopTitle: "Edge Strip-to-Strip Connector, 5-pin 12mm (RGBW)",
  },
  {
    sku: "ECN-EDG-WIS3P-10",
    shopTitle: "Edge Wire-to-Strip Connector, 3-pin 10mm (CCT)",
  },
  {
    sku: "ECN-EDG-WIS4P-10",
    shopTitle: "Edge Wire-to-Strip Connector, 4-pin 10mm (RGB)",
  },
  {
    sku: "ECN-EDG-WIS5P-12",
    shopTitle: "Edge Wire-to-Strip Connector, 5-pin 12mm (RGBW)",
  },
];

export const ECN_TARGET_CATEGORY_HANDLE = "for-multi-color-led-strips";
