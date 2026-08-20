export const LL_CATEGORIES = [
    "strip",
    "driver",
    "sensor",
    "switch",
    "cable",
    "connector",
    "accessory",
] as const;

export type LlCategory = (typeof LL_CATEGORIES)[number];

export const LL_SYSTEMS = ["easyled", "essential"] as const;

export type LlSystem = (typeof LL_SYSTEMS)[number];

export const VALID_LL_CATEGORIES = new Set<string>(LL_CATEGORIES);
export const VALID_LL_SYSTEMS = new Set<string>(LL_SYSTEMS);
