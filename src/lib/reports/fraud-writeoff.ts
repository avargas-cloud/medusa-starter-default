/**
 * Un credit memo de write-off por fraude NO es una devolución comercial.
 *
 * ## Por qué existe este archivo
 *
 * Cuando un chargeback por fraude se resuelve emitiendo un credit memo cuya
 * única línea es el item OtherCharge "Bad Debt Write-Off / Fraud Loss", ese item
 * apunta en QuickBooks a una cuenta de **Expense**. QB entonces debita gasto y
 * acredita A/R: las ventas NO se reducen, y la pérdida aparece como gasto
 * operativo, que es el tratamiento contable correcto — la mercadería se entregó
 * y nunca volvió.
 *
 * Nuestros reportes hacían lo contrario. La reversión de ingresos se calcula a
 * nivel HEADER (`cm.subtotal`), sin mirar qué items tiene el memo, así que un
 * write-off de W restaba W de las ventas del período. Efecto medido, con
 * R=ingreso, C=COGS:
 *
 *   QuickBooks        revenue R      gross profit R−C   + gasto de fraude W
 *   Reportes (antes)  revenue R−W    gross profit R−C−W   sin gasto separado
 *
 * y la reversión de COGS aportaba 0, porque la variante del item no tiene costo.
 * O sea que el margen % caía sin que nada lo justificara, y si la venta original
 * era de un período anterior, le restaba ventas a un mes donde esa venta nunca
 * estuvo.
 *
 * ## La forma de la solución, y por qué a nivel header
 *
 * Se clasifica el MEMO, no la línea: `metadata.reporting_treatment`. La
 * reversión de ingresos ya es header-only en los 20 sitios que la calculan, así
 * que un predicado sobre el header se agrega sin meter JOINs nuevos en queries
 * que hoy no los tienen.
 *
 * El precio de esa elección es que un memo MIXTO (líneas de producto devuelto +
 * una línea de write-off) sería irresoluble: no hay forma de excluir media
 * reversión de un total de header. Por eso `assertNotMixed` lo RECHAZA en vez de
 * adivinar. Si algún día hacen falta memos mixtos, el cambio es mover la
 * reversión a nivel línea — un refactor propio, no un parche acá.
 *
 * ## Identidad del item: por ListID, no por SKU
 *
 * El SKU es editable desde el admin de Medusa; el ListID de QuickBooks es la
 * identidad estable del item (misma razón por la que el handler del credit memo
 * prefiere `productId` sobre `FullName`). Un rename del producto no debe
 * reclasificar memos históricos.
 */

/** ListID del item OtherCharge "Bad Debt Write-Off / Fraud Loss" en QuickBooks. */
export const FRAUD_WRITEOFF_QB_LIST_ID = "80001C6E-1788546289";

/** Clave en `pos_credit_memo.metadata`. */
export const CM_REPORTING_TREATMENT_KEY = "reporting_treatment";

/** Valor que marca un memo como pérdida por fraude, fuera de las devoluciones. */
export const CM_TREATMENT_FRAUD_WRITEOFF = "fraud_writeoff";

/**
 * Predicado a agregar a TODA query que trate un credit memo como devolución
 * —reversión de ingreso, de costo, o conteo de unidades devueltas—.
 *
 * `alias` porque no todos los sitios llaman `cm` a la tabla: el breakdown del
 * dashboard usa `pcm`. Un default silencioso ahí produciría SQL que ni siquiera
 * compila, que es la falla ruidosa que se prefiere.
 *
 * `COALESCE(...,'')` cubre los memos sin metadata (todos los históricos): NULL
 * no es distinto de un string en SQL, así que sin el COALESCE el predicado
 * evaluaría NULL y los excluiría a TODOS — invirtiendo el bug en vez de
 * arreglarlo.
 */
export const cmNotFraudWriteoffSql = (alias = "cm"): string =>
  `COALESCE(${alias}.metadata->>'${CM_REPORTING_TREATMENT_KEY}','') <> '${CM_TREATMENT_FRAUD_WRITEOFF}'`;

export type CmFraudClassification = {
  /** Toda línea del memo es el item de write-off (y hay al menos una). */
  isFraudWriteoff: boolean;
  /** Algunas líneas son write-off y otras no — no representable, se rechaza. */
  isMixed: boolean;
  fraudLines: number;
  totalLines: number;
};

type PgRaw = {
  raw: (
    sql: string,
    bindings: unknown[]
  ) => Promise<{ rows?: { total?: unknown; fraud?: unknown }[] }>;
};

/**
 * Clasifica las líneas de un credit memo. knex (`__pg_connection__`) bindea con
 * `?`, no con `$1`.
 */
export async function classifyCreditMemoLines(
  pg: PgRaw,
  creditMemoId: string
): Promise<CmFraudClassification> {
  const result = await pg.raw(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE pv.metadata->>'quickbooks_id' = ?
            )::int AS fraud
     FROM pos_credit_memo_item cmi
     LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
     WHERE cmi.credit_memo_id = ? AND cmi.deleted_at IS NULL`,
    [FRAUD_WRITEOFF_QB_LIST_ID, creditMemoId]
  );
  const row = result.rows?.[0];
  const totalLines = Number(row?.total ?? 0);
  const fraudLines = Number(row?.fraud ?? 0);
  return {
    isFraudWriteoff: fraudLines > 0 && fraudLines === totalLines,
    isMixed: fraudLines > 0 && fraudLines < totalLines,
    fraudLines,
    totalLines,
  };
}

/**
 * De una lista de variantes, cuáles son el item de write-off por fraude.
 *
 * Existe para el guard de VENTA. El item apunta en QuickBooks a una cuenta de
 * Expense, y en QB una VENTA de ese item **acredita** esa cuenta: o sea que
 * facturarlo no genera ingreso, borra pérdidas por fraude ya registradas — en
 * silencio y contra el único número que se concilia con el ledger. Del lado
 * nuestro se vería como ingreso con COGS cero y margen aparente de 100%.
 *
 * El item es legítimo SOLO como línea de un credit memo. Por eso el guard vive
 * en la creación de la factura, que es donde el POS convierte una venta en un
 * hecho contable, y no en la búsqueda del catálogo: una pantalla se puede
 * saltear, la factura no.
 */
export async function findFraudWriteoffVariantIds(
  pg: {
    raw: (
      sql: string,
      bindings: unknown[]
    ) => Promise<{ rows?: { id?: unknown }[] }>;
  },
  variantIds: readonly string[]
): Promise<string[]> {
  const ids = variantIds.filter((v): v is string => typeof v === "string" && !!v);
  if (ids.length === 0) return [];
  const result = await pg.raw(
    `SELECT id FROM product_variant
     WHERE id = ANY(?) AND metadata->>'quickbooks_id' = ?`,
    [ids, FRAUD_WRITEOFF_QB_LIST_ID]
  );
  return (result.rows ?? []).map((r) => String(r.id));
}

/**
 * El metadata a mergear en el memo al completarlo. Medusa DEEP-MERGEA metadata
 * jsonb, así que devolver sólo esta clave conserva lo que ya hubiera.
 *
 * Devuelve `null` cuando no aplica — para que el caller no escriba la clave con
 * un valor vacío, que un `COALESCE(...,'') <> 'fraud_writeoff'` trataría igual
 * que ausente pero ensuciaría el registro.
 */
export function fraudWriteoffMetadata(
  classification: CmFraudClassification
): Record<string, string> | null {
  return classification.isFraudWriteoff
    ? { [CM_REPORTING_TREATMENT_KEY]: CM_TREATMENT_FRAUD_WRITEOFF }
    : null;
}
