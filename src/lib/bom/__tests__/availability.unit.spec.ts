import { classifyAvailability } from "../availability";

describe("classifyAvailability", () => {
  it("sin gestión de inventario siempre entra", () => {
    expect(classifyAvailability({ manageInventory: false, allowBackorder: false, available: 0 })).toEqual({
      status: "ok",
      available: null,
    });
  });

  it("con backorder entra aunque no haya stock", () => {
    expect(classifyAvailability({ manageInventory: true, allowBackorder: true, available: 0 }).status).toBe("ok");
  });

  it("gestiona inventario: stock > 0 entra y dice cuánto hay", () => {
    expect(classifyAvailability({ manageInventory: true, allowBackorder: false, available: 7 })).toEqual({
      status: "ok",
      available: 7,
    });
  });

  it("gestiona inventario: 0, negativo, null o NaN = sin stock", () => {
    for (const available of [0, -3, null, Number.NaN]) {
      expect(classifyAvailability({ manageInventory: true, allowBackorder: false, available })).toEqual({
        status: "out_of_stock",
        available: 0,
      });
    }
  });

  it("los decimales se truncan hacia abajo (2.9 unidades son 2)", () => {
    expect(classifyAvailability({ manageInventory: true, allowBackorder: false, available: 2.9 }).available).toBe(2);
  });
});
