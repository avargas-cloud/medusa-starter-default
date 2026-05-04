---
name: EcoPowerTech Medusa Admin Extensions
description: Operational Medusa Admin screens and widgets that extend commerce, accounting, catalog, and QuickBooks workflows.
colors:
  ui-bg-base: "#ffffff"
  ui-bg-subtle: "#f8fafc"
  ui-fg-base: "#111827"
  ui-fg-subtle: "#6b7280"
  ui-border-base: "#e5e7eb"
  blue-action: "#2563eb"
  green-success: "#16a34a"
  orange-warning: "#f97316"
typography:
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
rounded:
  sm: "4px"
  md: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.blue-action}"
    textColor: "{colors.ui-bg-base}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card-base:
    backgroundColor: "{colors.ui-bg-base}"
    textColor: "{colors.ui-fg-base}"
    rounded: "{rounded.md}"
    padding: "16px"
  badge-status:
    backgroundColor: "{colors.ui-bg-subtle}"
    textColor: "{colors.ui-fg-subtle}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
---

# Design System: EcoPowerTech Medusa Admin Extensions

## 1. Overview

**Creative North Star: "The Operations Console"**

The backend admin UI rides on Medusa Admin and `@medusajs/ui`, so the correct visual move is restraint. These screens are extensions for staff who are resolving catalog, sorting, accounting, purchasing, QuickBooks, and order problems inside an existing admin shell.

Use Medusa UI tokens first. Custom styling should solve specific operational friction, such as visible select scrollbars, sortable lists, high-density panels, or clearer sync state. Reject standalone app chrome, decorative brand treatments, and any screen that feels disconnected from Medusa Admin.

**Key Characteristics:**
- Medusa-native components and token names.
- Compact cards, tables, modals, badges, and sortable rows.
- Light operational surfaces with subtle borders and sparse accent color.
- Copy that names the job: sync, map, reorder, receive, invoice, refund.

## 2. Colors

The palette is inherited from Medusa UI, with blue as the default action color and semantic badge colors for state.

### Primary
- **Admin Action Blue** (#2563eb): Use for primary actions, links, active controls, and important identifiers.

### Secondary
- **Success Green** (#16a34a): Use for completed syncs, enabled mappings, and positive counts.
- **Warning Orange** (#f97316): Use for newly added items, warning badges, and pending operational attention.

### Neutral
- **Admin Canvas** (#ffffff): Base panels, modals, and cards.
- **Subtle Admin Wash** (#f8fafc): Inset blocks, inherited settings, and low-emphasis containers.
- **Admin Border** (#e5e7eb): Dividers and component outlines.
- **Admin Subtle Text** (#6b7280): Helper copy, handles, secondary metadata.

### Named Rules
**The Medusa First Rule.** Use `@medusajs/ui` colors and classes before adding custom Tailwind values.

## 3. Typography

**Display Font:** Inter with system fallback.
**Body Font:** Inter with system fallback.
**Label/Mono Font:** Use the Medusa default mono only for IDs, handles, sequence numbers, and QuickBooks identifiers.

**Character:** Functional and explicit. Type should make hierarchy easy to scan without creating a separate brand layer inside Medusa Admin.

### Hierarchy
- **Headline** (600, 24px, 1.25): Route titles such as Accounting, Filters, Products Advanced.
- **Title** (600, 16px, 1.4): Card headings, section headings, modal headings.
- **Body** (400, 14px, 1.5): Operational instructions and explanatory text.
- **Label** (500, 12px, 1.35): Badges, helper labels, table metadata, compact controls.

### Named Rules
**The Label Specificity Rule.** Replace generic labels such as "Status" with domain-specific labels when the workflow has multiple state types.

## 4. Elevation

Medusa Admin extensions are mostly flat. Depth comes from borders, modal layering, panel grouping, and background changes rather than custom shadows.

### Shadow Vocabulary
- **Medusa Modal Shadow** (inherited): Use only through Medusa modal components.
- **Scrollbar Contrast** (`rgba(150, 150, 150, 0.6)` thumb): Used for Radix select dropdowns where scrolling must be visible.

### Named Rules
**The Flat Extension Rule.** Do not add heavy custom shadows to admin cards. Let Medusa provide elevation.

## 5. Components

### Buttons
- **Shape:** Medusa default radius, typically 4px to 8px.
- **Primary:** Use `Button variant="primary"` for save, sync, create, and execute actions.
- **Hover / Focus:** Inherit Medusa focus rings. Do not remove outlines.
- **Secondary / Ghost:** Use for cancel, close, and reversible actions.

### Chips
- **Style:** Medusa `Badge` components with blue, green, orange, or neutral status roles.
- **State:** Badges should communicate type, count, newness, or sync state. Avoid badges used only as decoration.

### Cards / Containers
- **Corner Style:** 8px where custom containers are needed.
- **Background:** `bg-ui-bg-base` for panels, `bg-ui-bg-subtle` for inherited or explanatory blocks.
- **Shadow Strategy:** No custom shadows for normal admin cards.
- **Border:** Use `border-ui-border-base`.
- **Internal Padding:** 16px for cards, 24px for page shells.

### Inputs / Fields
- **Style:** Medusa form fields and Radix controls.
- **Focus:** Preserve default focus treatment.
- **Error / Disabled:** Use Medusa validation and disabled states, not custom opacity-only states.

### Navigation
- **Style:** Use Medusa route registration with clear labels and icons. Hide duplicate extension links only when the native route is intentionally hijacked.

### Sortable Operational Lists
Sortable rows should show drag affordance through cursor, compact spacing, badges, and clear active/new state. Do not rely on side-stripe accents.

## 6. Do's and Don'ts

### Do:
- **Do** use `@medusajs/ui` primitives before custom HTML.
- **Do** keep page wrappers compact, usually `p-6 max-w-5xl` or task-specific widths.
- **Do** make scrollable select dropdowns visibly scrollable.
- **Do** use badges for operational state, not decorative color.

### Don't:
- **Don't** create custom app chrome inside Medusa Admin.
- **Don't** use decorative neon, glassmorphism, or marketing hero patterns in admin extensions.
- **Don't** use colored `border-left` or `border-right` stripes wider than 1px as accents.
- **Don't** hide destructive actions behind unclear icon-only controls without labels or confirmation.
