/**
 * Las categorías válidas de Backlighting, en UN solo lugar.
 *
 * Estaban duplicadas literalmente en `route.ts` (el GET que lista variantes por
 * categoría) y en `[variant_id]/route.ts` (el POST que taguea una variante). Dos
 * copias de una whitelist es el patrón que este repo ya pagó varias veces: la que
 * se edita gana, la otra se queda vieja, y el modo de falla es silencioso —
 * taguear una categoría que el listado rechaza, o al revés.
 *
 * Se agregan tres el 2026-08-31 para que Backlighting tenga las mismas familias
 * que Linear Lighting: los conectores de cable pelado, los cables y los
 * accesorios de driver. Los productos ya existen y en LL ya tienen specs
 * autorados —16 de 22 con conectores y diagrama—, así que sumarlos a BL es
 * tagueo y reuso, no autoría nueva.
 *
 * OJO con `cables`: sus 6 productos HOY están tagueados como `accessories`, así
 * que agregarlos acá los MUEVE de balde. Ver el guard de `sync-medusa.handlers`
 * de Backlighting, que por eso dejó de medir "ninguna categoría encoge" y pasó a
 * medir "ningún producto desaparece".
 *
 * El prefijo `_` mantiene el archivo fuera del router de Medusa.
 */
export const VALID_BACKLIGHTING_CATEGORIES = new Set([
    "led-modules",
    "led-drivers",
    "controllers",
    "amplifiers",
    "remotes",
    "accessories",
    "bare-wire-connectors",
    "cables",
    "led-driver-accessories",
])
