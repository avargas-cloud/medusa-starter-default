import {
  DEFAULT_CHECK_PRINT_LAYOUT,
  checkPrintLayoutSchema,
  parseStoredCheckPrintLayout,
} from "../check-print-layout";

describe("checkPrintLayoutSchema", () => {
  it("accepts the default layout", () => {
    expect(checkPrintLayoutSchema.safeParse(DEFAULT_CHECK_PRINT_LAYOUT).success).toBe(true);
  });

  it("accepts a different valid layout and round-trips it unchanged", () => {
    const custom = {
      ...DEFAULT_CHECK_PRINT_LAYOUT,
      offset_x: 0.25,
      offset_y: -0.1,
      font_pt: 9,
      fields: {
        ...DEFAULT_CHECK_PRINT_LAYOUT.fields,
        memo: { x: 1.0, y: 2.5, w: 2.0 },
      },
    };
    const result = parseStoredCheckPrintLayout(custom);
    expect(result.layout).toEqual(custom);
    expect(result.is_default).toBe(false);
  });

  it("rejects x out of range (x=9)", () => {
    const bad = {
      ...DEFAULT_CHECK_PRINT_LAYOUT,
      fields: { ...DEFAULT_CHECK_PRINT_LAYOUT.fields, date: { x: 9, y: 0.7, w: 1.6 } },
    };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects y out of range (y=-0.1)", () => {
    const bad = {
      ...DEFAULT_CHECK_PRINT_LAYOUT,
      fields: { ...DEFAULT_CHECK_PRINT_LAYOUT.fields, date: { x: 6.6, y: -0.1, w: 1.6 } },
    };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects offset_x out of range (offset_x=1.5)", () => {
    const bad = { ...DEFAULT_CHECK_PRINT_LAYOUT, offset_x: 1.5 };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects font_pt out of range (font_pt=7)", () => {
    const bad = { ...DEFAULT_CHECK_PRINT_LAYOUT, font_pt: 7 };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects w out of range (w=0.2)", () => {
    const bad = {
      ...DEFAULT_CHECK_PRINT_LAYOUT,
      fields: { ...DEFAULT_CHECK_PRINT_LAYOUT.fields, memo: { x: 0.85, y: 2.4, w: 0.2 } },
    };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown key at the root", () => {
    const bad = { ...DEFAULT_CHECK_PRINT_LAYOUT, extra_key: "nope" };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown key inside a field", () => {
    const bad = {
      ...DEFAULT_CHECK_PRINT_LAYOUT,
      fields: {
        ...DEFAULT_CHECK_PRINT_LAYOUT.fields,
        date: { x: 6.6, y: 0.7, w: 1.6, extra: true },
      },
    };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a layout missing stub2", () => {
    const { stub2: _stub2, ...rest } = DEFAULT_CHECK_PRINT_LAYOUT.fields;
    const bad = { ...DEFAULT_CHECK_PRINT_LAYOUT, fields: rest };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects stubs outside the enum ('top')", () => {
    const bad = { ...DEFAULT_CHECK_PRINT_LAYOUT, stubs: "top" };
    expect(checkPrintLayoutSchema.safeParse(bad).success).toBe(false);
  });
});

describe("parseStoredCheckPrintLayout", () => {
  it("returns the default with is_default true when raw is null", () => {
    const result = parseStoredCheckPrintLayout(null);
    expect(result.layout).toEqual(DEFAULT_CHECK_PRINT_LAYOUT);
    expect(result.is_default).toBe(true);
  });

  it("returns the default with is_default true when raw is undefined", () => {
    const result = parseStoredCheckPrintLayout(undefined);
    expect(result.layout).toEqual(DEFAULT_CHECK_PRINT_LAYOUT);
    expect(result.is_default).toBe(true);
  });

  it("returns the default with is_default true on garbage input", () => {
    const result = parseStoredCheckPrintLayout({ version: 2 });
    expect(result.layout).toEqual(DEFAULT_CHECK_PRINT_LAYOUT);
    expect(result.is_default).toBe(true);
  });
});
