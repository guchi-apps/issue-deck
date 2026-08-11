import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueRepository = vi.fn();
const deleteIssueByGithubId = vi.fn();
const upsertIssueFromWebhookPayload = vi.fn();
const updateQaAnswerPendingState = vi.fn();
const updateManyIssue = vi.fn();
const findUniqueInstallation = vi.fn();
const findFirstInstallation = vi.fn();
const fetchProjectItem = vi.fn();
const findUniqueIssue = vi.fn();
const createComment = vi.fn();
const updateIssueApi = vi.fn();
const reportProgressStatus = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findUnique() {
        return findUniqueRepository;
      },
    },
    issue: {
      get updateMany() {
        return updateManyIssue;
      },
      get findUnique() {
        return findUniqueIssue;
      },
    },
    githubInstallation: {
      get findUnique() {
        return findUniqueInstallation;
      },
      get findFirst() {
        return findFirstInstallation;
      },
    },
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createComment() {
    return createComment;
  },
  get updateIssue() {
    return updateIssueApi;
  },
}));

vi.mock("@/lib/github/report-progress", () => ({
  get reportProgressStatus() {
    return reportProgressStatus;
  },
}));

vi.mock("@/lib/github/projects-api", () => ({
  get fetchProjectItem() {
    return fetchProjectItem;
  },
}));

vi.mock("@/lib/github/sync-issues", () => ({
  get deleteIssueByGithubId() {
    return deleteIssueByGithubId;
  },
  get upsertIssueFromWebhookPayload() {
    return upsertIssueFromWebhookPayload;
  },
  get updateQaAnswerPendingState() {
    return updateQaAnswerPendingState;
  },
  syncRepositoryIssues: vi.fn(),
}));

vi.mock("@/lib/github/app-auth", () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock("@/lib/github/workflow-support", () => ({
  fetchClaudeWorkflowExists: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/github/route";

const SECRET = "test-secret";

function makeRequest(body: unknown, event = "issues"): NextRequest {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
  return {
    text: async () => rawBody,
    headers: new Map([
      ["x-hub-signature-256", signature],
      ["x-github-event", event],
    ]),
  } as unknown as NextRequest;
}

describe("POST /api/webhooks/github issues.transferred", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset();
    deleteIssueByGithubId.mockReset().mockResolvedValue(undefined);
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
    updateQaAnswerPendingState.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("changes.new_repositoryが欠落している場合、移動元Issueの行を削除するフォールバックを行う", async () => {
    const response = await POST(
      makeRequest({
        action: "transferred",
        issue: { id: 123, number: 1 },
        repository: { id: 1 },
      }),
    );

    expect(response.status).toBe(200);
    expect(deleteIssueByGithubId).toHaveBeenCalledWith(123);
  });

  it("changes.new_repositoryがあり移動先が接続済みの場合は移動先へupsertする", async () => {
    findUniqueRepository.mockResolvedValue({ id: "repo-destination" });

    const response = await POST(
      makeRequest({
        action: "transferred",
        issue: { id: 123, number: 5 },
        repository: { id: 1 },
        changes: { new_repository: { id: 2 } },
      }),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith("repo-destination", {
      id: 123,
      number: 5,
    });
    expect(deleteIssueByGithubId).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github issue_comment", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset().mockResolvedValue({ id: "repo-1" });
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
    updateQaAnswerPendingState.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("action=createdの場合、comment.created_atをlastCommentAt更新用に渡し、コメント本文を渡してqaAnswerPendingAtを更新する", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "created",
          issue: { id: 123, number: 1 },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith(
      "repo-1",
      { id: 123, number: 1 },
      new Date("2026-08-08T00:00:00.000Z"),
    );
    expect(updateQaAnswerPendingState).toHaveBeenCalledWith(123, "@claude 質問: これは質問です");
  });

  it("action=editedの場合、コメント投稿日時は渡さずqaAnswerPendingAtも更新しない", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "edited",
          issue: { id: 123, number: 1 },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith(
      "repo-1",
      { id: 123, number: 1 },
      undefined,
    );
    expect(updateQaAnswerPendingState).not.toHaveBeenCalled();
  });

  it("PRへのコメント（issue.pull_requestあり）は無視する", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "created",
          issue: { id: 123, number: 1, pull_request: {} },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).not.toHaveBeenCalled();
    expect(updateQaAnswerPendingState).not.toHaveBeenCalled();
    expect(findUniqueRepository).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github projects_v2_item", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset();
    updateManyIssue.mockReset().mockResolvedValue({ count: 1 });
    findUniqueInstallation.mockReset();
    findFirstInstallation.mockReset();
    fetchProjectItem.mockReset();
    findUniqueIssue.mockReset().mockResolvedValue({ projectStatus: null, state: "OPEN", labels: [] });
    createComment.mockReset().mockResolvedValue({ id: 1 });
    updateIssueApi.mockReset().mockResolvedValue({});
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "issue-deck";
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
    vi.clearAllMocks();
  });

  function makeItemPayload(action: string, overrides: Record<string, unknown> = {}) {
    return {
      action,
      projects_v2_item: { node_id: "PVTI_item1" },
      installation: { id: 100 },
      organization: { login: "guchi-apps" },
      ...overrides,
    };
  }

  it("Statusの変更をIssueへ反映する", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 555,
      issueNumber: 42,
      status: "Implementation",
    });
    findUniqueRepository.mockResolvedValue({ id: "repo-1" });

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 42, projectStatus: null },
      data: { projectStatus: "Implementation", projectItemId: "PVTI_item1" },
    });
  });

  it("installationが無い場合はorganization.loginからインストールを引く", async () => {
    findFirstInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 555,
      issueNumber: 42,
      status: "Ready",
    });
    findUniqueRepository.mockResolvedValue({ id: "repo-1" });

    const payload = makeItemPayload("created");
    delete (payload as Record<string, unknown>).installation;
    const response = await POST(makeRequest(payload, "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(findFirstInstallation).toHaveBeenCalledWith({
      where: { accountLogin: "guchi-apps" },
    });
    expect(updateManyIssue).toHaveBeenCalled();
  });

  // --- カンバンのドラッグ起点の起動（#991 Phase 3） ---

  /** Ready から動かしたときの共通セットアップ。senderは人間 */
  function arrangeDrag(to: string, overrides: Record<string, unknown> = {}) {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 555,
      issueNumber: 42,
      status: to,
    });
    findUniqueRepository.mockResolvedValue({ id: "repo-1", ownerLogin: "guchi-apps", name: "issue-deck" });
    findUniqueIssue.mockResolvedValue({ projectStatus: "Ready", state: "OPEN", labels: [] });
    return makeItemPayload("edited", { sender: { login: "m-guchi" }, ...overrides });
  }

  it("Ready→Implementation を人が動かすと実装開始のコメントを投稿する", async () => {
    const response = await POST(makeRequest(arrangeDrag("Implementation"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(createComment).toHaveBeenCalledTimes(1);
    const [owner, repo, number, , options] = createComment.mock.calls[0];
    expect([owner, repo, number]).toEqual(["guchi-apps", "issue-deck", 42]);
    expect(options.body).toContain("@claude 実装を開始してください");
    // ワークフローが実行者の権限を確認できるよう、操作した人間を末尾のマーカーで伝える
    expect(options.body.endsWith("<!-- issue-deck:posted-by:m-guchi -->")).toBe(true);
  });

  it("Ready→Planning なら計画立案のコメントを投稿する", async () => {
    await POST(makeRequest(arrangeDrag("Planning"), "projects_v2_item"));

    expect(createComment.mock.calls[0][4].body).toContain("@claude 計画を立案してください");
  });

  it("Planningへの移動では、コメントより先に21.plan-requiredを付ける", async () => {
    // ワークフローのmodeはコメント本文ではなくこのラベルで決まるため、順序が逆だと実装が始まる
    await POST(makeRequest(arrangeDrag("Planning"), "projects_v2_item"));

    expect(updateIssueApi).toHaveBeenCalledWith("guchi-apps", "issue-deck", 42, undefined, {
      labels: ["21.plan-required"],
    });
    expect(updateIssueApi.mock.invocationCallOrder[0]).toBeLessThan(
      createComment.mock.invocationCallOrder[0],
    );
  });

  it("21.plan-requiredが既に付いていればラベルは触らない", async () => {
    const payload = arrangeDrag("Planning");
    findUniqueIssue.mockResolvedValue({
      projectStatus: "Ready",
      state: "OPEN",
      labels: [{ name: "21.plan-required" }],
    });

    await POST(makeRequest(payload, "projects_v2_item"));

    expect(updateIssueApi).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalled();
  });

  it("Implementationへの移動では21.plan-requiredを付けない", async () => {
    await POST(makeRequest(arrangeDrag("Implementation"), "projects_v2_item"));

    expect(updateIssueApi).not.toHaveBeenCalled();
  });

  it("Planning→Implementation は、承認待ちなら計画を承認して実装を始める", async () => {
    const payload = arrangeDrag("Implementation");
    findUniqueIssue.mockResolvedValue({
      projectStatus: "Planning",
      state: "OPEN",
      labels: [{ name: "01.planning" }, { name: "00.check-user" }, { name: "21.plan-required" }],
    });

    await POST(makeRequest(payload, "projects_v2_item"));

    // 承認はラベルを外すことで表現される。00.check-user・21.plan-requiredが残っていると
    // ワークフローは計画のやり直しとして動いてしまう
    expect(updateIssueApi).toHaveBeenCalledWith("guchi-apps", "issue-deck", 42, undefined, {
      labels: ["01.planning"],
    });
    expect(createComment.mock.calls[0][4].body).toContain("@claude 計画を承認しました。");
    // ラベルを外してからコメントを投稿する
    expect(updateIssueApi.mock.invocationCallOrder[0]).toBeLessThan(
      createComment.mock.invocationCallOrder[0],
    );
  });

  it("Planning→Implementation でも承認待ちでなければ何もしない", async () => {
    const payload = arrangeDrag("Implementation");
    findUniqueIssue.mockResolvedValue({
      projectStatus: "Planning",
      state: "OPEN",
      labels: [{ name: "01.planning" }],
    });

    await POST(makeRequest(payload, "projects_v2_item"));

    expect(createComment).not.toHaveBeenCalled();
    expect(updateIssueApi).not.toHaveBeenCalled();
  });

  it("11.local が付いていれば起動しない（ローカルセッションで対応中）", async () => {
    const payload = arrangeDrag("Implementation");
    findUniqueIssue.mockResolvedValue({
      projectStatus: "Ready",
      state: "OPEN",
      labels: [{ name: "11.local" }],
    });

    await POST(makeRequest(payload, "projects_v2_item"));

    expect(createComment).not.toHaveBeenCalled();
  });

  it("issue-deck自身のGitHub Appによる変更では起動しない（報告APIの自己ループ防止）", async () => {
    const payload = arrangeDrag("Implementation", { sender: { login: "issue-deck[bot]" } });

    const response = await POST(makeRequest(payload, "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(createComment).not.toHaveBeenCalled();
    // Statusの取り込み自体は行う
    expect(updateManyIssue).toHaveBeenCalled();
  });

  it("Ready以外からの遷移では起動しない", async () => {
    const payload = arrangeDrag("Implementation");
    findUniqueIssue.mockResolvedValue({ projectStatus: "Develop", state: "OPEN", labels: [] });

    await POST(makeRequest(payload, "projects_v2_item"));

    expect(createComment).not.toHaveBeenCalled();
  });

  it("closedなIssueでは起動しない", async () => {
    const payload = arrangeDrag("Implementation");
    findUniqueIssue.mockResolvedValue({ projectStatus: "Ready", state: "CLOSED", labels: [] });

    await POST(makeRequest(payload, "projects_v2_item"));

    expect(createComment).not.toHaveBeenCalled();
  });

  it("Webhookが再配信されても二重投稿しない（比較更新が0件なら以降を行わない）", async () => {
    const payload = arrangeDrag("Implementation");
    // 先行する配信が既にStatusを進めており、遷移前Statusでの更新が1件も当たらない状態
    updateManyIssue.mockResolvedValue({ count: 0 });

    const response = await POST(makeRequest(payload, "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("コメント投稿に失敗してもWebhookは成功で返す（Statusの取り込みは済んでいるため）", async () => {
    const payload = arrangeDrag("Implementation");
    createComment.mockRejectedValue(new Error("boom"));

    const response = await POST(makeRequest(payload, "projects_v2_item"));

    expect(response.status).toBe(200);
  });

  it("Projectから外れたらStatusを消してラベル起点の判定へ戻す", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });

    const response = await POST(makeRequest(makeItemPayload("deleted"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { projectItemId: "PVTI_item1" },
      data: { projectStatus: null, projectItemId: null },
    });
    // Projectから外れているのでGitHubへ問い合わせる必要はない
    expect(fetchProjectItem).not.toHaveBeenCalled();
  });

  it("archivedもStatusを消す対象にする", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });

    await POST(makeRequest(makeItemPayload("archived"), "projects_v2_item"));

    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { projectItemId: "PVTI_item1" },
      data: { projectStatus: null, projectItemId: null },
    });
  });

  it("Issue以外（PR等）のアイテムは何もしない", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).not.toHaveBeenCalled();
  });

  it("未接続のリポジトリのIssueは無視する", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 999,
      issueNumber: 1,
      status: "Done",
    });
    findUniqueRepository.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).not.toHaveBeenCalled();
  });

  it("インストールが見つからない場合は何もしない", async () => {
    findUniqueInstallation.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(fetchProjectItem).not.toHaveBeenCalled();
    expect(updateManyIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github issues.labeled（手動ラベルのStatus反映）", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset().mockResolvedValue({
      id: "repo-1",
      fullName: "guchi-apps/issue-deck",
    });
    findUniqueIssue.mockReset().mockResolvedValue({ projectStatus: "Ready" });
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
    reportProgressStatus.mockReset().mockResolvedValue({ applied: true });
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  function labeledPayload(action: string, labelNames: string[]) {
    return {
      action,
      issue: { id: 1, number: 42, labels: labelNames.map((name) => ({ name })) },
      repository: { id: 555 },
    };
  }

  it("手で進捗ラベルを付けるとStatusを報告する", async () => {
    const response = await POST(makeRequest(labeledPayload("labeled", ["02.wip"]), "issues"));

    expect(response.status).toBe(200);
    expect(reportProgressStatus).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 42,
      status: "implementation",
    });
  });

  it("ラベルが文字列で来るペイロードでも扱える", async () => {
    const payload = {
      action: "labeled",
      issue: { id: 1, number: 42, labels: ["02.wip"] },
      repository: { id: 555 },
    };

    await POST(makeRequest(payload, "issues"));

    expect(reportProgressStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "implementation" }),
    );
  });

  it("既にStatusが一致していれば報告しない（GraphQLの無駄打ちを避ける）", async () => {
    findUniqueIssue.mockResolvedValue({ projectStatus: "Implementation" });

    await POST(makeRequest(labeledPayload("labeled", ["02.wip"]), "issues"));

    expect(reportProgressStatus).not.toHaveBeenCalled();
  });

  it("進捗ラベルが無くなってもReadyへは巻き戻さない", async () => {
    // 人がカンバンでドラッグした結果（Phase 3の起動トリガー）を潰さないため
    findUniqueIssue.mockResolvedValue({ projectStatus: "Implementation" });

    await POST(makeRequest(labeledPayload("unlabeled", ["30.bug"]), "issues"));

    expect(reportProgressStatus).not.toHaveBeenCalled();
  });

  it("ラベル以外のactionでは報告しない", async () => {
    await POST(makeRequest(labeledPayload("edited", ["02.wip"]), "issues"));

    expect(reportProgressStatus).not.toHaveBeenCalled();
    // Issueの取り込み自体は従来どおり行う
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalled();
  });

  it("報告が失敗してもWebhookは成功で返す（取り込みは済んでいるため）", async () => {
    reportProgressStatus.mockRejectedValue(new Error("boom"));

    const response = await POST(makeRequest(labeledPayload("labeled", ["02.wip"]), "issues"));

    expect(response.status).toBe(200);
  });
});
