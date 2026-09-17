/**
 * src/lib/calendar/people-search.ts
 *
 * A quién se puede invitar desde el calendario personal (delta v3):
 * · coworkers — usuarios del POS (whitelist `pos_user` por email), con nombre;
 * · customers — clientes con email REAL (los `email_is_placeholder` no se
 *   ofrecen), con sus emails alternativos: `metadata.alt_email` (+ nombre del
 *   contacto) y `metadata.cc_emails` (texto separado por comas).
 * El correo "manual" no pasa por acá: lo valida `parseAttendees`.
 *
 * Bindings knex `?`. Nunca el operador jsonb `?` (lo comería knex) → `->>`.
 */
import { EMAIL_RE } from "./personal-calendar";
import type { RawPg } from "./recurring-repo";

export interface PersonEmail {
  email: string;
  /** primary | alt | cc — para que la UI diga de dónde sale cada uno. */
  kind: "primary" | "alt" | "cc";
  /** Nombre del contacto de ese email cuando se conoce (alt_first_name…). */
  contact: string | null;
}

export interface CustomerPerson {
  id: string;
  name: string;
  company: string | null;
  emails: PersonEmail[];
}

export interface CoworkerPerson {
  id: string;
  email: string;
  name: string;
}

const LIMIT = 8;
/** El modal de coworkers lista al equipo ENTERO (hoy 14); el de customers busca. */
const COWORKER_LIMIT = 50;

function fullName(first: unknown, last: unknown): string {
  return `${first == null ? "" : String(first)} ${last == null ? "" : String(last)}`.trim();
}

function splitCc(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}

export async function searchCoworkers(pg: RawPg, q: string): Promise<CoworkerPerson[]> {
  const like = `%${q}%`;
  const res = await pg.raw(
    `SELECT u.id, u.email, u.first_name, u.last_name
       FROM "user" u
       JOIN pos_user p ON lower(p.email) = lower(u.email) AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND (? = '' OR u.email ILIKE ? OR u.first_name ILIKE ? OR u.last_name ILIKE ?)
      ORDER BY u.first_name, u.last_name
      LIMIT ?`,
    [q, like, like, like, COWORKER_LIMIT]
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    email: String(r.email).toLowerCase(),
    name: fullName(r.first_name, r.last_name) || String(r.email),
  }));
}

export async function searchCustomers(pg: RawPg, q: string): Promise<CustomerPerson[]> {
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const res = await pg.raw(
    `SELECT id, email, first_name, last_name, company_name,
            metadata->>'email_is_placeholder' AS placeholder,
            metadata->>'alt_email' AS alt_email,
            metadata->>'alt_first_name' AS alt_first_name,
            metadata->>'alt_last_name' AS alt_last_name,
            metadata->>'cc_emails' AS cc_emails
       FROM customer
      WHERE deleted_at IS NULL
        AND (email ILIKE ? OR first_name ILIKE ? OR last_name ILIKE ? OR company_name ILIKE ?
             OR metadata->>'alt_email' ILIKE ?)
      ORDER BY company_name NULLS LAST, first_name, last_name
      LIMIT ?`,
    [like, like, like, like, like, LIMIT]
  );
  return res.rows.map((r) => {
    const emails: PersonEmail[] = [];
    const primary = r.email == null ? "" : String(r.email).toLowerCase();
    // `cus_…@` es el email sintético del anonimizador del sandbox (y de algún
    // import): nunca es una casilla real, flag o no flag.
    if (primary && EMAIL_RE.test(primary) && r.placeholder !== "true" && !primary.startsWith("cus_")) {
      emails.push({ email: primary, kind: "primary", contact: fullName(r.first_name, r.last_name) || null });
    }
    const alt = r.alt_email == null ? "" : String(r.alt_email).trim().toLowerCase();
    if (alt && EMAIL_RE.test(alt) && alt !== primary) {
      emails.push({ email: alt, kind: "alt", contact: fullName(r.alt_first_name, r.alt_last_name) || null });
    }
    for (const cc of splitCc(r.cc_emails)) {
      if (!emails.some((e) => e.email === cc)) emails.push({ email: cc, kind: "cc", contact: null });
    }
    return {
      id: String(r.id),
      name: fullName(r.first_name, r.last_name) || (r.company_name == null ? "" : String(r.company_name)),
      company: r.company_name == null ? null : String(r.company_name),
      emails,
    };
  });
}
