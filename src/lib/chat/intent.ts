import type { ChatContext, ChatIntent, ChatRef, ChatTarget } from "@/lib/chat/types";

/**
 * 文章から意図を読む（#3975）。**LLMには任せず、決まった言い回しだけを拾う。**
 * 副作用のある操作（修復・Issue作成）を言い回しの揺れで誤って起動しないため、迷う文章は
 * `unknown`にして使い方を返す。起動そのものは確認カードの「実行する」を必ず通る。
 */

// `owner/repo#123`・`repo#123`・`#123`・`123`（2桁以上の裸の数字）を拾う。
const REF_PATTERN = /(?:([\w.-]+\/[\w.-]+)|([\w.-]+))?#(\d{1,7})|(?<![\w/.-])(\d{2,7})(?![\w/.-])/g;

export function extractRefs(text: string): ChatRef[] {
  const refs: ChatRef[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    const number = Number(match[3] ?? match[4]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const repo = match[1] ?? null;
    if (!refs.some((ref) => ref.number === number && ref.repo === repo)) {
      refs.push({ repo, number });
    }
  }
  return refs;
}

const REPAIR_WORDS = /(直して|直す|修正して|修復|自動修正|リペア|fix)/i;
const ISSUE_WORDS = /(別\s*issue|issue\s*(に|化|として|を)|起案|起票|issueにして)/i;
const MERGE_WORDS = /(マージ.*(できる|大丈夫|いい|可能)|merge)/i;
const RECHECK_WORDS = /(もう\s*(一度|1回|いっかい|一回)|再確認|再度|確認して|チェックして|どうなって|状況|状態|進捗|ステータス)/;
const PR_WORDS = /^(pr|プルリク|pull\s*request)(は|って|を)?[？?\s]*$/i;

export function parseIntent(text: string): ChatIntent {
  const trimmed = text.trim();
  if (!trimmed) return { type: "unknown" };
  const refs = extractRefs(trimmed);

  if (ISSUE_WORDS.test(trimmed)) {
    const title = trimmed
      .replace(/(この問題は|これは|それは|これを|それを)/g, "")
      .replace(ISSUE_WORDS, "")
      .replace(/(して|してください|にして|にしてください|お願い)[。！!？?\s]*$/g, "")
      .trim();
    return { type: "create_issue", title: title.length >= 4 ? title : null };
  }
  if (REPAIR_WORDS.test(trimmed)) {
    return { type: "repair", ref: refs[0] ?? null };
  }
  if (MERGE_WORDS.test(trimmed)) return { type: "merge_check" };
  if (refs.length > 0) return { type: "status", refs };
  if (RECHECK_WORDS.test(trimmed) || PR_WORDS.test(trimmed)) return { type: "recheck" };
  return { type: "unknown" };
}

export type ResolvedIntent =
  | { type: "status"; targets: ResolvedRef[] }
  | { type: "merge_check"; target: ResolvedRef }
  | { type: "repair"; target: ResolvedRef }
  | { type: "create_issue"; title: string | null; repo: string; source: ChatTarget | null }
  | { type: "ask"; question: string; options: { label: string; send: string }[] }
  | { type: "unknown" };

export type ResolvedRef = { repo: string; number: number };

function withRepo(ref: ChatRef, context: ChatContext): ResolvedRef | null {
  const repo = ref.repo ?? context.repo;
  return repo ? { repo, number: ref.number } : null;
}

/** 候補の対象を、そのまま発言として送り直せる形にする（押すと対象が明示される） */
function suggestOptions(context: ChatContext, verb: string) {
  return context.targets.slice(0, 4).map((target) => ({
    label: `#${target.number} ${target.title}`.slice(0, 48),
    send: `${target.repo}#${target.number}${verb}`,
  }));
}

/**
 * 意図に会話コンテキストを当てはめる。**対象が決められないときは実行せず`ask`を返す**。
 * 直前の対象が1件に決まるのは、直前の発言で確認した対象が1件だったときだけ。
 * 複数を並べて見せた直後の「直して」は、どれを指すか決められないので聞き返す。
 */
export function resolveIntent(intent: ChatIntent, context: ChatContext): ResolvedIntent {
  switch (intent.type) {
    case "status": {
      const targets = intent.refs.map((ref) => withRepo(ref, context));
      if (targets.some((target) => target === null)) {
        return {
          type: "ask",
          question: "どのリポジトリの番号か分かりません。`owner/repo#番号`の形で書いてください。",
          options: [],
        };
      }
      return { type: "status", targets: targets as ResolvedRef[] };
    }
    case "recheck":
    case "merge_check":
    case "repair": {
      const explicit = intent.type === "repair" && intent.ref ? withRepo(intent.ref, context) : null;
      const verb = intent.type === "repair" ? "を直して" : intent.type === "merge_check" ? "はマージできる？" : "を確認して";
      if (explicit) return { type: "repair", target: explicit };
      // 直前の発言で見せた対象が1件ならそれを指す。複数ならどれか決められないので聞き返す
      const latest = context.targets;
      if (latest.length === 0) {
        return {
          type: "ask",
          question: "まだ対象がありません。「#3966どうなってる？」のように番号を教えてください。",
          options: [],
        };
      }
      if (latest.length > 1) {
        return {
          type: "ask",
          question: "どの対象のことですか？",
          options: suggestOptions(context, verb),
        };
      }
      const target: ResolvedRef = { repo: latest[0].repo, number: latest[0].number };
      if (intent.type === "repair") return { type: "repair", target };
      if (intent.type === "merge_check") return { type: "merge_check", target };
      return { type: "status", targets: [target] };
    }
    case "create_issue": {
      const repo = context.targets[0]?.repo ?? context.repo;
      if (!repo) {
        return {
          type: "ask",
          question: "どのリポジトリに起案しますか？ `owner/repo#番号`で対象を一度確認してから、もう一度お願いします。",
          options: [],
        };
      }
      return { type: "create_issue", title: intent.title, repo, source: context.targets[0] ?? null };
    }
    case "unknown":
      return { type: "unknown" };
  }
}

export const CHAT_HELP_TEXT =
  "次のように話しかけてください。\n- 「#3966どうなってる？」（複数なら「3960と3961どうなってる？」）\n- 「直して」「もう一度確認して」「マージできる？」（直前に見た対象を指します）\n- 「別Issueにして」（この会話を材料にIssue案を作ります）";
