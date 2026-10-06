import { beforeEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({repairs:vi.fn(),jobs:vi.fn()}));
vi.mock("@/lib/db",()=>({db:{pullRequestRepairRun:{findMany:mock.repairs},dispatchJob:{findMany:mock.jobs}}}));
import { fetchActivePullRequestRepairRuns } from "./pull-request-repair-run";
beforeEach(()=>{mock.repairs.mockResolvedValue([]);mock.jobs.mockResolvedValue([]);});
it("Actions完了後もqueued/running jobを修正中として表示する",async()=>{mock.jobs.mockResolvedValue([{repositoryFullName:"o/r",prNumber:2,createdAt:new Date()}]);expect((await fetchActivePullRequestRepairRuns([{repositoryFullName:"o/r",pullRequestNumber:2}])).get("o/r#2")?.kind).toBe("review");});
it("jobの終端後は修正中を残さない",async()=>{expect((await fetchActivePullRequestRepairRuns([{repositoryFullName:"o/r",pullRequestNumber:2}])).size).toBe(0);expect(mock.jobs).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({status:{in:["QUEUED","CLAIMED","RUNNING"]}})}));});
