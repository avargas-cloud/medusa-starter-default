import { resolveStatementOpening } from "../../lib/banking/statement-opening";

const CUT = "2025-12-31";

describe("resolveStatementOpening", () => {
  it("OBE con línea opening: corte = día del OBE, saldo = la línea (signo GL)", () => {
    expect(
      resolveStatementOpening({ obe: { id: "bje_1", day: "2025-12-31", opening_cents: -224946 }, book_lines_at_cut: 3, setup_cut_date: CUT })
    ).toEqual({ id: "bje_1", cut_date: "2025-12-31", statement_balance_cents: -224946 });
  });

  it("OBE sin línea opening (saldo $0 con partidas): ancla en cero con el id del OBE", () => {
    expect(
      resolveStatementOpening({ obe: { id: "bje_2", day: "2025-12-31", opening_cents: null }, book_lines_at_cut: 2, setup_cut_date: CUT })
    ).toEqual({ id: "bje_2", cut_date: "2025-12-31", statement_balance_cents: 0 });
  });

  it("sin OBE y sin asientos hasta el corte: apertura de cero, opening_id NULL, corte del setup", () => {
    expect(resolveStatementOpening({ obe: null, book_lines_at_cut: 0, setup_cut_date: CUT })).toEqual({
      id: null,
      cut_date: CUT,
      statement_balance_cents: 0,
    });
  });

  it("sin OBE pero CON asientos hasta el corte: es una apertura que falta, no una de cero", () => {
    expect(() => resolveStatementOpening({ obe: null, book_lines_at_cut: 1, setup_cut_date: CUT })).toThrow(
      /BANKING_STATEMENT_VERIFIED_OPENING_REQUIRED/
    );
  });
});
