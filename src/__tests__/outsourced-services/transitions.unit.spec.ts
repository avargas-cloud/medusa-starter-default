import {
  canApprove,
  canEdit,
  canStartSettlement,
  canVoid,
  isOpen,
  isServiceState,
  SERVICE_STATES,
  type ServiceState,
} from "../../lib/outsourced-services/transitions";

describe("outsourced services — transitions", () => {
  describe("el conjunto de estados", () => {
    it("no incluye `eligible`: no hay devengo en un subcontrato", () => {
      expect(SERVICE_STATES).not.toContain("eligible" as ServiceState);
    });

    it("el terminal se llama `posted`, no `closed` — el bill asentó, no se pagó", () => {
      expect(SERVICE_STATES).toContain("posted");
      expect(SERVICE_STATES).not.toContain("closed" as ServiceState);
    });

    it("reconoce sólo los cinco estados declarados", () => {
      expect(SERVICE_STATES).toHaveLength(5);
      for (const s of SERVICE_STATES) expect(isServiceState(s)).toBe(true);
      expect(isServiceState("eligible")).toBe(false);
      expect(isServiceState("closed")).toBe(false);
      expect(isServiceState("")).toBe(false);
    });
  });

  describe("canEdit / canApprove", () => {
    it("sólo un borrador se edita o se aprueba", () => {
      expect(canEdit("draft")).toBe(true);
      expect(canApprove("draft")).toBe(true);
      for (const s of ["approved", "settling", "posted", "void"] as ServiceState[]) {
        expect(canEdit(s)).toBe(false);
        expect(canApprove(s)).toBe(false);
      }
    });
  });

  describe("canStartSettlement", () => {
    it("exige aprobación previa — un borrador nunca liquida", () => {
      expect(canStartSettlement("approved")).toBe(true);
      for (const s of ["draft", "settling", "posted", "void"] as ServiceState[]) {
        expect(canStartSettlement(s)).toBe(false);
      }
    });
  });

  describe("canVoid", () => {
    it("permite anular draft y approved", () => {
      expect(canVoid("draft")).toBe(true);
      expect(canVoid("approved")).toBe(true);
    });

    it("NO permite anular en settling: hay un bill reclamado en vuelo", () => {
      expect(canVoid("settling")).toBe(false);
    });

    it("NO permite anular un posted: el asiento ya existe en QuickBooks", () => {
      expect(canVoid("posted")).toBe(false);
    });

    it("no re-anula lo ya anulado", () => {
      expect(canVoid("void")).toBe(false);
    });
  });

  describe("isOpen", () => {
    it("abierto = todavía pide trabajo del operador", () => {
      expect(isOpen("draft")).toBe(true);
      expect(isOpen("approved")).toBe(true);
      expect(isOpen("settling")).toBe(true);
      expect(isOpen("posted")).toBe(false);
      expect(isOpen("void")).toBe(false);
    });

    it("particiona: todo estado cae en abierto o cerrado, nunca en los dos", () => {
      const open = SERVICE_STATES.filter(isOpen);
      const closed = SERVICE_STATES.filter((s) => !isOpen(s));
      expect(open.length + closed.length).toBe(SERVICE_STATES.length);
      expect(open.some((s) => closed.includes(s))).toBe(false);
    });
  });
});
