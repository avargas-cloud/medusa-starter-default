/** Approved v4: exactly one NEW cache row; no existing account or QuickBooks mutation. */
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
const id="e2e_bank_completion_second_usd_bank";
const fingerprint=(client:PoolClient)=>client.query(`SELECT count(*)::text n,
 md5(COALESCE(string_agg(md5(to_jsonb(q)::text),'' ORDER BY q.id),'')) hash FROM qb_account q WHERE q.id<>$1`,[id]).then(r=>r.rows);
export async function createCompletionBankFixture(client:PoolClient){
  const before=await fingerprint(client);
  await transaction(client,async()=>{
    await withReviewLock(client);
    assert(!(await client.query("SELECT 1 FROM pg_trigger WHERE tgrelid='qb_account'::regclass AND NOT tgisinternal")).rowCount);
    assert(!(await client.query("SELECT 1 FROM pg_constraint WHERE contype='f' AND (conrelid='qb_account'::regclass OR confrelid='qb_account'::regclass)")).rowCount);
    assert(!(await client.query("SELECT 1 FROM qb_account WHERE id=$1 OR qb_list_id=$1",[id])).rowCount,"Stale synthetic account needs exact recovery");
    await client.query(`INSERT INTO qb_account(id,qb_list_id,full_name,name,account_type,currency,is_active,metadata)
      VALUES($1,$1,'Synthetic sandbox USD Bank 2','Synthetic sandbox USD Bank 2','Bank','USD',true,'{"ept_synthetic":true}')`,[id]);
    assert.deepEqual(await fingerprint(client),before);
  });
  return async()=>transaction(client,async()=>{
    await withReviewLock(client);
    assert(!(await client.query("SELECT 1 FROM bank_account WHERE qb_list_id=$1 UNION ALL SELECT 1 FROM bank_journal_line WHERE account_list_id=$1",[id])).rowCount,
      "Cleanup must not orphan any bank or journal consumer");
    assert.equal((await client.query("DELETE FROM qb_account WHERE id=$1 AND qb_list_id=$1 AND metadata->>'ept_synthetic'='true'",[id])).rowCount,1);
    assert.deepEqual(await fingerprint(client),before,"All original QB cache rows preserved");
  });
}
