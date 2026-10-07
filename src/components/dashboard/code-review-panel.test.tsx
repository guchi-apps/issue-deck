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
    const { container } = render(<CodeReviewPanel report={null} runStatus="reported" />);
    expect(container.firstChild).toBeNull();
  });

  // 押した直後は結果がまだ無い。ここで何も出ないと、依頼できたのかどうかが画面から分からない
  it("結果が返る前は「レビュー中」と出す", () => {
    render(<CodeReviewPanel report={null} runStatus="running" />);
    expect(screen.getByText("レビュー中")).toBeTruthy();
  });

  it("重要度ごとの件数・根拠・指摘を出す", () => {
    render(<CodeReviewPanel report={report()} runStatus="reported" />);

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
        runStatus="reported"
        onCreateFindingIssue={onCreateFindingIssue}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Issueを作成" })[0]);
    expect(onCreateFindingIssue).toHaveBeenCalledTimes(1);
    expect(onCreateFindingIssue.mock.calls[0][0].title).toBe(
      "未完了ジョブの判定が種別を見ていない",
    );
  });

  // 未起票の指摘だけをまとめて渡す。件数表示も未起票分だけを数える
  it("「まとめてIssueを作成」は未起票の指摘だけを渡す", () => {
    const onBulkCreateFindingIssues = vi.fn();
    render(
      <CodeReviewPanel
        report={report()}
        runStatus="reported"
        createdFindingIssues={new Map([["未完了ジョブの判定が種別を見ていない", 2170]])}
        onBulkCreateFindingIssues={onBulkCreateFindingIssues}
      />,
    );

    const button = screen.getByRole("button", { name: "まとめてIssueを作成 (1件)" });
    fireEvent.click(button);
    expect(onBulkCreateFindingIssues).toHaveBeenCalledTimes(1);
    const passed = onBulkCreateFindingIssues.mock.calls[0][0];
    expect(passed).toHaveLength(1);
    expect(passed[0].title).toBe("同じ絞り込みを2か所で組み立てている");
  });

  // 未起票の指摘が1件も無ければ、選ぶものが無いのでボタンごと出さない
  it("未起票の指摘が無ければ「まとめてIssueを作成」を出さない", () => {
    render(
      <CodeReviewPanel
        report={report()}
        runStatus="reported"
        createdFindingIssues={
          new Map([
            ["未完了ジョブの判定が種別を見ていない", 2170],
            ["同じ絞り込みを2か所で組み立てている", 2171],
          ])
        }
        onBulkCreateFindingIssues={vi.fn()}
      />,
    );

    expect(screen.queryByText(/まとめてIssueを作成/)).toBeNull();
  });

  // レビューを回し直すと同じ指摘が返るので、これが無いと同じIssueが何件も立つ
  it("起票済みの指摘にはボタンを出さず、Issue番号を出す", () => {
    render(
      <CodeReviewPanel
        report={report()}
        runStatus="reported"
        createdFindingIssues={new Map([["未完了ジョブの判定が種別を見ていない", 2170]])}
        onCreateFindingIssue={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Issueを作成" })).toHaveLength(1);
    expect(screen.getByText(/#2170 として起票済み/)).toBeTruthy();
  });

  // 直したあとに効いたかを見たくなるのは結果を読んだ直後。ここに無いとビューまで戻ることになる
  it("結果が出てからは「もう一度レビュー」を出す（レビュー中は出さない）", () => {
    const onRestartReview = vi.fn();
    const { rerender } = render(
      <CodeReviewPanel report={null} runStatus="running" onRestartReview={onRestartReview} />,
    );
    expect(screen.queryByRole("button", { name: "もう一度レビュー" })).toBeNull();

    rerender(
      <CodeReviewPanel report={report()} runStatus="reported" onRestartReview={onRestartReview} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "もう一度レビュー" }));
    expect(onRestartReview).toHaveBeenCalledTimes(1);
  });

  // 書式が崩れて指摘を拾えなかった場合でも、投稿された結果そのものは隠さない
  it("指摘が0件でも総評は出す", () => {
    const parsed = parseCodeReviewReport(
      `${CODE_REVIEW_REPORT_MARKER}\n\n指摘はありませんでした。`,
    );
    render(<CodeReviewPanel report={parsed} runStatus="reported" />);

    expect(screen.getByText("指摘なし")).toBeTruthy();
    expect(screen.getByText("指摘はありませんでした。")).toBeTruthy();
  });

  // #4116。結果が届かなかった実行は「レビュー中」に残さず、理由・時刻と再実行を出す
  it("失敗した実行は理由と再実行を出し、「レビュー中」を出さない", () => {
    const onRerun = vi.fn();
    render(
      <CodeReviewPanel
        report={null}
        runStatus="failed"
        job={{
          id: "job-1",
          status: "FAILED",
          message: "Claude CLIが異常終了しました（終了コード 1）",
          targetHost: "subpc",
          createdAt: "2026-10-06T22:09:00.000Z",
          startedAt: "2026-10-06T22:10:00.000Z",
          heartbeatAt: null,
          finishedAt: "2026-10-06T22:12:00.000Z",
        }}
        onRerun={onRerun}
      />,
    );

    expect(screen.queryByText("レビュー中")).toBeNull();
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(screen.getByText(/終了コード 1/)).toBeTruthy();
    expect(screen.getByText(/開始/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再実行" }));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  // 実行中・順番待ちは再実行を出さない（二重起動を避ける）
  it("実行中は再実行を出さない", () => {
    render(<CodeReviewPanel report={null} runStatus="running" onRerun={vi.fn()} />);
    expect(screen.getByText("レビュー中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "再実行" })).toBeNull();
  });

  // 再実行が失敗しても前回の結果（指摘カード・起票済みの関連）は残す
  it("再実行が失敗しても前回の結果を残す", () => {
    render(<CodeReviewPanel report={report()} runStatus="timeout" onRerun={vi.fn()} />);
    expect(screen.getByText("時間切れ")).toBeTruthy();
    expect(screen.getByText("以下は前回の結果です。")).toBeTruthy();
    expect(screen.getByText("未完了ジョブの判定が種別を見ていない")).toBeTruthy();
  });
});
