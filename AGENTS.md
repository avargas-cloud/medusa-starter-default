# EcoPowerTech Backend — Agent Instructions

Provider-neutral instructions for agents working inside `backend/`. Keep this
file in sync with `CLAUDE.md`; do not replace either file with a pointer-only
stub.

## Role In The Ecosystem

`backend/` is the Medusa v2 core for EcoPowerTech. It is the source of truth for
inventory, orders, customers, POS invoices, payments, finance, and accounting
sync.

- `web/` consumes the Store API under `/store/*`.
- `store-pos/` consumes the Admin API under `/admin/*` with JWT Bearer auth.
- `backlighting/` reads and writes selected Medusa metadata for project and
  estimate integration.
- QuickBooks sync flows through the QuickBooks Bridge, not QBO OAuth.

## Load First

1. Root `../AGENTS.md`
2. Local `CLAUDE.md`
3. Root `.agent/Agent-Policy.md`
4. `../docs/SANDBOX.md` before destructive or data-changing work
5. `../graphify-out/` when feature ownership or architecture is unclear

## Stack

- Medusa v2.13
- Node.js and strict TypeScript
- PostgreSQL
- Redis
- MeiliSearch
- MinIO/S3-compatible storage
- Yarn for installs and project commands

Do not run `npm install` in this project.

## Commands

```bash
yarn dev
yarn build
yarn start
yarn type-check
yarn code-quality
yarn seed
yarn sync:meili
```

Root wrapper:

```bash
./back
```

Logs:

```bash
tmux capture-pane -t medusa-dev -p -S -50
```

## Database Access

Use native `psql`; do not write quick Node/Python scripts for simple DB reads.
Read `DATABASE_URL` from `backend/.env` and always use compact flags.

```bash
psql "$DATABASE_URL" -A -t -c "SELECT id, email FROM \"user\" LIMIT 5;"
```

Read-only diagnostics can query production when needed. All data-changing,
experimental, or destructive work must be tested in the sandbox first.

## Sandbox Requirement

Use the Docker sandbox before:

- scripts with `UPDATE`, `DELETE`, or `INSERT`
- Medusa migrations
- refund or credit memo flows
- PO receive or void flows
- inventory transfers
- fixes for incidents that write data
- any `apply-*`, `fix-*`, or `consolidate-*` script

Sandbox DB:

```text
postgresql://postgres:sandbox@localhost:5499/medusa
```

## Architecture Rules

- This is Medusa v2. Do not use v1 patterns.
- Admin API routes live in `src/api/admin/`.
- Store API routes live in `src/api/store/`.
- Custom modules live in `src/modules/`.
- Prefer native Medusa workflows and local modules before adding external
  abstractions.
- Include `x-publishable-api-key` for Store API integration where required.
- Use MeiliSearch for flexible product search.

## Auth Rules

- `customer` is the storefront actor.
- `user` is the admin/staff actor.
- POS cashiers are `user` records gated by the `pos_users` whitelist.
- If the same email exists as both admin and customer, prefer the admin user.

## Important Local Modules

- `authorize-net`
- `pos-user`
- `invoices`
- `credit_memos`
- `finance`
- `document-templates`
- `pos-tax`
- `product-attributes`
- `smart-storage`
- `store-pickup`
- `ups-*`
- `shipping-settings-*`
- `category-filters`

Check these modules before inventing new behavior.

## QuickBooks Integration

QuickBooks Desktop integration uses a local bridge service and QBWC. Backend
events write to pipeline tables, subscribers/cron jobs process queued work, and
the bridge executes QBXML operations. Do not send sandbox data to the real bridge.

## Code Standards

- Strict TypeScript.
- Avoid `any`.
- Keep files focused; target under 300 lines where practical.
- Put scripts under `src/scripts/{checks,verify,debug,tests,diagnostics,migrations,sync,fix}/`.
- Do not create scripts in the repo root.

## Verification

At minimum for backend changes:

```bash
yarn type-check
```

For risky backend behavior, add or run a focused `verify-*` script and report the
result.

## Domain Rules — LECTURA OBLIGATORIA

Las reglas de negocio de esta app viven en `.claude/rules/*.md` (rutas relativas a
la raíz del workspace), no en este archivo.

**Claude Code** las carga solo por el frontmatter `paths:`.
**Codex y otros agentes NO tienen carga automática por scope: abrí el archivo con
`Read`/`cat` antes de trabajar en ese dominio.** Es la única vía por la que las ves.

| Si vas a tocar… | Leé primero |
|---|---|
| QB pipeline, bridge, QBXML, `src/jobs/`, `src/subscribers/` | `.claude/rules/qb-pipeline.md` |
| Pagos, créditos, Treasury, invoices | `.claude/rules/payments-treasury.md` |
| PO, FO, vendor bills, purchasing, China Finance | `.claude/rules/purchasing-po-fo.md` |
| Inventario, counts, China, transfers, reports | `.claude/rules/inventory-china.md` |
| Órdenes, invoices, reservas, delivery | `.claude/rules/orders-fulfillment.md` |
| **Cualquier archivo de `backend/`** (gotchas transversales) | `.claude/rules/medusa-core.md` |
| Reglas durables por incidente (QB, vendor bills, deposits) | `.claude/rules/architecture-reminders.md` |
| Cualquier cosa que toque un secreto | `.claude/rules/secrets.md` |

Una regla nueva va al rules file de su dominio como entrada fechada de 1-4 líneas.
Nunca como párrafo en este archivo ni en el `AGENTS.md` raíz.
