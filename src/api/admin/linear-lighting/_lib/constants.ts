// Claves ESTABLES — espejo de linear-lighting/shared/src/catalog-types.ts
// (PRODUCT_CATEGORIES). Los labels de UI viven en la página admin.
export const LL_CATEGORIES = [
    "led_strip",
    "led_neon",
    "led_driver",
    "sensor",
    "controller",
    "amplifier",
    "remote",
    "led_strip_accessory",
    "led_driver_accessory",
    "led_neon_accessory",
] as const;

export type LlCategory = (typeof LL_CATEGORIES)[number];

export const LL_SYSTEMS = ["easyled", "essential"] as const;

export type LlSystem = (typeof LL_SYSTEMS)[number];

export const VALID_LL_CATEGORIES = new Set<string>(LL_CATEGORIES);
export const VALID_LL_SYSTEMS = new Set<string>(LL_SYSTEMS);
