/**
 * Resolución de la URL del QB bridge.
 *
 * Antes, ~46 scripts hacían `process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"`.
 * Ese `||` convertía "me olvidé de setear la variable" en "pegale a QuickBooks de
 * producción" — y como `back-sb` sí exporta la variable pero un `medusa exec` suelto
 * no, alcanzaba con correr un script fuera del wrapper para mintear un documento
 * contable real creyendo que estabas en sandbox.
 *
 * La ausencia de configuración ahora falla. Nunca elige producción por defecto.
 */

/** Devuelve la URL del bridge, o lanza si no está configurada. */
export function requireBridgeUrl(): string {
  const url = process.env.QB_BRIDGE_URL?.trim();
  if (!url) {
    throw new Error(
      "QB_BRIDGE_URL no está seteada. Me niego a asumir el bridge de producción.\n" +
        "  · sandbox:  usá ./back-sb, o exportá QB_BRIDGE_URL apuntando al stub\n" +
        "  · producción: exportá QB_BRIDGE_URL explícitamente (y sabé que vas a QB real)"
    );
  }
  return url;
}

/**
 * Igual que `requireBridgeUrl`, pero para contextos donde la falta de bridge es una
 * condición esperada (digests, verificadores) y basta con saltear el envío.
 */
export function bridgeUrlOrNull(): string | null {
  return process.env.QB_BRIDGE_URL?.trim() || null;
}
