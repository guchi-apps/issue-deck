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
