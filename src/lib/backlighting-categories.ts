/**
 * Las categorías válidas de Backlighting, en UN solo lugar.
 *
 * Estaban duplicadas literalmente en `route.ts` (el GET que lista variantes por
 * categoría) y en `[variant_id]/route.ts` (el POST que taguea una variante). Dos
 * copias de una whitelist es el patrón que este repo ya pagó varias veces: la que
 * se edita gana, la otra se queda vieja, y el modo de falla es silencioso —
 * taguear una categoría que el listado rechaza, o al revés.
 *
 * Se agregaron tres el 2026-08-31 para que Backlighting tenga las mismas familias
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
 * La página de admin (`src/admin/routes/backlighting/page.tsx`) duplicaba 6 de
 * las 9 etiquetas a mano, así que las 3 familias agregadas el 2026-08-31 nunca
 * tuvieron tab durante 11 días — el API ya las aceptaba, la pantalla no las
 * mostraba. Ahora la página importa esta misma lista: una categoría no puede
 * existir para el API sin tener también un tab.
 *
 * El prefijo `_` ya no hace falta: este archivo vive en `src/lib`, fuera del
 * router de Medusa (que sólo excluye por ese prefijo dentro de `src/api`).
 */
export const BACKLIGHTING_CATEGORIES = [
    { key: "led-modules", label: "LED Modules" },
    { key: "led-drivers", label: "LED Drivers" },
    { key: "controllers", label: "Controllers" },
    { key: "amplifiers", label: "Amplifiers" },
    { key: "remotes", label: "Remotes" },
    { key: "accessories", label: "Accessories" },
    { key: "bare-wire-connectors", label: "Bare Wire Connectors" },
    { key: "cables", label: "Cables" },
    { key: "led-driver-accessories", label: "LED Driver Accessories" },
] as const;

export type BacklightingCategoryKey = (typeof BACKLIGHTING_CATEGORIES)[number]["key"];

export const VALID_BACKLIGHTING_CATEGORIES: ReadonlySet<string> = new Set(
    BACKLIGHTING_CATEGORIES.map((c) => c.key),
);
