/**
 * Unit tests for lib/backlighting-categories.ts — the single shared source of
 * Backlighting category keys+labels, consumed by both the API routes and the
 * admin page.
 *
 * This is a drift guard as much as a data test: the admin page used to
 * duplicate 6 of the 9 categories locally, so the 3 families added on
 * 2026-08-31 (`bare-wire-connectors`, `cables`, `led-driver-accessories`)
 * never got a tab for 11 days even though the API already accepted them.
 * These assertions fail if that duplication is ever reintroduced.
 */

import * as fs from "fs";
import * as path from "path";
import {
    BACKLIGHTING_CATEGORIES,
    VALID_BACKLIGHTING_CATEGORIES,
} from "../../lib/backlighting-categories";

describe("BACKLIGHTING_CATEGORIES", () => {
    it("has exactly 9 entries", () => {
        expect(BACKLIGHTING_CATEGORIES.length).toBe(9);
    });

    it("has unique keys", () => {
        const keys = BACKLIGHTING_CATEGORIES.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("includes the 3 families added on 2026-08-31", () => {
        const keys = BACKLIGHTING_CATEGORIES.map((c) => c.key);
        expect(keys).toContain("bare-wire-connectors");
        expect(keys).toContain("cables");
        expect(keys).toContain("led-driver-accessories");
    });

    it("has a non-empty label and a lowercase-dash key for every entry", () => {
        for (const c of BACKLIGHTING_CATEGORIES) {
            expect(c.label.length).toBeGreaterThan(0);
            expect(c.key).toMatch(/^[a-z-]+$/);
        }
    });
});

describe("VALID_BACKLIGHTING_CATEGORIES", () => {
    it("has size 9 and contains every category key", () => {
        expect(VALID_BACKLIGHTING_CATEGORIES.size).toBe(9);
        for (const c of BACKLIGHTING_CATEGORIES) {
            expect(VALID_BACKLIGHTING_CATEGORIES.has(c.key)).toBe(true);
        }
    });
});

describe("drift guard — admin page and routes import the shared list", () => {
    const backendRoot = path.resolve(__dirname, "../../..");

    it("the admin page imports the shared list and no longer declares its own CATEGORIES", () => {
        const pagePath = path.join(backendRoot, "src/admin/routes/backlighting/page.tsx");
        const source = fs.readFileSync(pagePath, "utf8");
        expect(source).toContain("lib/backlighting-categories");
        expect(source).not.toContain("const CATEGORIES = [");
    });

    it("the old per-route _categories.ts file no longer exists", () => {
        const oldPath = path.join(backendRoot, "src/api/admin/backlighting/_categories.ts");
        expect(fs.existsSync(oldPath)).toBe(false);
    });

    it("both route files import the shared lib module", () => {
        const routePath = path.join(backendRoot, "src/api/admin/backlighting/route.ts");
        const variantRoutePath = path.join(
            backendRoot,
            "src/api/admin/backlighting/[variant_id]/route.ts",
        );
        expect(fs.readFileSync(routePath, "utf8")).toContain("lib/backlighting-categories");
        expect(fs.readFileSync(variantRoutePath, "utf8")).toContain("lib/backlighting-categories");
    });
});
