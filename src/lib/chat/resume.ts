import { loadStatus, type ChatUser } from "@/lib/chat/handlers";
import { diffRows } from "@/lib/chat/session";
import type { ChatConfirmCard, ChatContext, ChatFreshness, ChatMemory } from "@/lib/chat/types";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { planPullRequestRepair } from "@/lib/github/pull-request-repair-service";

const MAX_REFRESH_TARGETS = 5;

export type ChatStaleConfirm = { messageId: string; reason: string };

/**
 * 会話を開き直したときに、GitHub上の現在の状態を取り直す（#4047）。
 * 保存してあるのは「調査した時点」の値で、ここで返す`current`が「いま」の値。両者を混ぜない。
 * 確認待ちの修復カードは、いま実行しても意味があるか（修復できる問題が残っているか）を照合する。
 */
export async function refreshConversation(params: {
  user: ChatUser;
  context: ChatContext;
  memory: ChatMemory;
  pendingConfirms: { messageId: string; card: ChatConfirmCard }[];
}): Promise<{ freshness: ChatFreshness[]; staleConfirms: ChatStaleConfirm[] }> {
  const { user, context, memory } = params;
  const seen = new Set<string>();
  const targets = [...context.targets, ...memory.findings.slice().reverse()]
    .filter((t) => {
      const key = `${t.repo}#${t.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_REFRESH_TARGETS);

  const freshness = await Promise.all(
    targets.map(async (target): Promise<ChatFreshness> => {
      const finding = memory.findings.find((f) => f.repo === target.repo && f.number === target.number);
      const loaded = await loadStatus(user, { repo: target.repo, number: target.number });
      if (!loaded.ok) {
        return {
          repo: target.repo,
          number: target.number,
          kind: target.kind,
          title: target.title,
          capturedAt: finding?.capturedAt ?? null,
          changes: [],
          current: [],
          error: loaded.message,
        };
      }
      return {
        repo: target.repo,
        number: target.number,
        kind: loaded.card.kind,
        title: loaded.card.title,
        capturedAt: finding?.capturedAt ?? null,
        changes: finding ? diffRows(finding.rows, loaded.card.rows) : [],
        current: loaded.card.rows,
        error: null,
      };
    }),
  );

  const staleConfirms = (
    await Promise.all(
      params.pendingConfirms.map(async ({ messageId, card }): Promise<ChatStaleConfirm | null> => {
        if (card.type !== "confirm_repair") return null;
        const [owner, repo] = card.repo.split("/");
        const repository = await findRepositoryByFullName(user.id, card.repo);
        if (!repository || !owner || !repo) {
          return { messageId, reason: `${card.repo} へのアクセス権が無いため実行できません。` };
        }
        const plan = await planPullRequestRepair(repository, owner, repo, card.number);
        if (!plan.ok) {
          return { messageId, reason: plan.message ?? "いまは自動修正を起動できません（修復済み・実行中の可能性があります）。" };
        }
        if (plan.kinds.join() !== card.kinds.join()) {
          return { messageId, reason: "PRの状態が変わり、修復の内容が確認時と異なります。もう一度「直して」と送ってください。" };
        }
        return null;
      }),
    )
  ).filter((item): item is ChatStaleConfirm => item !== null);

  return { freshness, staleConfirms };
}
