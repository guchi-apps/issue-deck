// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FindingDecisionControl } from "./release-review-decision";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
const finding: ReleaseReviewFinding = { id: "R-1", title: "入力消失", severity: "high", detail: "", file: "queue.ts", line: 1, impact: "後続編集が消える", evidence: "同じIDで削除", blockingReason: "利用者データの消失", recommendation: "送信を固定", pullRequests: [] };
const props = { repositoryFullName: "guchi-apps/yoteiflow", pullRequestNumber: 1246, target: { baseSha: "base", headSha: "head" }, findingId: "R-1", finding, view: undefined };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("根拠を確認して手入力なしで保存し、対象SHAと競合確認を送る", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal("fetch", fetcher);
  render(<FindingDecisionControl {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "判断を保存" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ decision: "fix_now", baseSha: "base", headSha: "head", expectedDecisionId: null, reason: expect.stringContaining("同じIDで削除") });
});
it("別の選択に修正理由を流用せず、選択ごとの入力を保持する", () => {
  render(<FindingDecisionControl {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  fireEvent.click(screen.getByRole("radio", { name: /指摘を採用しない/ }));
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: /判断の理由/ }), { target: { value: "対象外と確認した" } });
  fireEvent.click(screen.getByRole("radio", { name: /今回直す/ }));
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toContain("公開前に対応");
  fireEvent.click(screen.getByRole("radio", { name: /指摘を採用しない/ }));
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toBe("対象外と確認した");
});
it.each([409, 403, 500])("保存失敗%sでも入力が残る", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }));
  render(<FindingDecisionControl {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  fireEvent.click(screen.getByRole("button", { name: "判断を保存" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toContain("後続編集が消える");
});
it("通信失敗でも入力が残る", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<FindingDecisionControl {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  fireEvent.click(screen.getByRole("button", { name: "判断を保存" }));
  expect((await screen.findByRole("alert")).textContent).toContain("通信");
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toContain("後続編集");
});
it("改善提案は判断任意と表示する", () => {
  render(<FindingDecisionControl {...props} blocking={false} />);
  expect(screen.getByText(/対応は任意/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "対応を記録する（任意）" }));
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).toBe("");
});
it("対象SHA変更時は前の入力を新しい対象へ持ち越さない", () => {
  const { rerender } = render(<FindingDecisionControl {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  fireEvent.change(screen.getByRole("textbox", { name: /判断の理由/ }), { target: { value: "前の対象の理由" } });
  rerender(<FindingDecisionControl {...props} target={{ baseSha: "base", headSha: "new-head" }} />);
  expect((screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value).not.toBe("前の対象の理由");
});

// #4676 AIの推奨
const d = (reason: string, extra: Record<string, string | null> = {}) => ({ reason, impact: null, scope: null, timing: null, followUpTitle: null, ...extra });
const rec = {
  id: "rec1",
  findingId: "R-1",
  baseSha: "base",
  headSha: "head",
  recommended: "fix_now" as const,
  rationale: "通常の操作でデータが消え、公開後には戻せない",
  drafts: {
    fix_now: d("利用者の入力が消えるため公開前に直す"),
    post_release: d("公開後に直す", { timing: "本番公開の直後", followUpTitle: "再編集の消失を直す" }),
    defer: d("今回は見送る", { impact: "まれに編集が消える", scope: "同期送信中の再編集" }),
    reject: d("誤認のため採用しない"),
  },
  missing: ["利用者の数は確認していません"],
  createdAt: "2026-10-17T00:00:00.000Z",
};
const recProps = { ...props, recommendation: rec };

it("未判断の指摘に推奨・理由・不足点を出し、表示しただけでは保存しない", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<FindingDecisionControl {...recProps} />);
  const card = screen.getByTestId("finding-recommendation");
  expect(card.textContent).toContain("AIの推奨（未確定）");
  expect(card.textContent).toContain("利用者の入力が消えるため公開前に直す");
  expect(screen.getByTestId("recommendation-missing").textContent).toContain("利用者の数");
  expect(fetcher).not.toHaveBeenCalled();
});

it("推奨どおりならワンタップで推奨の判断・理由・推奨IDを送る", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn();
  render(<FindingDecisionControl {...recProps} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "推奨どおり「今回直す」で確定" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    decision: "fix_now",
    reason: "利用者の入力が消えるため公開前に直す",
    recommendationId: "rec1",
    expectedDecisionId: null,
    baseSha: "base",
    headSha: "head",
  });
});

it("公開後対応の推奨は、新しいIssueを作ることを明示して確定する", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal("fetch", fetcher);
  render(<FindingDecisionControl {...props} recommendation={{ ...rec, recommended: "post_release" }} />);
  expect(screen.getByTestId("finding-recommendation").textContent).toContain("期日は未定");
  fireEvent.click(screen.getByRole("button", { name: "推奨どおり「公開後に対応する」で確定（Issueを作成）" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ followUp: { kind: "create", title: "再編集の消失を直す" }, timing: "本番公開の直後" });
});

it("必須項目が揃わない推奨はワンタップを出さず、不足を示す", () => {
  render(<FindingDecisionControl {...props} recommendation={{ ...rec, recommended: "post_release", drafts: { ...rec.drafts, post_release: d("後で") } }} />);
  expect(screen.queryByRole("button", { name: /推奨どおり/ })).toBeNull();
  expect(screen.getByTestId("finding-recommendation").textContent).toContain("追跡するIssueをAIが用意できませんでした");
});

it("別の判断を選ぶと、その判断用の理由案が入り、選び直しただけでは保存しない", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<FindingDecisionControl {...recProps} />);
  fireEvent.click(screen.getByRole("button", { name: "別の判断を選ぶ" }));
  const reason = () => (screen.getByRole("textbox", { name: /判断の理由/ }) as HTMLTextAreaElement).value;
  expect(reason()).toBe("利用者の入力が消えるため公開前に直す");
  fireEvent.click(screen.getByRole("radio", { name: /今回は見送る/ }));
  expect(reason()).toBe("今回は見送る");
  expect((screen.getByRole("textbox", { name: /残る影響/ }) as HTMLTextAreaElement).value).toBe("まれに編集が消える");
  fireEvent.change(screen.getByRole("textbox", { name: /判断の理由/ }), { target: { value: "今回は見送る。補足" } });
  expect(screen.getByTestId("reason-origin").textContent).toBe("AIの理由案を編集中");
  fireEvent.click(screen.getByRole("radio", { name: /指摘を採用しない/ }));
  expect(reason()).toBe("誤認のため採用しない");
  fireEvent.click(screen.getByRole("radio", { name: /今回は見送る/ }));
  expect(reason()).toBe("今回は見送る。補足");
  fireEvent.click(screen.getByRole("button", { name: "AIの理由案に戻す" }));
  expect(reason()).toBe("今回は見送る");
  expect(fetcher).not.toHaveBeenCalled();
});

it("ワンタップの保存が競合しても推奨は残り、理由を示す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: "ほかの操作でこの指摘の判断が更新されました。" }) }));
  render(<FindingDecisionControl {...recProps} />);
  fireEvent.click(screen.getByRole("button", { name: "推奨どおり「今回直す」で確定" }));
  expect((await screen.findByRole("alert")).textContent).toContain("ほかの操作");
  expect(screen.getByTestId("finding-recommendation")).toBeTruthy();
});

it("推奨の取得に失敗しても手動で判断でき、再取得を押せる", () => {
  const retry = vi.fn();
  render(<FindingDecisionControl {...props} recommendationFailure="時間切れ" onRetryRecommendation={retry} />);
  expect(screen.getByTestId("recommendation-failure").textContent).toContain("手動で保存できます");
  fireEvent.click(screen.getByRole("button", { name: "推奨を再取得" }));
  expect(retry).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "対応案を確認して判断" }));
  expect(screen.getByTestId("finding-decision-form")).toBeTruthy();
});

it("別の対象（head）の推奨は出さない", () => {
  render(<FindingDecisionControl {...recProps} target={{ baseSha: "base", headSha: "new-head" }} />);
  expect(screen.queryByTestId("finding-recommendation")).toBeNull();
});

it("確定済みの判断には推奨を出さず、AIの推奨との関係を表示する", () => {
  const record = {
    id: "d1", findingId: "R-1", sequence: 1, decision: "defer" as const, reason: "見送る理由", impact: "影響", scope: "範囲", followUp: null, timing: null,
    prNumber: 6, headRef: "release-rc/6", baseSha: "base", headSha: "head", severity: "high" as const, blocking: true, findingTitle: "入力消失",
    decidedBy: "guchi", decidedAt: "2026-10-17T05:02:00.000Z", recommendation: { decision: "fix_now" as const, reason: "直すべき" }, reasonSource: "manual" as const,
  };
  render(<FindingDecisionControl {...recProps} view={{ findingId: "R-1", current: record, stale: null, history: [record] }} />);
  expect(screen.queryByTestId("finding-recommendation")).toBeNull();
  expect(screen.getByTestId("decision-adoption").textContent).toBe("AI推奨と異なる判断");
  expect(screen.getByText(/判断時のAI推奨: 今回直す/)).toBeTruthy();
});
