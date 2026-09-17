/**
 * adopt-qb-bank-documents — cuerpo de `bank_journal_immutable()` con la ÚNICA
 * excepción que admite el journal: el RE-PARENT de un asiento.
 *
 * La función es compartida por los triggers de inmutabilidad de
 * `bank_journal_entry`, `bank_journal_line`, `bank_source_claim`,
 * `bank_evidence_document`, `bank_opening_clear` y `bank_opening_evidence`
 * (banking `Migration20260909022000`). Por eso la excepción está anclada por
 * `TG_TABLE_NAME`: cualquier otra tabla sigue rechazando TODO, y en
 * `bank_journal_entry` sigue rechazando DELETE y todo UPDATE que no sea una
 * de las tres aristas de abajo. Las líneas, los matches y los extractos no
 * cambian nunca — y como `source_hash`/`source_snapshot`/`amount_cents` están
 * en la parte CONGELADA de la fila, el `book_hash` de cada match
 * (`reviewHash(line.id, amount, entry.source_hash, blockers)`) sigue válido.
 *
 * Columnas que una arista puede cambiar: `source_kind`, `source_id`,
 * `document_number`, `updated_at`. Todo lo demás tiene que ser idéntico
 * (`to_jsonb(OLD) - esas = to_jsonb(NEW) - esas`). `reference` y `description`
 * NO están: el `input_hash` de un extracto cerrado cubre `book.items` enteros
 * (`statement-read.ts` → `statementBook`, que proyecta `e.reference` y
 * `e.description`), así que cambiarlos pondría `needs_review` en cada extracto
 * cerrado que contenga la línea — medido en el E2E. `document_number` no entra
 * en ese hash y es lo que el Register usa para etiquetar (`docLabelFor`).
 *
 * Aristas (`bank_journal_reparent_allowed`):
 *   adopt    qb_import → bank_check | bank_transfer, en un asiento `document`
 *            SIN reversa, y sólo si el documento nativo YA apunta a este
 *            asiento (`entry_id = OLD.id`), adoptó este TxnID
 *            (`qb_txn_id = OLD.source_id`), está `posted`, vivo, marcado
 *            `qb_source = 'adopted'` y `NEW.document_number` es su `doc_number`.
 *   revert   bank_check | bank_transfer → qb_import (la vuelta exacta): el
 *            documento adoptado está soft-deleted, `qb_txn_id = NEW.source_id`.
 *   renumber mismo (source_kind, source_id) bank_check | bank_transfer, en el
 *            asiento `document` o en su `reversal`, y `NEW.document_number` es
 *            el `doc_number` vivo del documento.
 *
 * sales-tax-center-20260917: las mismas tres aristas valen para
 * `sales_tax_payment` (`gl_sales_tax_payment`) y `sales_tax_adjustment`
 * (`gl_sales_tax_adjustment`). La tabla nativa de cada kind la resuelve
 * `bank_journal_native_table()` (lista cerrada — un kind desconocido devuelve
 * NULL y la arista se rechaza) y el lookup del documento es UNO solo, por
 * `EXECUTE format(%I)`, en vez de una rama copiada por tabla.
 *
 * Sólo cuerpos de función (`CREATE OR REPLACE`), sin tocar triggers — regla
 * de la migración 20260915000000 (el DROP TRIGGER hizo deadlock en prod).
 */
export const journalReparentGuardSql = `
CREATE FUNCTION bank_journal_native_table(p_source_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_source_kind
    WHEN 'bank_check' THEN 'gl_check'
    WHEN 'bank_transfer' THEN 'gl_transfer'
    WHEN 'sales_tax_payment' THEN 'gl_sales_tax_payment'
    WHEN 'sales_tax_adjustment' THEN 'gl_sales_tax_adjustment'
    ELSE NULL END
$$;

CREATE FUNCTION bank_journal_reparent_allowed(
  p_entry_id text, p_kind text, p_old_source_kind text, p_old_source_id text,
  p_new_source_kind text, p_new_source_id text, p_new_document_number text
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE doc_ok boolean := false;
        tbl text;
BEGIN
  -- adopt: qb_import → nativo, sólo asiento document sin reversa
  tbl := bank_journal_native_table(p_new_source_kind);
  IF p_old_source_kind = 'qb_import' AND tbl IS NOT NULL THEN
    IF p_kind <> 'document' THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = p_entry_id) THEN RETURN false; END IF;
    EXECUTE format(
      'SELECT true FROM %I d WHERE d.id = $1 AND d.entry_id = $2 AND d.qb_txn_id = $3
         AND d.status = ''posted'' AND d.deleted_at IS NULL AND d.qb_source = ''adopted'' AND d.doc_number = $4', tbl)
      INTO doc_ok USING p_new_source_id, p_entry_id, p_old_source_id, p_new_document_number;
    RETURN COALESCE(doc_ok, false);
  END IF;
  -- revert: nativo adoptado (ya soft-deleted) → qb_import con el mismo TxnID
  tbl := bank_journal_native_table(p_old_source_kind);
  IF tbl IS NOT NULL AND p_new_source_kind = 'qb_import' THEN
    IF p_kind <> 'document' THEN RETURN false; END IF;
    EXECUTE format(
      'SELECT true FROM %I d WHERE d.id = $1 AND d.entry_id = $2 AND d.qb_txn_id = $3
         AND d.deleted_at IS NOT NULL AND d.qb_source = ''adopted''', tbl)
      INTO doc_ok USING p_old_source_id, p_entry_id, p_new_source_id;
    RETURN COALESCE(doc_ok, false);
  END IF;
  -- renumber: mismo documento, número nuevo = doc_number vivo
  IF p_old_source_kind = p_new_source_kind AND p_old_source_id = p_new_source_id
     AND tbl IS NOT NULL AND p_kind IN ('document','reversal') THEN
    EXECUTE format('SELECT true FROM %I d WHERE d.id = $1 AND d.deleted_at IS NULL AND d.doc_number = $2', tbl)
      INTO doc_ok USING p_new_source_id, p_new_document_number;
    RETURN COALESCE(doc_ok, false);
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION bank_journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['source_kind','source_id','document_number','updated_at'];
BEGIN
  -- IFs ANIDADOS a propósito: la función es compartida y OLD.kind / OLD.source_kind sólo
  -- existen en bank_journal_entry; plpgsql no cortocircuita un AND, así que una sola expresión
  -- reventaba con "record old has no field kind" en bank_journal_line (medido en el E2E).
  IF TG_TABLE_NAME = 'bank_journal_entry' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - mutable) = (to_jsonb(NEW) - mutable)
       AND bank_journal_reparent_allowed(OLD.id, OLD.kind, OLD.source_kind, OLD.source_id, NEW.source_kind, NEW.source_id, NEW.document_number)
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'BANKING_JOURNAL_IMMUTABLE';
END $$;
`;
