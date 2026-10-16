import { resolveDefaultCrossRepoQuestionHost } from "@/lib/dispatch/dispatch-job";
import { enqueueCrossRepoQuestionJob, enqueueSessionControlJob, listDispatchState } from "@/lib/dispatch/jobs";

/** 質問は既存のホスト実行へ送る。Actionsや実装開始へのフォールバックは行わない。 */
export async function prepareIssueQuestion(target: {
  repositoryFullName: string;
  issueNumber: number;
  requestedByUserId: string;
}): Promise<{ error: string } | { send: () => Promise<string | null> }> {
  const state = await listDispatchState();
  const session = state.sessions.find((row) =>
    row.repositoryFullName === target.repositoryFullName &&
    row.issueNumber === target.issueNumber && row.state === "ALIVE",
  );
  const hostName = session?.host ?? resolveDefaultCrossRepoQuestionHost(state.hosts);
  if (!hostName) return { error: "質問に回答できるホストがありません。サブPC・Macの接続状態を確認してください。" };
  return {
    send: async () => {
      const result = session
        ? await enqueueSessionControlJob({
            ...target, hostName, kind: "INSTRUCTION", recovery: false,
            instruction: "Issueに新しい質問が届きました。最新の質問コメントを読み、コードを変更せず回答してください。",
          })
        : await enqueueCrossRepoQuestionJob({ ...target, hostName });
      return result.ok ? null : result.message;
    },
  };
}
