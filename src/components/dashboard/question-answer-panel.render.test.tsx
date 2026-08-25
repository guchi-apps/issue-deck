// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuestionAnswerPanel } from "@/components/dashboard/question-answer-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type {
  SessionQuestion,
  SessionQuestionRequestView,
} from "@/lib/dispatch/session-question-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

const QUESTIONS: SessionQuestion[] = [
  {
    question: "認証方式はどれにしますか？",
    header: "認証",
    options: [
      { label: "Supabase Auth", description: "既存アプリと同じ" },
      { label: "NextAuth", description: "自由度が高い" },
    ],
    multiSelect: false,
  },
  {
    question: "どの画面に入れますか？",
    header: "対象画面",
    options: [
      { label: "Issue詳細（PC）", description: "計画パネルと同じ位置" },
      { label: "Issue詳細（スマホ）", description: "別コンポーネント" },
    ],
    multiSelect: true,
  },
];

function request(overrides: Partial<SessionQuestionRequestView> = {}): SessionQuestionRequestView {
  return {
    id: "req-1",
    repositoryFullName: REPO,
    issueNumber: 2189,
    hostName: "subpc",
    questions: QUESTIONS,
    answers: null,
    status: "WAITING",
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 29 * 60 * 1000).toISOString(),
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    id: "session-1",
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-2189",
    repositoryFullName: REPO,
    issueNumber: 2189,
    state: "ALIVE",
    activity: "WAITING_INPUT",
    ...overrides,
  } as DispatchSessionView;
}

function dispatchHandle(answerQuestion = vi.fn().mockResolvedValue({ ok: true })) {
  return { answerQuestion, isSubmitting: false } as unknown as DispatchStateHandle;
}

describe("QuestionAnswerPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("質問文・選択肢とその説明・送る操作を出す", () => {
    render(
      <QuestionAnswerPanel request={request()} session={session()} dispatch={dispatchHandle()} />,
    );

    expect(screen.getByText("質問の回答を待っています")).toBeTruthy();
    expect(screen.getByText("認証方式はどれにしますか？")).toBeTruthy();
    // ラベルだけだと端末で見るより情報が減るので、説明文まで出す
    expect(screen.getByText("既存アプリと同じ")).toBeTruthy();
    expect(screen.getByText("複数選べます")).toBeTruthy();
    expect(screen.getByRole("button", { name: /回答を送る/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /端末・Remote Controlで答える/ })).toBeTruthy();
  });

  // 1問でも空だとツールの結果が「(no option selected)」になり、後から読めない
  it("全部の質問に答えるまで「回答を送る」は押せない", () => {
    render(
      <QuestionAnswerPanel request={request()} session={session()} dispatch={dispatchHandle()} />,
    );

    const send = screen.getByRole("button", { name: /回答を送る/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Supabase Auth/ }));
    expect((screen.getByRole("button", { name: /回答を送る/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: /Issue詳細（PC）/ }));
    expect((screen.getByRole("button", { name: /回答を送る/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * #2341。ラベルを外すのはサーバー側だが、一覧のポーリングは10秒間隔なので、押した直後の
   * 画面には確認待ちのラベルとカードが残ったままになる。手元のIssueにも先に反映させる。
   */
  it("回答を送ると、確認待ちが解けたことを親へ伝える", async () => {
    const onCheckUserResolved = vi.fn();
    render(
      <QuestionAnswerPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        onCheckUserResolved={onCheckUserResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Supabase Auth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Issue詳細（PC）/ }));
    fireEvent.click(screen.getByRole("button", { name: /回答を送る/ }));

    await waitFor(() => expect(onCheckUserResolved).toHaveBeenCalledTimes(1));
  });

  // 端末で答えると言っただけで、人はまだ答えていない
  it("端末・Remote Controlで答える場合は伝えない", async () => {
    const onCheckUserResolved = vi.fn();
    const answerQuestion = vi.fn().mockResolvedValue({ ok: true });
    render(
      <QuestionAnswerPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(answerQuestion)}
        onCheckUserResolved={onCheckUserResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /端末・Remote Controlで答える/ }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalled());
    expect(onCheckUserResolved).not.toHaveBeenCalled();
  });

  it("単一選択は選び直しで入れ替わり、複数選択は足せる", async () => {
    const answerQuestion = vi.fn().mockResolvedValue({ ok: true });
    render(
      <QuestionAnswerPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(answerQuestion)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Supabase Auth/ }));
    fireEvent.click(screen.getByRole("button", { name: /NextAuth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Issue詳細（PC）/ }));
    fireEvent.click(screen.getByRole("button", { name: /Issue詳細（スマホ）/ }));
    fireEvent.click(screen.getByRole("button", { name: /回答を送る/ }));

    await waitFor(() => expect(answerQuestion).toHaveBeenCalled());
    expect(answerQuestion.mock.calls[0][0]).toMatchObject({
      id: "req-1",
      decision: "answer",
      answers: [
        { question: "認証方式はどれにしますか？", options: ["NextAuth"] },
        {
          question: "どの画面に入れますか？",
          options: ["Issue詳細（PC）", "Issue詳細（スマホ）"],
        },
      ],
    });
  });

  it("「その他」に書いた文章も一緒に送る", async () => {
    const answerQuestion = vi.fn().mockResolvedValue({ ok: true });
    render(
      <QuestionAnswerPanel
        request={request({ questions: [QUESTIONS[0]] })}
        session={session()}
        dispatch={dispatchHandle(answerQuestion)}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/どれとも違うときは/), {
      target: { value: "自前で書く" },
    });
    fireEvent.click(screen.getByRole("button", { name: /回答を送る/ }));

    await waitFor(() => expect(answerQuestion).toHaveBeenCalled());
    expect(answerQuestion.mock.calls[0][0].answers[0]).toMatchObject({
      options: [],
      text: "自前で書く",
    });
  });

  it("送った直後は結果だけを出す", async () => {
    render(
      <QuestionAnswerPanel request={request()} session={session()} dispatch={dispatchHandle()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Supabase Auth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Issue詳細（PC）/ }));
    fireEvent.click(screen.getByRole("button", { name: /回答を送る/ }));

    await waitFor(() => expect(screen.getByText(/回答を送りました/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /回答を送る/ })).toBeNull();
  });

  it("待ち時間が切れた後は、端末で答えるよう案内する", () => {
    render(
      <QuestionAnswerPanel
        request={request({ status: "EXPIRED", decidedAt: new Date().toISOString() })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/端末に選択フォームを出しました/)).toBeTruthy();
  });

  it("セッションが終了していたら、届かないことを出して押させない", () => {
    render(
      <QuestionAnswerPanel
        request={request()}
        session={session({ state: "EXITED" })}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/このセッションは終了しています/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /回答を送る/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
