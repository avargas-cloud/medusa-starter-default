/**
 * src/api/admin/pos-accounting-access/me/route.ts
 *
 * Alias de `GET /admin/pos-access/me`. El contrato acordado nombra la URL
 * `/admin/pos-access/me`; este alias existe para que el POS funcione llame a
 * la que llame, sin duplicar la lógica (re-export del MISMO handler).
 */

export { GET } from "../../pos-access/me/route";
