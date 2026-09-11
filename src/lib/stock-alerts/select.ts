/**
 * Selección PURA de qué alertas avisar (user-stated 2026-09-11: "le avisamos
 * cuando el producto esté in stock"). Recibe las alertas pendientes y la
 * disponibilidad por variante en el canal de la web, y devuelve las que
 * corresponde notificar ahora. Sin I/O: el job la envuelve, y el spec la
 * ejercita sin base ni email.
 *
 * Reglas:
 *  - se avisa sólo con disponibilidad > 0 (misma vara que el carrito);
 *  - una variante sin dato de disponibilidad NO se avisa (un dato que falta
 *    no es stock);
 *  - una alerta ya notificada o cancelada nunca vuelve a salir (el job sólo
 *    recibe pendientes, pero se filtra igual por si el caller se equivoca).
 */
export interface PendingStockAlert {
  id: string;
  customer_id: string;
  email: string;
  variant_id: string;
  sku: string;
  notified_at: string | null;
  canceled_at: string | null;
}

export function selectAlertsToNotify(
  alerts: PendingStockAlert[],
  availabilityByVariant: Record<string, number | null | undefined>
): PendingStockAlert[] {
  return alerts.filter((a) => {
    if (a.notified_at || a.canceled_at) return false;
    const available = availabilityByVariant[a.variant_id];
    return (
      typeof available === "number" &&
      Number.isFinite(available) &&
      available > 0
    );
  });
}

/** Asunto y cuerpo del email — texto plano y HTML mínimos, sin promesas. */
export function buildBackInStockEmail(input: {
  productTitle: string;
  sku: string;
  productUrl: string | null;
  storeName: string;
}): { subject: string; html: string } {
  const title = input.productTitle || input.sku;
  const link = input.productUrl
    ? `<p><a href="${input.productUrl}">View ${escapeHtml(title)}</a></p>`
    : "";
  return {
    subject: `${title} is back in stock – ${input.storeName}`,
    html:
      `<p>Good news: <strong>${escapeHtml(title)}</strong> (${escapeHtml(input.sku)}) is back in stock.</p>` +
      link +
      `<p>You asked us to let you know from your lighting project. Stock moves fast, so add it to your cart when you're ready.</p>` +
      `<p>— ${escapeHtml(input.storeName)}</p>`,
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string
  );
}
