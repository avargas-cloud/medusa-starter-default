/**
 * src/lib/notifications/recipients.ts
 *
 * Expande una audiencia (rol) a `user_id`s de Medusa. Un rol se resuelve con
 * los MISMOS hechos que `lib/pos/access-level.ts` (pos_user.is_admin,
 * pos_accounting_grant vivo, POS_OWNER_EMAILS) para que "admin" signifique lo
 * mismo en la campana que en las rutas.
 *
 * "Todos" = quien está en `pos_user` y tiene usuario Medusa (todo el staff del
 * POS tiene fila desde la migración del 09/09). Se excluye la cuenta técnica
 * `webhook@…`: existe para las integraciones, nadie la lee.
 */

import { ownerEmails } from "../pos/access-level";

import type { Audience, Db } from "./types";

// ATAJO: exclusión por prefijo de email, sin flag en pos_user. Disparador: una
// segunda cuenta técnica (o un "inactivo" real) → agregar `pos_user.notify`.
const EXCLUDED_EMAIL_PREFIXES = ["webhook@"];

const STAFF_SQL = `
  SELECT DISTINCT u.id, lower(u.email) AS email, COALESCE(p.is_admin, false) AS is_admin
    FROM "user" u
    JOIN pos_user p ON lower(p.email) = lower(u.email) AND p.deleted_at IS NULL
   WHERE u.deleted_at IS NULL`;

interface StaffRow {
  id: string;
  email: string;
  is_admin: boolean;
}

function isExcluded(email: string): boolean {
  return EXCLUDED_EMAIL_PREFIXES.some((prefix) => email.startsWith(prefix));
}

async function loadStaff(db: Db): Promise<StaffRow[]> {
  const { rows } = await db.query<StaffRow>(STAFF_SQL);
  return rows.filter((r) => !isExcluded(r.email));
}

async function ownerUserIds(db: Db): Promise<string[]> {
  const emails = ownerEmails();
  if (emails.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "user" WHERE deleted_at IS NULL AND lower(email) = ANY($1::text[])`,
    [emails]
  );
  return rows.map((r) => r.id);
}

async function accountingUserIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT g.user_id
       FROM pos_accounting_grant g
       JOIN "user" u ON u.id = g.user_id AND u.deleted_at IS NULL
      WHERE g.revoked_at IS NULL`
  );
  return [...rows.map((r) => r.user_id), ...(await ownerUserIds(db))];
}

interface SalesRepDefault {
  medusa_id?: string;
  initials?: string;
  active?: boolean;
  is_sales_rep?: boolean;
}

/**
 * `order.metadata.sales_rep` guarda initials, no user_id; el selector del POS
 * (`useSalesReps`) las saca de `system_defaults` 'Sales Rep User', que sí
 * trae `medusa_id`. Sin match ⇒ [] (la notificación va sólo a los otros roles).
 */
export async function repUserIds(
  db: Db,
  initials: string | null | undefined
): Promise<string[]> {
  const wanted = (initials ?? "").trim().toUpperCase();
  if (!wanted) return [];
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM system_defaults
      WHERE context = 'Global' AND field_name = 'Sales Rep User'`
  );
  const ids = new Set<string>();
  for (const row of rows) {
    let parsed: SalesRepDefault;
    try {
      parsed = JSON.parse(row.value) as SalesRepDefault;
    } catch {
      continue;
    }
    if (parsed.active === false || !parsed.medusa_id) continue;
    if ((parsed.initials ?? "").trim().toUpperCase() !== wanted) continue;
    ids.add(parsed.medusa_id);
  }
  if (ids.size === 0) return [];
  const { rows: users } = await db.query<{ id: string }>(
    `SELECT id FROM "user" WHERE deleted_at IS NULL AND id = ANY($1::text[])`,
    [[...ids]]
  );
  return users.map((u) => u.id);
}

async function resolveOne(db: Db, audience: Audience): Promise<string[]> {
  switch (audience.kind) {
    // El owner es owner aunque no tenga fila en pos_user (access-level: falla
    // cerrado sin POS_OWNER_EMAILS, y no depende de la whitelist).
    case "all":
      return [...(await loadStaff(db)).map((r) => r.id), ...(await ownerUserIds(db))];
    case "admins": {
      const owners = new Set(ownerEmails());
      const staffAdmins = (await loadStaff(db))
        .filter((r) => r.is_admin || owners.has(r.email))
        .map((r) => r.id);
      return [...staffAdmins, ...(await ownerUserIds(db))];
    }
    case "owner":
      return ownerUserIds(db);
    case "accounting":
      return accountingUserIds(db);
    case "users":
      return audience.user_ids.filter((id) => typeof id === "string" && id.length > 0);
    case "rep":
      return repUserIds(db, audience.initials);
    default:
      return [];
  }
}

/** Unión sin duplicados, en orden de aparición. */
export async function resolveRecipients(db: Db, audiences: Audience[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const audience of audiences) {
    for (const id of await resolveOne(db, audience)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
