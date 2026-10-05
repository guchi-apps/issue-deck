import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
const root=process.cwd(); let dir,sha;
const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
beforeEach(()=>{
 dir=mkdtempSync(path.join(tmpdir(),"codex-fix-test-"));const clone=path.join(dir,"clone");
 git(dir,"init","--bare","--initial-branch=develop",path.join(dir,"origin.git"));git(dir,"clone",path.join(dir,"origin.git"),clone);git(clone,"config","user.name","t");git(clone,"config","user.email","t@example.com");
 writeFileSync(path.join(clone,"a.txt"),"base\n");writeFileSync(path.join(clone,"package.json"),JSON.stringify({scripts:{test:"true"}}));git(clone,"add",".");git(clone,"commit","-m","base");sha=git(clone,"rev-parse","HEAD");git(clone,"push","origin","HEAD:issue-1");
 writeFileSync(path.join(dir,"repos.conf"),`o/r ${clone}\n`);mkdirSync(path.join(dir,"bin"));
 const stub=(name,body)=>{const file=path.join(dir,"bin",name);writeFileSync(file,`#!/usr/bin/env bash\n${body}`);chmodSync(file,0o755);};
 stub("gh",'exit 0\n');stub("tmux",'exit 1\n');
 stub("curl",`url="\${!#}"; body=''
while [[ $# -gt 0 ]]; do [[ "$1" != --data-binary ]] || body="$2"; shift; done
if [[ "$url" == */review-fix ]]; then
  n=0; [[ ! -f "$TEST_DIR/count" ]] || n="$(cat "$TEST_DIR/count")"; n=$((n+1)); echo "$n" > "$TEST_DIR/count"
  if [[ "\${TEST_STALE:-0}" == 1 && "$n" -gt 1 ]]; then echo '{"error":"HEAD changed"}'; else echo '{"review":"safe finding"}'; fi
elif [[ "$url" == */claude-model ]]; then echo '{}'
else echo "$body" >> "$TEST_DIR/reports"
fi
`);
 stub("codex",`out=''; work=''
while [[ $# -gt 0 ]]; do [[ "$1" != --output-last-message ]] || out="$2"; [[ "$1" != -C ]] || work="$2"; shift; done
cat >/dev/null
[[ "\${TEST_CODEX_FAIL:-0}" == 0 ]] || exit 1
[[ "\${TEST_NO_DIFF:-0}" == 1 ]] || echo fixed > "$work/a.txt"
echo '修正しました' > "$out"
`);
 stub("npm",'exit "${TEST_VERIFY_FAIL:-0}"\n');
});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
function run(env={}){
 const result=spawnSync("bash",["scripts/start-codex-review-fix.sh","o","r","1","2",sha,"job"],{cwd:root,encoding:"utf8",env:{...process.env,PATH:`${dir}/bin:${process.env.PATH}`,TEST_DIR:dir,ISSUE_DECK_LOCAL_REPOS_CONFIG:`${dir}/repos.conf`,ISSUE_DECK_DISPATCH_ENV:`${dir}/none`,APP_BASE_URL:"http://app.test",DISPATCH_SECRET:"secret",DISPATCH_HOST_NAME:"subpc",ISSUE_DECK_PR_REVIEW_HEARTBEAT_SECONDS:"3600",...env}});
 const reports=existsSync(`${dir}/reports`)?readFileSync(`${dir}/reports`,"utf8").trim().split('\n').filter(Boolean).map(JSON.parse):[];
 return {...result,reports,head:git(`${dir}/origin.git`,"rev-parse","issue-1")};
}
it("検証後に同じブランチへpushし、完了を報告する",()=>{const r=run();expect(r.status,r.stderr).toBe(0);expect(r.head).not.toBe(sha);expect(r.reports.at(-1).status).toBe("succeeded");});
it.each([{TEST_STALE:"1"},{TEST_VERIFY_FAIL:"1"},{TEST_CODEX_FAIL:"1"},{TEST_NO_DIFF:"1"}])("HEAD変化・検証失敗・Codex失敗・未修正はpushしない %j",(env)=>{const r=run(env);expect(r.status).not.toBe(0);expect(r.head).toBe(sha);expect(r.reports.at(-1).status).toBe("failed");});
