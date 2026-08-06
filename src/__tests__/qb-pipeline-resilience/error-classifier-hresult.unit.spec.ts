// Regresión: un HRESULT de nivel QBWC no es un error "permanente" — es un
// resultado DESCONOCIDO. QBWC aborta la sesión y QuickBooks nunca devuelve
// respuesta, así que un ADD pudo haberse commiteado igual.
//
// El 2026-08-05 pasó exactamente eso con VB-1082 / PO-1111: `0x8004041C`
// DESPUÉS de que QuickBooks ya había guardado el Bill (TxnID
// 1CC54C-1785955489, $425.78). El clasificador no tenía patrón para HRESULT →
// cayó en `permanent` → `isTransient: false` → la fila quedó `failed` con
// `next_retry_at = NULL`, dormida, y la cadena entera del PO bloqueada detrás.

import { classifyQbError } from "../../lib/quickbooks/error-classifier";
import { decideAddRetrySafety } from "../../lib/quickbooks/pipeline/add-retry-safety";

describe("classifyQbError — HRESULT de nivel QBWC", () => {
  const MSG_8004041C =
    "QB HRESULT 0x8004041C: An internal QuickBooks error occurred while trying to access the QuickBooks company data file.";

  it("clasifica 0x8004041C como outcome_unknown, NO como permanent", () => {
    const c = classifyQbError({ message: MSG_8004041C });
    expect(c.class).toBe("outcome_unknown");
    // `isTransient` habilita reintento genérico del MISMO payload en
    // `decideRetry`, para TODOS los steps. Un ADD de ventas reintentado a
    // ciegas duplica un documento de dinero, así que esta clase NO puede ser
    // transitoria: el único camino que reabre la fila es el que verifica
    // existencia contra QuickBooks primero.
    expect(c.isTransient).toBe(false);
  });

  it("0x80040400 (XML no parseable) SIGUE siendo permanente", () => {
    // QuickBooks rechazó el XML antes de mirar el archivo de la compañía: está
    // probado que no creó nada, y reintentar el mismo payload malformado sólo
    // repite el error. Este es el único HRESULT con resultado conocido.
    const c = classifyQbError({
      message:
        "QB HRESULT 0x80040400: QuickBooks found an error when parsing the provided XML text stream.",
    });
    expect(c.class).toBe("permanent");
    expect(c.isTransient).toBe(false);
  });

  it("cubre otros HRESULT del namespace 0x8004xxxx", () => {
    for (const code of ["0x80040423", "0x80040480", "0x8004041c"]) {
      const c = classifyQbError({ message: `QB HRESULT ${code}: algo pasó` });
      expect(c.class).toBe("outcome_unknown");
    }
  });

  it("el HRESULT gana sobre el texto de su propio mensaje", () => {
    // El código describe el estado de la SESIÓN (murió sin respuesta); eso pesa
    // más que cualquier frase adentro. Sin esta precedencia, un mensaje con
    // "not found" se clasificaría 3100 y el llamador intentaría un Add creyendo
    // que QuickBooks confirmó una ausencia que nunca reportó.
    const c = classifyQbError({
      message: "QB HRESULT 0x8004041C: the record was not found in the file",
    });
    expect(c.class).toBe("outcome_unknown");
  });

  it("un ADD no idempotente NO se auto-reintenta ante un HRESULT", () => {
    // `decideAddRetrySafety` decide con la CLASE. Al agregar `outcome_unknown`
    // sin sumarla a `UNKNOWN_OUTCOME_CLASSES`, su rama `class !== "permanent"`
    // devolvía `safeToAutoRetry: true` con el texto "nothing was created" —
    // afirmando lo contrario de lo que pasó con VB-1082.
    const d = decideAddRetrySafety(MSG_8004041C);
    expect(d.safeToAutoRetry).toBe(false);
    expect(d.reason).toMatch(/outcome unknown/i);
  });

  it("un rechazo real de QuickBooks SÍ sigue siendo auto-reintentable (regresión)", () => {
    // Control positivo: si todo diera `false`, el test anterior no probaría nada.
    expect(
      decideAddRetrySafety("QuickBooks Error 3200: The name already exists.")
        .safeToAutoRetry
    ).toBe(true);
  });

  it("no se lleva puesto un error de QB normal que no es HRESULT (regresión)", () => {
    expect(
      classifyQbError({ code: "3200", message: "The name already exists." })
        .class
    ).toBe("duplicate");
    expect(
      classifyQbError({ message: "The transaction could not be locked." }).class
    ).toBe("lock");
    expect(classifyQbError({ message: "boom" }).class).toBe("permanent");
  });
});
