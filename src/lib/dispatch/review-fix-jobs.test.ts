import { describe, it, expect, vi, beforeEach } from "vitest";
const mock = vi.hoisted(() => ({ provider: vi.fn(), fetch: vi.fn(), prior: vi.fn(), create: vi.fn(), hosts: vi.fn(), sessions: vi.fn(), jobs: vi.fn(), repair: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: vi.fn(async () => ({installation:{installationId:1}})) }, dispatchSession:{count:mock.sessions},dispatchHost:{findMany:mock.hosts}, dispatchJob:{findFirst:mock.prior,create:mock.create,count:mock.jobs}, pullRequestRepairRun:{updateMany:mock.repair} } }));
vi.mock("@/lib/dispatch/implementation-provider", () => ({resolveImplementationProvider:mock.provider}));
vi.mock("@/lib/github/app-auth", () => ({getInstallationToken:vi.fn(async()=>"token")}));
vi.mock("@/lib/github/request", () => ({GITHUB_API:"https://api.github.com",githubFetch:mock.fetch}));
import { selectReviewFixComments, requestReviewFixJob, validateReviewFixTarget } from "./review-fix-jobs";
const sha="a".repeat(40);
const verdict=(agent="codex",kind="changes-requested",safe=true)=>`<!-- issue-deck${agent==="codex"?"-codex":""}-review-verdict:${kind} sha=${sha} -->${safe?`\n<!-- issue-deck-review-autofix:ok sha=${sha} -->`:""}`;
const comment=(body=verdict(),created_at="1")=>({body,created_at,author_association:"OWNER"});
const target={repository:"o/r",issueNumber:1,pullRequest:2,headSha:sha,manual:false,runId:"123"};
beforeEach(()=>{
 vi.clearAllMocks(); mock.provider.mockResolvedValue("codex");mock.sessions.mockResolvedValue(0);mock.jobs.mockResolvedValue(0);mock.prior.mockResolvedValue(null);mock.hosts.mockResolvedValue([{name:"subpc",repositories:JSON.stringify(["o/r"])}]);mock.create.mockImplementation(async ({data})=>({id:"job",...data}));
 mock.fetch.mockImplementation(async (url:string)=>({ok:true,json:async()=>url.includes('/pulls/')?{state:"open",draft:false,head:{sha,ref:"issue-1",repo:{full_name:"o/r"}},base:{ref:"develop"}}:url.includes('/2/comments')?[comment()]:url.includes('/1/comments')?[comment(`<!-- issue-deck-review-fix:handoff sha=${sha} -->`)]:{state:"open",labels:[]}}));
});
describe("レビュー修正の安全判定",()=>{
 it("Claude/Codexの安全な最新指摘を取り出す",()=>expect(selectReviewFixComments([comment(),comment(verdict("claude"))],sha,false)).toContain("changes-requested"));
 it("古い安全印と最新needs-checkを組み合わせない",()=>expect(selectReviewFixComments([comment(),comment(verdict("codex","needs-check",false),"2")],sha,false)).toBeNull());
 it("未信頼コメント・古いHEAD・安全印なしを自動採用しない",()=>{expect(selectReviewFixComments([{...comment(),author_association:"NONE"}],sha,false)).toBeNull();expect(selectReviewFixComments([comment()],"b".repeat(40),false)).toBeNull();expect(selectReviewFixComments([comment(verdict("codex","changes-requested",false))],sha,false)).toBeNull();});
 it("手動なら安全印なしの要修正を扱える",()=>expect(selectReviewFixComments([comment(verdict("codex","changes-requested",false))],sha,true)).toBeTruthy());
 it("担当不明なら停止する",async()=>{mock.provider.mockResolvedValue(null);await expect(validateReviewFixTarget(target)).rejects.toThrow("実装担当");});
 it("実装セッション・実装ジョブ中は停止する",async()=>{mock.sessions.mockResolvedValue(1);await expect(validateReviewFixTarget(target)).rejects.toThrow("セッション");mock.sessions.mockResolvedValue(0);mock.jobs.mockResolvedValue(1);await expect(validateReviewFixTarget(target)).rejects.toThrow("実装ジョブ");});
 it("古いpollerは修正を引き受けない",async()=>{mock.hosts.mockResolvedValue([]);await expect(requestReviewFixJob(target)).rejects.toThrow("サブPC");expect(mock.hosts).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({reviewFixCapable:true,codexCapable:true})}));});
 it("LAUNCHと同じ活性キーで排他し、画面の仮runningを消す",async()=>{await requestReviewFixJob(target);expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({activeKey:"o/r#1",kind:"REVIEW_FIX"})}));expect(mock.repair).toHaveBeenCalled();});
 it("同じHEADの二重依頼を再作成しない",async()=>{mock.prior.mockResolvedValue({id:"existing",status:"QUEUED"});expect(await requestReviewFixJob(target)).toHaveProperty("id","existing");expect(mock.create).not.toHaveBeenCalled();});
 it("失敗の自動再送は再作成せず、別runの手動再試行だけを許す",async()=>{mock.prior.mockResolvedValue({id:"old",status:"FAILED",workflowRunId:"122"});expect(await requestReviewFixJob(target)).toHaveProperty("id","old");expect(mock.create).not.toHaveBeenCalled();await requestReviewFixJob({...target,manual:true});expect(mock.create).toHaveBeenCalledOnce();});
});
