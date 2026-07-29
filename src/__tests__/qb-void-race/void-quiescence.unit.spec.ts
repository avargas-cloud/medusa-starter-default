import {
  describeBlockers,
  findVoidBlockers,
  type PipelineOperationRow,
} from "../../lib/quickbooks/pipeline/document-quiescence";

/**
 * Guardas del gate de quiescencia de los VOIDS.
 *
 * El gate de `apply_payment` no se puede reusar tal cual para un void por dos
 * razones que sólo aparecen acá, y las dos producen un bloqueo ETERNO y
 * silencioso — la peor clase de falla del pipeline:
 *
 *   1. El void está DENTRO de los mutation steps de su propio documento. Sin
 *      excluir su propia fila se auto-bloquea y no despacha nunca.
 *   2. Dos voids del mismo documento se bloquearían mutuamente.
 *
 * Estos tests fijan las dos exclusiones. El SQL ya las aplica; lo que se prueba
 * acá es el re-chequeo en TypeScript, que es el que sostiene el invariante sin
 * importar cómo se hayan obtenido las filas.
 */

const row = (over: Partial<PipelineOperationRow>): PipelineOperationRow => ({
  id: "row-1",
  step: "invoice",
  status: "submitted",
  reference_id: "inv_1",
  medusa_ref_number: "INV-1",
  next_retry_at: null,
  ...over,
});

/** Pool falso: devuelve lo que se le diga, sin tocar Postgres. */
const fakePool = (rows: PipelineOperationRow[]) => ({
  query: async () => ({ rows }),
});

const VOID_ROW_ID = "void-row";

describe("findVoidBlockers", () => {
  it("no se bloquea a sí misma aunque el SQL devuelva su propia fila", async () => {
    // Si esto regresiona, el void queda diferido para siempre sin error: se
    // renueva su propio next_retry_at cada 45 s hasta el tope y recién ahí falla.
    const pool = fakePool([
      row({ id: VOID_ROW_ID, step: "void_invoice", status: "pending" }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toEqual([]);
  });

  it("otro void del mismo documento no cuenta como bloqueante", async () => {
    // Dos voids esperándose mutuamente es un deadlock, no una protección.
    const pool = fakePool([
      row({ id: "otro-void", step: "void_invoice", status: "pending" }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toEqual([]);
  });

  it("bloquea sobre el ADD en vuelo del mismo documento", async () => {
    const pool = fakePool([
      row({ id: "add-row", step: "invoice", status: "submitted" }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0].step).toBe("invoice");
  });

  it("bloquea sobre un MOD en vuelo — la carrera tipo CM-1105", async () => {
    const pool = fakePool([
      row({
        id: "mod-row",
        step: "credit_memo_mod",
        status: "pending",
        medusa_ref_number: "CM-1105",
      }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_credit_memo",
      rowId: VOID_ROW_ID,
      referenceId: "cm_1",
      orderId: null,
    });

    expect(blockers).toHaveLength(1);
    expect(describeBlockers(blockers)).toContain("CM-1105");
  });

  it("NO bloquea sobre una fila terminal — nadie la va a correr", async () => {
    // `failed` SIN next_retry_at es terminal: bloquear ahí dejaría el void
    // esperando a algo que no va a pasar nunca. Ya se ve solo en el digest.
    const pool = fakePool([
      row({
        id: "muerta",
        step: "invoice",
        status: "failed",
        next_retry_at: null,
      }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toEqual([]);
  });

  it("SÍ bloquea sobre una fila failed que todavía va a reintentar", async () => {
    const pool = fakePool([
      row({
        id: "reintenta",
        step: "invoice",
        status: "failed",
        next_retry_at: new Date("2026-07-29T16:00:00Z"),
      }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toHaveLength(1);
  });

  it("ignora steps que no mutan ESE documento", async () => {
    // Un sales_receipt no puede cambiar una invoice: si lo contara, el void de
    // una invoice quedaría rehén de un documento distinto de la misma orden.
    const pool = fakePool([
      row({ id: "sr", step: "sales_receipt", status: "submitted" }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_invoice",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toEqual([]);
  });

  it("un step de void desconocido no bloquea nada (fail-open explícito)", async () => {
    const pool = fakePool([
      row({ id: "algo", step: "invoice", status: "submitted" }),
    ]);

    const blockers = await findVoidBlockers(pool as any, {
      voidStep: "void_que_no_existe",
      rowId: VOID_ROW_ID,
      referenceId: "inv_1",
      orderId: null,
    });

    expect(blockers).toEqual([]);
  });
});
