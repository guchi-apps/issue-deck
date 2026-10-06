import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
const mocks=vi.hoisted(()=>({progress:vi.fn(),dispatch:vi.fn(),request:vi.fn(),validate:vi.fn(),job:vi.fn()}));
vi.mock("@/lib/progress-report-auth",()=>({authorizeProgressReport:mocks.progress}));
vi.mock("@/lib/dispatch/dispatch-auth",()=>({authorizeDispatch:mocks.dispatch}));
vi.mock("@/lib/dispatch/review-fix-jobs",()=>({requestReviewFixJob:mocks.request,validateReviewFixTarget:mocks.validate}));
vi.mock("@/lib/db",()=>({db:{dispatchJob:{findUnique:mocks.job}}}));
import { POST } from "./route";
const body={action:"request",repository:"o/r",issueNumber:1,pullRequest:2,headSha:"a".repeat(40),manual:false,runId:"123"};
const post=(p:unknown)=>POST(new Request("http://localhost/api/dispatch/review-fix",{method:"POST",body:JSON.stringify(p)}) as NextRequest);
beforeEach(()=>{vi.clearAllMocks();mocks.progress.mockReturnValue("ok");mocks.dispatch.mockReturnValue("ok");mocks.request.mockResolvedValue({id:"job",status:"QUEUED"});mocks.validate.mockResolvedValue("review");});
describe("レビュー修正API",()=>{
 it("Actionsは進捗認証で依頼する",async()=>{expect((await post(body)).status).toBe(200);expect(mocks.progress).toHaveBeenCalled();expect(mocks.dispatch).not.toHaveBeenCalled();});
 it("認証失敗・不正入力を拒否する",async()=>{mocks.progress.mockReturnValue("unauthorized");expect((await post(body)).status).toBe(401);mocks.progress.mockReturnValue("ok");expect((await post({...body,issueNumber:-1})).status).toBe(400);});
 it("サブPCの再検証はDBのclaim済みjob対象を使う",async()=>{mocks.job.mockResolvedValue({kind:"REVIEW_FIX",status:"RUNNING",claimedByHost:"subpc",repositoryFullName:"o/r",issueNumber:1,prNumber:2,headSha:body.headSha,instruction:"automatic"});expect((await post({action:"validate",jobId:"job",host:"subpc",repository:"evil/repo",manual:true})).status).toBe(200);expect(mocks.validate).toHaveBeenCalledWith(expect.objectContaining({repository:"o/r",manual:false}));expect(mocks.dispatch).toHaveBeenCalled();});
 it("別ホスト・終端jobは書込み前の再検証を許可しない",async()=>{mocks.job.mockResolvedValue({kind:"REVIEW_FIX",status:"SUCCEEDED",claimedByHost:"subpc"});expect((await post({action:"validate",jobId:"job",host:"other"})).status).toBe(409);expect(mocks.validate).not.toHaveBeenCalled();});
 it("担当不明・サブPC不在は明示失敗",async()=>{mocks.request.mockRejectedValue(new Error("サブPC不在"));const result=await post(body);expect(result.status).toBe(409);expect(await result.json()).toEqual({error:"サブPC不在"});});
});
