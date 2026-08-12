/**
 * Clase N (new / insufficient history) en el motor ABC-XYZ.
 *
 * Un SKU con menos de MIN_CV_POINTS meses reales en la serie del CV no puede
 * afirmar estabilidad: con 0-1 puntos la varianza es 0 por construcción y el
 * CV=0 lo clasificaba X ("demanda estable") — la etiqueta de mayor confianza
 * del sistema, ganada con cero evidencia. Esos SKUs ahora son N.
 */
import {
  MIN_CV_POINTS,
  runParetoEngine,
  xyzClassFor,
  VariantForPareto,
} from "../../services/purchasing/pareto-engine";
import type { PurchasingConfig } from "../../services/purchasing/purchasing-config.service";

const cfg: PurchasingConfig = {
  weight_tier0_30d: 0.3,
  weight_q4: 0.25,
  weight_q3: 0.2,
  weight_q2: 0.15,
  weight_q1: 0.1,
  tendency_adj: 0.05,
  business_days_per_month: 26,
  pareto_a_threshold: 0.8,
  pareto_b_threshold: 0.95,
  xyz_x_threshold: 0.5,
  xyz_y_threshold: 1.0,
  transit_air_days: 12,
  buffer_air_days: 15,
  transit_sea_days: 90,
  buffer_sea_days: 45,
  factory_mult_a: 1.0,
  factory_mult_b: 0.7,
  factory_mult_c: 0.5,
};

const v = (
  id: string,
  revenue: number,
  cv: number,
  cv_points: number
): VariantForPareto => ({ variant_id: id, revenue, cv, cv_points });

describe("xyzClassFor — la letra XYZ con historia mínima", () => {
  it("con menos de MIN_CV_POINTS puntos es N, sin importar el CV", () => {
    expect(xyzClassFor(0, 0, cfg)).toBe("N");
    expect(xyzClassFor(0, 1, cfg)).toBe("N");
    expect(xyzClassFor(0, 2, cfg)).toBe("N");
    // Incluso un CV alto con 2 puntos es "desconocido", no "errático probado"
    expect(xyzClassFor(1.8, 2, cfg)).toBe("N");
  });

  it("con exactamente MIN_CV_POINTS puntos ya clasifica X/Y/Z", () => {
    expect(MIN_CV_POINTS).toBe(3);
    expect(xyzClassFor(0.3, 3, cfg)).toBe("X");
    expect(xyzClassFor(0.7, 3, cfg)).toBe("Y");
    expect(xyzClassFor(1.5, 3, cfg)).toBe("Z");
  });

  it("con historia larga se comporta igual que siempre", () => {
    expect(xyzClassFor(0.49, 12, cfg)).toBe("X");
    expect(xyzClassFor(0.5, 12, cfg)).toBe("Y");
    expect(xyzClassFor(0.99, 12, cfg)).toBe("Y");
    expect(xyzClassFor(1.0, 12, cfg)).toBe("Z");
  });
});

describe("runParetoEngine — la clase combinada con N", () => {
  it("un SKU nuevo que domina el revenue queda AN, no AX", () => {
    // El caso SAT-65-869: primer mes $14,850, serie de CV vacía → cv=0.
    const results = runParetoEngine(
      [
        v("v_new", 14850, 0, 0),
        v("v_old1", 6000, 0.3, 12),
        v("v_old2", 500, 1.4, 12),
      ],
      cfg
    );
    const byId = new Map(results.map((r) => [r.variant_id, r]));
    expect(byId.get("v_new")).toMatchObject({
      abc_class: "A",
      xyz_class: "N",
      abcxyz_class: "AN",
      pareto_rank: 1,
    });
  });

  it("no toca la clasificación de los SKUs con historia suficiente", () => {
    const results = runParetoEngine(
      [v("v_x", 10000, 0.2, 12), v("v_y", 800, 0.8, 6), v("v_z", 100, 2.5, 12)],
      cfg
    );
    const byId = new Map(results.map((r) => [r.variant_id, r]));
    expect(byId.get("v_x")?.xyz_class).toBe("X");
    expect(byId.get("v_y")?.xyz_class).toBe("Y");
    expect(byId.get("v_z")?.xyz_class).toBe("Z");
  });

  it("la N no altera el ranking ABC ni el pareto_rank", () => {
    const results = runParetoEngine(
      [v("v_new", 9000, 0, 1), v("v_old", 1000, 0.4, 12)],
      cfg
    );
    const byId = new Map(results.map((r) => [r.variant_id, r]));
    expect(byId.get("v_new")?.pareto_rank).toBe(1);
    expect(byId.get("v_old")?.pareto_rank).toBe(2);
    expect(byId.get("v_old")?.abcxyz_class).toBe("CX");
  });
});
