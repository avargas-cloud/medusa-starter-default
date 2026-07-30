import { CHINA_LOC } from "../../lib/locations";

/**
 * China Warehouse — the only location a factory order receipt may land at.
 *
 * Derived from `CHINA_LOC` instead of re-declaring the ULID, because the two
 * sides of the same guard used to read different constants: the creation route
 * writes THIS value into `factory_order.stock_location_id`, and
 * `receive-factory-order.ts` validates that stored value against `CHINA_LOC`,
 * which honours `CHINA_WAREHOUSE_LOCATION_ID`. They agreed only as long as that
 * env var stayed unset — setting it would have moved one side and made every FO
 * receipt throw "stock_location_id must be China Warehouse".
 *
 * Note this constant is read by the API layer only; the module loader never
 * pulls it (see index.ts), so reaching into `lib/` here keeps module isolation.
 */
export const FACTORY_ORDER_STOCK_LOCATION_ID = CHINA_LOC;
