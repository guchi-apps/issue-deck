// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RcImportPanel } from "@/components/dashboard/release-rc-import-panel";

const HEAD = "7".repeat(40);
const SHA_684 = "e".repeat(40);
const SHA_686 = "f".repeat(40);

function option(over: Record<string, unknown>) {
  return {
    number: 684, title: "証跡補充", issueNumber: null, url: "https://github.com/o/r/pull/684", mergeSha: SHA_684, merged: true,
    relatedFix: false, approved: false, approvalRequired: true, problem: null, problemLabel: null, ...over,
  };
}

function importOptions(over: Record<string, unknown> = {}) {
  return {
    candidateId: "cand1", headSha: HEAD, revision: 2, blocked: null,
    options: [option({}), option({ number: 686, title: "安全修正", mergeSha: SHA_686, url: "https://github.com/o/r/pull/686" })],
    ...over,
  };
}

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RC取り込みパネル（#4986）", () => {
  it("何も選ばない状態から始まり、選択を自動で広げない", async () => {
    fetchMock.mockImplementation(() => json(importOptions()));
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    await screen.findByRole("checkbox", { name: /#684/ });
    expect(screen.getByRole("button", { name: "選んだ0件を取り込む" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: /#686/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("範囲外のPRは承認にチェックするまで送れず、送るときは見ていたhead・マージSHA・承認PRだけを送る", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true, candidateId: "cand1", revision: 3, existing: false }) : json(importOptions()),
    );
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /#684/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /#686/ }));
    // 依存漏れ：#686だけ選んだ場合の警告は別テスト。ここは承認待ち
    expect(screen.getByRole("button", { name: "選んだ2件を取り込む" }).hasAttribute("disabled")).toBe(true);
    for (const box of screen.getAllByRole("checkbox", { name: /承認する/ })) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "選んだ2件を取り込む" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: "import", candidateId: "cand1", expectedHeadSha: HEAD,
      selected: [{ number: 684, expectedMergeSha: SHA_684 }, { number: 686, expectedMergeSha: SHA_686 }],
      approveExtra: [684, 686],
    });
    expect(await screen.findByText(/取り込みを依頼しました（revision 3）/)).toBeTruthy();
    // 完了後は重複送信できない
    expect(screen.getByRole("button", { name: "選んだ2件を取り込む" }).hasAttribute("disabled")).toBe(true);
  });

  it("関連修正は承認なしで送れる", async () => {
    fetchMock.mockImplementation(() => json(importOptions({ options: [option({ relatedFix: true, approvalRequired: false })] })));
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /#684/ }));
    expect(screen.getByRole("button", { name: "選んだ1件を取り込む" }).hasAttribute("disabled")).toBe(false);
  });

  it("後ろのPRだけ選ぶと、先に入った未選択PRを依存漏れの手がかりとして示す", async () => {
    fetchMock.mockImplementation(() => json(importOptions()));
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /#686/ }));
    expect(screen.getByTestId("release-rc-import-deps").textContent).toContain("#684");
  });

  it("未マージ・取り込み済みのPRは理由付きで選べず、head不一致はサーバーの拒否理由を表示する", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: false, error: "candidate_changed" }, 409)
        : json(importOptions({ options: [option({ number: 700, merged: false, mergeSha: null, problem: "not_merged", problemLabel: "developへ未マージです", approvalRequired: false, relatedFix: true }), option({ relatedFix: true, approvalRequired: false })] })),
    );
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    expect((await screen.findByRole("checkbox", { name: /#700/ })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("developへ未マージです")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /#684/ }));
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件を取り込む" }));
    expect(await screen.findByText(/候補ブランチが更新されています/)).toBeTruthy();
  });

  it("取り込めない段階では選択できない", async () => {
    fetchMock.mockImplementation(() => json(importOptions({ blocked: "取り込みの更新が進行中です。完了してから選んでください" })));
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    expect((await screen.findByRole("checkbox", { name: /#684/ })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/進行中です/)).toBeTruthy();
  });
});

describe("RC取り込みパネル：失敗後の再送（#4986）", () => {
  it("サーバーが失敗を返したあとは新しい要求キーで送り直す（失敗済みの要求を再送しない）", async () => {
    let posts = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(importOptions({ options: [option({ relatedFix: true, approvalRequired: false })] }));
      posts += 1;
      return posts === 1 ? json({ ok: false, error: "dispatch_failed" }, 502) : json({ ok: true, candidateId: "cand1", revision: 3, existing: false });
    });
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /#684/ }));
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件を取り込む" }));
    await screen.findByText(/workflowを起動できませんでした/);
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件を取り込む" }));
    await screen.findByText(/取り込みを依頼しました/);
    const keys = fetchMock.mock.calls.filter(([, i]) => i?.method === "POST").map(([, i]) => JSON.parse(i.body as string).requestKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("通信が途切れたときは同じ要求キーで再送する", async () => {
    let posts = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(importOptions({ options: [option({ relatedFix: true, approvalRequired: false })] }));
      posts += 1;
      return posts === 1 ? Promise.reject(new TypeError("Failed to fetch")) : json({ ok: true, candidateId: "cand1", revision: 3, existing: true });
    });
    render(<RcImportPanel repositoryFullName="o/r" pullRequestNumber={5} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /#684/ }));
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件を取り込む" }));
    await screen.findByText(/Failed to fetch/);
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件を取り込む" }));
    await screen.findByText(/取り込みを依頼しました/);
    const keys = fetchMock.mock.calls.filter(([, i]) => i?.method === "POST").map(([, i]) => JSON.parse(i.body as string).requestKey);
    expect(keys[0]).toBe(keys[1]);
  });
});
