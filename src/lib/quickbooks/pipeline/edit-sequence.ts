import { getDbPool } from "../../../api/utils/db-pool";

/**
 * Saves an EditSequence (and optionally TxnLineIDs) to the cache (upsert).
 * lineIds: productId → [TxnLineID, ...] mapping. Arrays support duplicate products on the same doc.
 * Call this after every QB response that contains an EditSequence.
 */
export async function cacheEditSequence(
  entityType: string,
  qbId: string,
  editSeq: string,
  lineIds?: Record<string, string[]> | null
): Promise<void> {
  if (!qbId || !editSeq) return;
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, line_ids, cached_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (entity_type, qb_id) DO UPDATE
             SET edit_seq  = EXCLUDED.edit_seq,
                 line_ids  = COALESCE(EXCLUDED.line_ids, qb_edit_sequence_cache.line_ids),
                 cached_at = NOW()`,
    [entityType, qbId, editSeq, lineIds ? JSON.stringify(lineIds) : null]
  );
}

/**
 * Retrieves a cached EditSequence and optional TxnLineIDs map, or null if not cached.
 * Normalizes old cache format (Record<string, string>) to current format (Record<string, string[]>).
 */
export async function getCachedEditSequence(
  entityType: string,
  qbId: string
): Promise<{
  editSeq: string;
  lineIds: Record<string, string[]> | null;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT edit_seq, line_ids FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, qbId]
  );
  if (!rows[0]) return null;
  const rawLineIds = rows[0].line_ids as Record<
    string,
    string | string[]
  > | null;
  // Normalize: old cache entries stored string values; new format uses string[].
  const lineIds: Record<string, string[]> | null = rawLineIds
    ? Object.fromEntries(
        Object.entries(rawLineIds).map(([k, v]) => [
          k,
          Array.isArray(v) ? v : [v],
        ])
      )
    : null;
  return { editSeq: rows[0].edit_seq as string, lineIds };
}

/**
 * Invalidates an EditSequence cache entry (on 3210 conflict).
 */
export async function invalidateEditSequence(
  entityType: string,
  qbId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, qbId]
  );
}

/**
 * Invalidates a cached EditSequence by entity type and QB transaction ID.
 * Used by stale row cleanup to prevent stale sequences from being used in
 * subsequent Mod operations after a row is marked failed due to inactivity.
 */
export async function invalidateEditSequenceCache(
  entityType: string,
  txnId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, txnId]
  );
}
