/** One reviewed additive correction of the still-unreleased sandbox migrations. */
import assert from "node:assert/strict";
import { readFileSync,writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { completionClaimSql } from "./completion-claim-sql";
import { completionSchemaSql } from "./completion-schema";
import { completionJournalSql } from "./completion-journal-sql";
import { completionMovementSql } from "./completion-movement-sql";
import { completionMerchantSql } from "./completion-merchant-sql";
import { settlementSchemaSql } from "./settlement-schema";
import { statementGuardSql } from "./statement-guard-sql";
import { statementMatchSql } from "./statement-match-sql";
import { withReviewLock } from "./review-common";
import { completionDirectory,completionPreflight,completionTableFingerprints } from "../../scripts/tests/bank-completion-fixtures";
import { fingerprints } from "../../scripts/tests/bank-accounting-fixtures";
export async function applyCompletionGuardCorrection(client:PoolClient,manifest:Array<{name:string;sha256:string}>) {
  const file=`${completionDirectory}/migrations-applied.json`,prior=JSON.parse(readFileSync(file,"utf8")) as {manifest:Array<{name:string;sha256:string}>};
  const reviewedVersions=[[
    "bddf4209a882cd05a0315a5b6ca9a6b2e55bee8567edbe510b4303085bd9596e",
    "fb429079191e95936aefd919a1836571e432e5685d90562e2b06a729ca784a24",
    "e6bfb0dc6a60b8d95a4235113cab1b26f42088a46647d384bcc845946ce29c37"],[
    "42e0304dfe78bdafec2cb9c930e4b8c1f6067c2aacee9c6b30de219a9a553031",
    "843be64fe81dc1749bd0032b269d91954eb24aaa1d87f194d05c38d5086d0e1a",
    "6e25f2e26b0de2002b5a704eef98651821d94aa2e240eb7335184f816ac8a51e"],[
    "ac49aa1f5e2b4cd0bea46107c77abbc99bd4b237c6e117560bf2a8d48a94731c",
    "7b9e68e17b1c0e61471300d7cb31e1876fa28c48cf9ad73e431dc1c6a11caa63",
    "6e25f2e26b0de2002b5a704eef98651821d94aa2e240eb7335184f816ac8a51e"],[
    "6389d760a711b951a15870c481247a4e1af5d58cc75a35b72c676ff27ca92ba3",
    "24057e7ac4308c5f9c27b5fad4c58c32aab47c2296b2215f9760df355c6f449d",
    "6e25f2e26b0de2002b5a704eef98651821d94aa2e240eb7335184f816ac8a51e"]];
  assert(reviewedVersions.some(v=>JSON.stringify(v)===JSON.stringify(prior.manifest.map(m=>m.sha256))),
    "Only explicitly measured sandbox SQL versions can receive the reviewed correction");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const before=await completionPreflight(client);await client.query("ROLLBACK");
  const functions=(s:string)=>Array.from(s.matchAll(/CREATE FUNCTION ([a-z_]+)\([\s\S]*?\$\$;/g));
  const sources=[completionMovementSql,completionMerchantSql,settlementSchemaSql,statementGuardSql,statementMatchSql];
  const selected=[...functions(completionClaimSql).filter(m=>m[1]==="bank_completion_validate_claim"),
    ...functions(completionJournalSql).filter(m=>m[1]==="bank_completion_journal_balance"),
    ...functions(completionSchemaSql).filter(m=>m[1]==="bank_completion_document_guard"),...sources.flatMap(functions)];
  assert(selected.length>=10&&selected.length<=20);
  const triggers=sources.flatMap(s=>Array.from(s.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER ([a-z_]+)[\s\S]*?;/g)));
  const added:string[]=[];
  await client.query("BEGIN");
  try {
    await withReviewLock(client);await client.query("SET LOCAL lock_timeout='5s'");
    assert.deepEqual(await completionTableFingerprints(client,before.schema.columns),before.data);
    for(const match of selected)try { await client.query(match[0].replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION")); }
    catch(e){const detail=e as {message?:string;position?:string;where?:string};
      throw new Error(`${match[1]}: ${detail.message}; position=${detail.position}; ${detail.where??""}`);}
    for(const match of triggers)if(!(await client.query("SELECT 1 FROM pg_trigger WHERE tgname=$1",[match[1]])).rowCount){
      await client.query(match[0]);added.push(match[1]!);}
    assert([0,6].includes(added.length),"Only reviewed movement/merchant guard triggers may be added");
    assert.deepEqual(await completionTableFingerprints(client,before.schema.columns),before.data);
    assert.deepEqual(await fingerprints(client),before.protected_data);
    assert.deepEqual(await completionTableFingerprints(client,before.migration_tracking.columns),before.migration_tracking.fingerprints);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}
  writeFileSync(`${completionDirectory}/guard-correction-${Date.now()}.json`,JSON.stringify({before,prior_manifest:prior.manifest,manifest,
    replaced_functions:selected.map(m=>m[1]),added_triggers:added},null,2),{mode:0o600,flag:"wx"});
  writeFileSync(file,JSON.stringify({...prior,manifest,correction_at:new Date().toISOString()},null,2),{mode:0o600});
  console.log("PASS reviewed SQL guard correction: existing rows and migration tracking unchanged");
}
