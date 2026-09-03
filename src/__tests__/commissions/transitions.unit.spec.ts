/**
 * Order Commissions — máquina de estados. Reglas: docs/ORDER_COMMISSIONS_PLAN.md §6.
 */
import {
  canApprove,
  canApproveEarly,
  canReSaveAssignment,
  canStartSettlement,
  canVoid,
  isOpen,
  refreshedState,
} from "../../lib/commissions/transitions";

const NOW = new Date("2026-08-14T12:00:00Z");
const PAST = new Date("2026-08-01T00:00:00Z");
const FUTURE = new Date("2026-09-01T00:00:00Z");

describe("refreshedState", () => {
  it("draft con devengo vencido pasa a eligible", () => {
    expect(refreshedState("draft", PAST, NOW)).toBe("eligible");
  });

  it("draft con devengo futuro se queda en draft", () => {
    expect(refreshedState("draft", FUTURE, NOW)).toBe("draft");
  });

  it("draft sin fecha (falta pago o factura) se queda en draft", () => {
    expect(refreshedState("draft", null, NOW)).toBe("draft");
  });

  it("eligible cuya condición dejó de valer (refund reabrió el pago) vuelve a draft", () => {
    expect(refreshedState("eligible", null, NOW)).toBe("draft");
    expect(refreshedState("eligible", FUTURE, NOW)).toBe("draft");
  });

  it("estados terminales y aprobados no se mueven solos", () => {
    for (const s of ["approved", "settling", "closed", "void"] as const) {
      expect(refreshedState(s, PAST, NOW)).toBe(s);
      expect(refreshedState(s, null, NOW)).toBe(s);
    }
  });
});

describe("guardas de transición", () => {
  it("solo eligible se puede aprobar", () => {
    expect(canApprove("eligible")).toBe(true);
    for (const s of ["draft", "approved", "settling", "closed", "void"] as const) {
      expect(canApprove(s)).toBe(false);
    }
  });

  it("approve temprano: draft con devengo DETERMINADO (aunque futuro), nunca sin él", () => {
    // La espera no venció pero pago+factura ya fijaron eligible_at → se puede.
    expect(canApproveEarly("draft", FUTURE)).toBe(true);
    // eligible_at también llega como string desde pg — mismo veredicto.
    expect(canApproveEarly("draft", FUTURE.toISOString())).toBe(true);
    // Orden impaga o sin factura (eligible_at null): early NO saltea el pago.
    expect(canApproveEarly("draft", null)).toBe(false);
    // Cualquier estado que no sea draft va por el camino normal, no por early.
    for (const s of ["eligible", "approved", "settling", "closed", "void"] as const) {
      expect(canApproveEarly(s, FUTURE)).toBe(false);
    }
  });

  it("solo approved arranca liquidación", () => {
    expect(canStartSettlement("approved")).toBe(true);
    for (const s of ["draft", "eligible", "settling", "closed", "void"] as const) {
      expect(canStartSettlement(s)).toBe(false);
    }
  });

  it("void solo antes de que la plata salga", () => {
    expect(canVoid("draft")).toBe(true);
    expect(canVoid("eligible")).toBe(true);
    expect(canVoid("approved")).toBe(true);
    expect(canVoid("settling")).toBe(false);
    expect(canVoid("closed")).toBe(false);
    expect(canVoid("void")).toBe(false);
  });

  it("re-guardar la asignación exige todos en draft", () => {
    expect(canReSaveAssignment(["draft", "draft"])).toBe(true);
    expect(canReSaveAssignment(["draft", "eligible"])).toBe(false);
    expect(canReSaveAssignment([])).toBe(true);
  });

  it("re-guardar la asignación también acepta voideados (historia, no reclamo vivo)", () => {
    expect(canReSaveAssignment(["void"])).toBe(true);
    expect(canReSaveAssignment(["draft", "void"])).toBe(true);
    expect(canReSaveAssignment(["void", "void"])).toBe(true);
    expect(canReSaveAssignment(["void", "eligible"])).toBe(false);
    expect(canReSaveAssignment(["void", "approved"])).toBe(false);
    expect(canReSaveAssignment(["void", "closed"])).toBe(false);
  });

  it("OPEN agrupa todo lo no terminal", () => {
    expect(isOpen("draft")).toBe(true);
    expect(isOpen("settling")).toBe(true);
    expect(isOpen("closed")).toBe(false);
    expect(isOpen("void")).toBe(false);
  });
});
