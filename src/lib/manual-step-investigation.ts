import type { IssueComment } from "@/types/issue";

/**
 * 手作業セッションが投稿する「事前調査」「完了検証」の報告を、画面が読むための純関数（#4315）。
 *
 * セッションの調査結果は`buildManualStepSessionPlan`の静的な本文解析には含まれないため、
 * セッション自身がIssueコメントで報告し、画面は最新の1件を読む。形式は
 * `scripts/prompts/manual-step-agent.md`が定める。
 *
 * **マーカーだけでは信用しない。** 本文のマーカーは誰でも書けるので、`authorTrusted`
 * （OWNER/MEMBER/COLLABORATORか`[bot]`）のコメントだけを読む（計画レビューの未反映表示と同じ方針）。
 */
export const MANUAL_STEP_INVESTIGATION_MARKER = "<!-- issue-deck:manual-step-investigation -->";
export const MANUAL_STEP_VERIFICATION_MARKER = "<!-- issue-deck:manual-step-verification -->";

export type ManualStepInvestigation = {
  /** 作業の目的と実施内容 */
  purpose: string;
  /** AIが実施済みの内容（根拠つきの箇条書き） */
  done: string[];
  /** これから自動実行できる内容 */
  auto: string[];
  /** ユーザー本人の操作と、必要な理由 */
  user: ManualStepUserAction[];
};

export type ManualStepUserAction = {
  /** 何をするか（理由を含む1行） */
  text: string;
  /** 実行先・ユーザー・権限・成功時の期待結果を含む、コピーして1回で実行できるコマンド */
  command: string | null;
};

const SECTION_ALIASES: Record<string, keyof ManualStepInvestigation> = {
  目的: "purpose",
  AI実施済み: "done",
  自動実行できる: "auto",
  あなたの操作: "user",
};

function trusted(comment: IssueComment): boolean {
  return comment.authorTrusted === true;
}

function bulletText(line: string): string | null {
  const m = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
  return m ? m[1].trim() : null;
}

export function parseManualStepInvestigation(body: string): ManualStepInvestigation | null {
  if (!body.includes(MANUAL_STEP_INVESTIGATION_MARKER)) return null;

  const result: ManualStepInvestigation = { purpose: "", done: [], auto: [], user: [] };
  let section: keyof ManualStepInvestigation | null = null;
  let fence: string[] | null = null;
  let found = false;

  for (const line of body.split("\n")) {
    if (fence) {
      if (/^\s*```/.test(line)) {
        const last = result.user[result.user.length - 1];
        if (last && last.command === null) last.command = fence.join("\n").trim() || null;
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = SECTION_ALIASES[heading[1]] ?? null;
      if (section) found = true;
      continue;
    }
    if (!section) continue;
    if (/^\s*```/.test(line)) {
      // コマンドは直前の「あなたの操作」の項目に紐付ける
      if (section === "user") fence = [];
      continue;
    }
    const text = bulletText(line) ?? (section === "purpose" ? line.trim() : null);
    if (!text) continue;
    if (section === "purpose") {
      result.purpose = result.purpose ? `${result.purpose} ${text}` : text;
    } else if (section === "user") {
      result.user.push({ text, command: null });
    } else {
      result[section].push(text);
    }
  }
  return found ? result : null;
}

/** 最新の（新しいほうの）信頼できる調査報告。無ければnull（＝調査中または未確認） */
export function findLatestManualStepInvestigation(
  comments: readonly IssueComment[],
): ManualStepInvestigation | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!trusted(comment)) continue;
    const parsed = parseManualStepInvestigation(comment.body);
    if (parsed) return parsed;
  }
  return null;
}

export type ManualStepVerificationRecord = {
  entries: { command: string; exitCode: number }[];
  /** すべて終了コード0のときだけtrue。1件も無い報告は完了とみなさない */
  passed: boolean;
};

/**
 * 完了検証の報告。`- 終了コード0: \`コマンド\``の行を読む。
 * 出力は報告に載せない（シークレットが混ざりうるため）。
 */
export function parseManualStepVerification(body: string): ManualStepVerificationRecord | null {
  if (!body.includes(MANUAL_STEP_VERIFICATION_MARKER)) return null;
  const entries: ManualStepVerificationRecord["entries"] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*[-*]\s+終了コード(\d+)[:：]\s*`(.+)`\s*$/.exec(line);
    if (m) entries.push({ exitCode: Number(m[1]), command: m[2] });
  }
  return {
    entries,
    passed: entries.length > 0 && entries.every((entry) => entry.exitCode === 0),
  };
}

export function findLatestManualStepVerification(
  comments: readonly IssueComment[],
): ManualStepVerificationRecord | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!trusted(comment)) continue;
    const parsed = parseManualStepVerification(comment.body);
    if (parsed) return parsed;
  }
  return null;
}
