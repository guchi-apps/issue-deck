// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeReviewPanel } from "@/components/dashboard/code-review-panel";
import {
  CODE_REVIEW_REPORT_MARKER,
  parseCodeReviewReport,
  type CodeReviewReport,
} from "@/lib/github/code-review";

const REPORT_BODY = `${CODE_REVIEW_REPORT_MARKER}
読んだコード: guchi-apps/issue-deck origin/develop 9b25283b・2026-08-22

重い指摘が1件あります。

### [重大] 未完了ジョブの判定が種別を見ていない

- 種別: correctness
- 場所: src/lib/dispatch/dispatch-job.ts:412

同じIssueに\`INSTRUCTION\`が残っていると起動が弾かれます。

### [軽微] 同じ絞り込みを2か所で組み立てている

- 場所: src/components/dashboard/issue-list.tsx:318

片方だけ直すとずれます。
`;

function report(): CodeReviewReport {
  const parsed = parseCodeReviewReport(REPORT_BODY);
  if (!parsed) throw new Error("テスト用のレビュー結果を読めませんでした");
  return parsed;
}

afterEach(cleanup);

describe("CodeReviewPanel（#698）", () => {
  it("結果もレビュー中でもなければ何も出さない", () => {
    const { container } = render(<CodeReviewPanel report={null} isPending={false} />);
    expect(container.firstChild).toBeNull();
  });

  // 押した直後は結果がまだ無い。ここで何も出ないと、依頼できたのかどうかが画面から分からない
  it("結果が返る前は「レビュー中」と出す", () => {
    render(<CodeReviewPanel report={null} isPending />);
    expect(screen.getByText("レビュー中")).toBeTruthy();
  });

  it("重要度ごとの件数・根拠・指摘を出す", () => {
    render(<CodeReviewPanel report={report()} isPending={false} />);

    expect(screen.getByText("重大 1")).toBeTruthy();
    expect(screen.getByText("軽微 1")).toBeTruthy();
    // 中は0件なので出さない（0のバッジが並ぶと、あるものと無いものが同じ強さで見える）
    expect(screen.queryByText("中 0")).toBeNull();

    // いつ時点の何を読んだのか（これが無いと手元と突き合わせられない）
    expect(
      screen.getByText(/origin\/develop 9b25283b・2026-08-22/),
    ).toBeTruthy();
    expect(screen.getByText("未完了ジョブの判定が種別を見ていない")).toBeTruthy();
    expect(screen.getByText("correctness")).toBeTruthy();
    expect(screen.getByText("src/lib/dispatch/dispatch-job.ts:412")).toBeTruthy();
  });

  // 押しても起票はしない。開くのは埋まった新規作成ダイアログで、立てるかは読んだ人が決める
  it("「Issueを作成」は指摘をそのまま渡す", () => {
    const onCreateFindingIssue = vi.fn();
    render(
      <CodeReviewPanel
        report={report()}
        isPending={false}
        onCreateFindingIssue={onCreateFindingIssue}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Issueを作成" })[0]);
    expect(onCreateFindingIssue).toHaveBeenCalledTimes(1);
    expect(onCreateFindingIssue.mock.calls[0][0].title).toBe(
      "未完了ジョブの判定が種別を見ていない",
    );
  });

  // レビューを回し直すと同じ指摘が返るので、これが無いと同じIssueが何件も立つ
  it("起票済みの指摘にはボタンを出さず、Issue番号を出す", () => {
    render(
      <CodeReviewPanel
        report={report()}
        isPending={false}
        createdFindingIssues={new Map([["未完了ジョブの判定が種別を見ていない", 2170]])}
        onCreateFindingIssue={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Issueを作成" })).toHaveLength(1);
    expect(screen.getByText(/#2170 として起票済み/)).toBeTruthy();
  });

  // 書式が崩れて指摘を拾えなかった場合でも、投稿された結果そのものは隠さない
  it("指摘が0件でも総評は出す", () => {
    const parsed = parseCodeReviewReport(
      `${CODE_REVIEW_REPORT_MARKER}\n\n指摘はありませんでした。`,
    );
    render(<CodeReviewPanel report={parsed} isPending={false} />);

    expect(screen.getByText("指摘なし")).toBeTruthy();
    expect(screen.getByText("指摘はありませんでした。")).toBeTruthy();
  });
});
