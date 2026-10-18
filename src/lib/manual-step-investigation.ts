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
  /** 実行能力の実測結果（手段・ホスト・結果・確認時刻。#4522）。節が無ければ空 */
  capabilities?: string[];
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
  実行能力: "capabilities",
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

  const result: ManualStepInvestigation = { purpose: "", done: [], auto: [], user: [], capabilities: [] };
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
      (result[section] ??= []).push(text);
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
  /** 完了条件ごとの結果・確認時刻・根拠（#4522）。終了コードとは別に記録する */
  conditions?: ManualStepConditionRecord[];
};

export type ManualStepConditionRecord = {
  condition: string;
  /** 「達成」だけが達成。それ以外（未達・未確認など）は達成と扱わない */
  achieved: boolean;
  result: string;
  checkedAt: string;
  basis: string;
};

/**
 * 完了検証の報告。`- 終了コード0: \`コマンド\``の行を読む。
 * 出力は報告に載せない（シークレットが混ざりうるため）。
 */
export function parseManualStepVerification(body: string): ManualStepVerificationRecord | null {
  if (!body.includes(MANUAL_STEP_VERIFICATION_MARKER)) return null;
  const entries: ManualStepVerificationRecord["entries"] = [];
  const conditions: ManualStepConditionRecord[] = [];
  for (const line of body.split("\n")) {
    const c = /^\s*[-*]\s+条件[:：]\s*(.+?)\s*\/\s*結果[:：]\s*(.+?)\s*\/\s*確認[:：]\s*(.+?)\s*\/\s*根拠[:：]\s*(.+?)\s*$/.exec(line);
    if (c) {
      conditions.push({
        condition: c[1],
        result: c[2],
        achieved: c[2] === "達成",
        checkedAt: c[3],
        basis: c[4],
      });
      continue;
    }
    const m = /^\s*[-*]\s+終了コード(\d+)[:：]\s*`(.+)`\s*$/.exec(line);
    if (m) entries.push({ exitCode: Number(m[1]), command: m[2] });
  }
  return {
    entries,
    // 条件ごとの記録がある場合は、終了コード0だけで完了とせず、全条件の「達成」も要る
    passed:
      entries.length > 0 &&
      entries.every((entry) => entry.exitCode === 0) &&
      conditions.every((condition) => condition.achieved),
    conditions,
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

/**
 * 最新の調査報告・完了検証報告と、それぞれのコメント位置（#4426）。
 *
 * 画面の代表状態は「どちらが新しいか」で変わる（検証に失敗したあとで再調査が始まれば、
 * 表示すべきは失敗ではなく新しい調査の結果）。位置は`comments`の添字で、無ければ`-1`。
 */
export type ManualStepReports = {
  investigation: ManualStepInvestigation | null;
  investigationIndex: number;
  verification: ManualStepVerificationRecord | null;
  verificationIndex: number;
};

export function findLatestManualStepReports(comments: readonly IssueComment[]): ManualStepReports {
  const result: ManualStepReports = {
    investigation: null,
    investigationIndex: -1,
    verification: null,
    verificationIndex: -1,
  };
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!trusted(comment)) continue;
    if (!result.investigation) {
      const parsed = parseManualStepInvestigation(comment.body);
      if (parsed) {
        result.investigation = parsed;
        result.investigationIndex = i;
      }
    }
    if (!result.verification) {
      const parsed = parseManualStepVerification(comment.body);
      if (parsed) {
        result.verification = parsed;
        result.verificationIndex = i;
      }
    }
    if (result.investigation && result.verification) break;
  }
  return result;
}
