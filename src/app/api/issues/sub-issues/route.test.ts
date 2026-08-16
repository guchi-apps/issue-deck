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

  /** `where.OR`（リポジトリごとの絞り込み）に一致する行だけを返す、DBの代役 */
  function respondWithRows(rows: { fullName: string; number: number; projectStatus: string }[]) {
    issueFindMany.mockImplementation(async ({ where }) => {
      const groups: { repository: { fullName: string }; number: { in: number[] } }[] = where.OR;
      return rows
        .filter((row) =>
          groups.some(
            (group) =>
              group.repository.fullName === row.fullName && group.number.in.includes(row.number),
          ),
        )
        .map((row) => ({
          number: row.number,
          projectStatus: row.projectStatus,
          repository: { fullName: row.fullName },
        }));
    });
  }

  it("子のprojectStatusをDBキャッシュから合流させ、DBに無い子はnullのままにする", async () => {
    fetchSubIssueRelations.mockResolvedValue({
      parent: {
        number: 1200,
        title: "親",
        state: "closed",
        htmlUrl: "https://example.com/1200",
        repositoryFullName: "guchi-apps/issue-deck",
      },
      children: [
        {
          number: 1177,
          title: "子A",
          state: "closed",
          htmlUrl: "https://example.com/1177",
          repositoryFullName: "guchi-apps/issue-deck",
        },
        {
          number: 1190,
          title: "子B",
          state: "open",
          htmlUrl: "https://example.com/1190",
          repositoryFullName: "guchi-apps/issue-deck",
        },
      ],
      childCount: 2,
    });
    // #1190だけDBにあり、#1177と親はキャッシュに無い状況を作る
    respondWithRows([
      { fullName: "guchi-apps/issue-deck", number: 1190, projectStatus: "Implementation" },
    ]);

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.relations.parent).toEqual({
      number: 1200,
      title: "親",
      state: "closed",
      htmlUrl: "https://example.com/1200",
      repositoryFullName: "guchi-apps/issue-deck",
      projectStatus: null,
    });
    expect(body.relations.children).toEqual([
      {
        number: 1177,
        title: "子A",
        state: "closed",
        htmlUrl: "https://example.com/1177",
        repositoryFullName: "guchi-apps/issue-deck",
        projectStatus: null,
      },
      {
        number: 1190,
        title: "子B",
        state: "open",
        htmlUrl: "https://example.com/1190",
        repositoryFullName: "guchi-apps/issue-deck",
        projectStatus: "Implementation",
      },
    ]);
    expect(body.relations.childCount).toBe(2);
  });

  it("別リポジトリの子に、番号が一致する親リポジトリ側のIssueの進捗を付けない（#1722）", async () => {
    fetchSubIssueRelations.mockResolvedValue({
      parent: null,
      children: [
        {
          number: 1190,
          title: "横展開（car-care）",
          state: "open",
          htmlUrl: "https://github.com/guchi-apps/car-care/issues/1190",
          repositoryFullName: "guchi-apps/car-care",
        },
      ],
      childCount: 1,
    });
    // 親リポジトリ側にたまたま同じ番号のIssueがあり、そちらは実装中まで進んでいる状況
    respondWithRows([
      { fullName: "guchi-apps/issue-deck", number: 1190, projectStatus: "Implementation" },
    ]);

    const res = await GET(request());
    const body = await res.json();

    expect(body.relations.children[0].projectStatus).toBeNull();
    // 引くのは子が実際に置かれているリポジトリの側
    expect(issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ repository: { fullName: "guchi-apps/car-care" }, number: { in: [1190] } }],
        }),
      }),
    );
  });

  it("別リポジトリの子の進捗は、そのリポジトリのDBキャッシュから引く（#1722）", async () => {
    fetchSubIssueRelations.mockResolvedValue({
      parent: null,
      children: [
        {
          number: 1190,
          title: "横展開（car-care）",
          state: "open",
          htmlUrl: "https://github.com/guchi-apps/car-care/issues/1190",
          repositoryFullName: "guchi-apps/car-care",
        },
        {
          number: 1190,
          title: "同番号の自リポジトリの子",
          state: "open",
          htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1190",
          repositoryFullName: "guchi-apps/issue-deck",
        },
      ],
      childCount: 2,
    });
    respondWithRows([
      { fullName: "guchi-apps/car-care", number: 1190, projectStatus: "Develop PR" },
      { fullName: "guchi-apps/issue-deck", number: 1190, projectStatus: "Implementation" },
    ]);

    const res = await GET(request());
    const body = await res.json();

    expect(body.relations.children.map((child: { projectStatus: string | null }) => child.projectStatus)).toEqual([
      "Develop PR",
      "Implementation",
    ]);
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
