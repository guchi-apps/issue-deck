import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const issueFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchSubIssueRelations = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/sub-issues-api", () => ({
  get fetchSubIssueRelations() {
    return fetchSubIssueRelations;
  },
}));

import { GET } from "@/app/api/issues/sub-issues/route";

const REPOSITORY = {
  id: "repo-1",
  fullName: "guchi-apps/issue-deck",
  installation: { installationId: 111 },
};

function request(query = "owner=guchi-apps&repo=issue-deck&number=1176") {
  return new Request(`http://localhost/api/issues/sub-issues?${query}`) as never;
}

describe("GET /api/issues/sub-issues", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue(REPOSITORY);
    issueFindMany.mockReset().mockResolvedValue([]);
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchSubIssueRelations.mockReset().mockResolvedValue({
      parent: null,
      children: [],
      childCount: 0,
    });
  });

  it("未ログインなら401を返す", async () => {
    requireUserId.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it("Issue番号が数値でなければ400を返す", async () => {
    const res = await GET(request("owner=guchi-apps&repo=issue-deck&number=abc"));
    expect(res.status).toBe(400);
    expect(fetchSubIssueRelations).not.toHaveBeenCalled();
  });

  it("ユーザーが参照できないリポジトリなら404を返す", async () => {
    findFirst.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(404);
  });

  it("子のprojectStatusをDBキャッシュから合流させ、DBに無い子はnullのままにする", async () => {
    fetchSubIssueRelations.mockResolvedValue({
      parent: {
        number: 1200,
        title: "親",
        state: "closed",
        htmlUrl: "https://example.com/1200",
      },
      children: [
        { number: 1177, title: "子A", state: "closed", htmlUrl: "https://example.com/1177" },
        { number: 1190, title: "子B", state: "open", htmlUrl: "https://example.com/1190" },
      ],
      childCount: 2,
    });
    // #1190だけDBにあり、#1177と親はキャッシュに無い状況を作る
    issueFindMany.mockImplementation(async ({ where }) => {
      const numbers: number[] = where.number.in;
      return numbers.includes(1190) ? [{ number: 1190, projectStatus: "Implementation" }] : [];
    });

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.relations.parent).toEqual({
      number: 1200,
      title: "親",
      state: "closed",
      htmlUrl: "https://example.com/1200",
      projectStatus: null,
    });
    expect(body.relations.children).toEqual([
      {
        number: 1177,
        title: "子A",
        state: "closed",
        htmlUrl: "https://example.com/1177",
        projectStatus: null,
      },
      {
        number: 1190,
        title: "子B",
        state: "open",
        htmlUrl: "https://example.com/1190",
        projectStatus: "Implementation",
      },
    ]);
    expect(body.relations.childCount).toBe(2);
  });

  it("GitHub API が失敗しても200で「関係なし」を返す（詳細画面の他の情報を巻き込まない）", async () => {
    fetchSubIssueRelations.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relations).toEqual({ parent: null, children: [], childCount: 0 });
  });
});
