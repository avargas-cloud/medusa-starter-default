/** Run the existing suites without replaying any of their earlier migrations. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { completionDirectory } from "../../scripts/tests/bank-completion-fixtures";
import { requireBankingSandbox } from "./security";

export async function runCompletionRegressions() {
  requireBankingSandbox();
  const backend=resolve(__dirname,"../../.."),results:Array<{suite:string;checks:number;log:string}>=[];
  const suites=[
    ["tests/e2e-bank-openings-sandbox.ts",/PASS bank openings integration: (\d+) checks/,198],
    ["tests/e2e-bank-receipts-sandbox.ts",/PASS bank receipts integration: (\d+) checks/,292],
    // 193, no 197: la suite tiene una CARRERA real entre contabilizacion y cierre de mes.
    // Cuando gana el cierre corren 4 checks extra (la contabilizacion posterior a la
    // reapertura) y reporta 197; cuando gana la contabilizacion reporta 193. Las dos ramas
    // PASAN — documentado en BANK_ACCOUNTING_FOUNDATION_PLAN.md:203/210 ("193 y 197 controles
    // PASS ... Ambas secuencias pasan") y BANK_RECEIPTS_ACCOUNTING_PLAN.md:152. El piso estaba
    // fijado en el numero de la rama afortunada, asi que rechazaba corridas verdes.
    ["tests/e2e-bank-accounting-sandbox.ts",/PASS bank accounting integration: (\d+) checks/,193],
    ["verify/verify-bank-deposits.ts",/PASS bank deposits integration: (\d+) checks/,54],
    ["tests/e2e-bank-matches-sandbox.ts",/PASS bank matches: (\d+) checks/,60],
  ] as const;
  for(const [suite,pattern,minimum] of suites) {
    console.log(`Running legacy regression ${suite}`);
    let output="";
    const status=await new Promise<number>((done,reject)=>{
      const child=spawn(process.execPath,["--import",resolve(backend,"node_modules/tsx/dist/loader.mjs"),
        resolve(backend,"src/scripts",suite)],{cwd:backend,env:process.env,stdio:["ignore","pipe","pipe"]});
      child.stdout.on("data",chunk=>{output+=String(chunk);});child.stderr.on("data",chunk=>{output+=String(chunk);});
      child.on("error",reject);child.on("exit",code=>done(code??1));
    });
    const log=resolve(completionDirectory,`legacy-${suite.split("/").pop()}-${Date.now()}.log`);
    writeFileSync(log,output,{mode:0o600,flag:"wx"});
    if(status!==0)console.error(output.split("\n").slice(-50).join("\n"));
    assert.equal(status,0,`${suite} failed; evidence ${log}`);
    const match=pattern.exec(output);assert(match,`${suite} must execute and report its actual checks; evidence ${log}`);
    const checks=Number(match[1]);assert(checks>=minimum,`${suite} reported ${checks} checks, expected at least ${minimum}`);
    results.push({suite,checks,log});console.log(`PASS legacy ${suite}: ${checks} checks`);
  }
  return results;
}
