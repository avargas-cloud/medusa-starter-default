/**
 * Default storefront region — env-overridable, falls back to the id of the
 * region this store has always used. Centralized so no route hardcodes the
 * literal (see `docs/...` audit that replaced the scattered copies).
 */
export const MEDUSA_REGION_ID: string =
  process.env.MEDUSA_REGION_ID ?? "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1";
