/**
 * Per-order QB operation lock.
 *
 * Ensures that consecutive QB submissions for the same order are processed
 * sequentially, preventing EditSequence conflicts when two saves/edits arrive
 * before the first one is confirmed by the QB bridge.
 *
 * Usage:
 *   withQbLock(orderId, async () => {
 *       // fetch EditSequence, submit to bridge, write pipeline row
 *   })
 *
 * The returned promise resolves when fn() completes. Callers that don't need
 * to await it can fire-and-forget (the lock chain is maintained internally).
 */

const locks = new Map<string, Promise<void>>();

export function withQbLock(
  key: string,
  fn: () => Promise<void>
): Promise<void> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  locks.set(key, current);

  const execution = prev
    .then(() => fn())
    .catch(() => {
      /* fn errors are handled inside fn itself */
    })
    .finally(() => {
      release();
      if (locks.get(key) === current) locks.delete(key);
    });

  return execution;
}
