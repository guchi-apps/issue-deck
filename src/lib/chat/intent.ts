import type { ChatContext, ChatIntent, ChatRef, ChatTarget } from "@/lib/chat/types";

/**
 * 文章から意図を読む（#3975）。**LLMには任せず、決まった言い回しだけを拾う。**
 * 副作用のある操作（修復・Issue作成）を言い回しの揺れで誤って起動しないため、迷う文章は
 * `unknown`にして使い方を返す。起動そのものは確認カードの「実行する」を必ず通る。
 */

// `owner/repo#123`・`repo#123`・`#123`・`123`（2桁以上の裸の数字）を拾う。
const REF_PATTERN = /(?:([\w.-]+\/[\w.-]+)|([\w.-]+))?#(\d{1,7})|(?<![\w/.-])(\d{2,7})(?![\w/.-])(?!\s*(?:日|件|個|人|回|分|時|月|年|週|円|％|%|行|枚|本|台|名|桁|秒|倍|割|番目|px|ms))/g;

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

/** 既存の自動修正を明示した依頼。ここだけが定型の修復（確認カード）へ進む */
const AUTO_REPAIR_WORDS = /(修復|自動修正|リペア|再実行|もう一度.*(直して|修正して))/i;
/** 「直して」「修正して」。自動修正の起動ではなく、停止理由などの調査を起点に対応を選ぶ（#4153） */
const FIX_WORDS = /(直して|直す|修正して|修正を|対応して|fix)/i;
const ISSUE_WORDS = /(別\s*issue|issue\s*(に|化|として|を)|起案|起票|issueにして)/i;
const MERGE_WORDS = /(マージ.*(できる|大丈夫|いい|可能)|merge)/i;
const RECHECK_WORDS = /(もう\s*(一度|1回|いっかい|一回)|再確認|再度|確認して|チェックして|どうなって|状況|状態|進捗|ステータス)/;
/** 状態の言い換えでは答えられない、理由・内容・方針の質問（#4045）。AIが調べて答える */
const INVESTIGATE_WORDS =
  /(なぜ|なんで|どうして|理由|原因|止まって|詰まって|進まない|調べ|調査|レビュー(の)?(内容|指摘|コメント)|指摘|中身|読んで|教えて|説明|どういう|どうすれば|方針|続けて|続きを|それで|この方針|その方針|相談|ログ|失敗)/;
/** 調べてから直す依頼（「確認して直して」）。定型の自動修正ではなく調査を通す */
const CHECK_THEN_FIX = /(確認|調べ|調査|見て|読んで|レビュー|指摘|方針).*(直して|修正して|対応して|fix)|(直して|修正して|対応して).*(確認|調べ|調査|方針)/i;
/**
 * 設計の相談・比較の質問（#4093）。「直すならどの案がよい？」「Issueにする前に相談したい」を、
 * 修正依頼・Issue起案の操作と取り違えないよう、操作語より先に調べ（相談）へ回す
 */
const CONSULT_WORDS =
  /(相談したい|相談です|相談に乗|どの案|どちらがいい|どっちがいい|どれがいい|どれがよい|直すなら|直すとしたら|直すべき|にする前に|起案する前に|起票する前に|してもいい？|でいい？|がよい？|がいい？)/;
/**
 * 機能・挙動の改善依頼（#4281）。「〜したい」「〜してほしい」のように要望の形をした文。
 * 文中の「状態」「状況」で状態確認と取り違えないよう、単語ではなく依頼の文末の形で判定する
 */
const REQUEST_WORDS =
  /(たい(です|な|かも)?[。！!\s]*$|[てでに]ほしい|[てでに]欲しい|ほしい|欲しい|ようにして|ようにしたい|ように(なって|なると)|できると(いい|嬉し|助か|うれし)|できれば|あるといい|があれば|ならいい|のほうがいい|方がいい)/;
/** 状態確認の言い換えとみなす発言の長さ。これより長い具体的な文は状態確認にしない */
const RECHECK_MAX_LENGTH = 30;
const PR_WORDS = /^(pr|プルリク|pull\s*request)(は|って|を)?[？?\s]*$/i;

export function parseIntent(text: string): ChatIntent {
  const trimmed = text.trim();
  if (!trimmed) return { type: "unknown" };
  const refs = extractRefs(trimmed);

  if (CONSULT_WORDS.test(trimmed)) return { type: "investigate", ref: refs[0] ?? null };
  if (ISSUE_WORDS.test(trimmed)) {
    const title = trimmed
      .replace(/(この問題は|これは|それは|これを|それを)/g, "")
      .replace(ISSUE_WORDS, "")
      .replace(/(して|してください|にして|にしてください|お願い)[。！!？?\s]*$/g, "")
      .trim();
    return { type: "create_issue", title: title.length >= 4 ? title : null };
  }
  if (CHECK_THEN_FIX.test(trimmed)) {
    return { type: "investigate", ref: refs[0] ?? null, fix: true };
  }
  if (AUTO_REPAIR_WORDS.test(trimmed)) {
    return { type: "repair", ref: refs[0] ?? null };
  }
  if (FIX_WORDS.test(trimmed)) {
    return { type: "investigate", ref: refs[0] ?? null, fix: true };
  }
  if (MERGE_WORDS.test(trimmed)) return { type: "merge_check" };
  // 番号のない改善依頼は、既存のIssue/PRとは結び付けず実装の調査へ回す（修正系の語は上で先に判定済み）
  if (refs.length === 0 && REQUEST_WORDS.test(trimmed)) {
    return { type: "investigate", ref: null, request: true };
  }
  if (INVESTIGATE_WORDS.test(trimmed)) return { type: "investigate", ref: refs[0] ?? null };
  if (refs.length > 0) return { type: "status", refs };
  if ((trimmed.length <= RECHECK_MAX_LENGTH && RECHECK_WORDS.test(trimmed)) || PR_WORDS.test(trimmed)) {
    return { type: "recheck" };
  }
  return { type: "unknown" };
}

export type ResolvedIntent =
  | { type: "status"; targets: ResolvedRef[] }
  | { type: "merge_check"; target: ResolvedRef }
  | { type: "repair"; target: ResolvedRef }
  | { type: "create_issue"; title: string | null; repo: string; source: ChatTarget | null }
  | { type: "ask"; question: string; options: { label: string; send: string }[] }
  /** AIが読み取りツールで調べる。対象が決まらなくても聞き返さず、調査側が必要なら聞く */
  | { type: "investigate"; target: ResolvedRef | null; candidates: ChatTarget[]; fix?: boolean; request?: boolean }
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
  // 番号なしの設計相談の途中（調査の対象が無い）。「現状を確認して」「それで」は前のPRではなく相談へつなぐ
  const consulting = !!context.investigation && !context.investigation.target && context.targets.length === 0;
  if (consulting && (intent.type === "recheck" || (intent.type === "investigate" && !intent.ref))) {
    return { type: "investigate", target: null, candidates: [] };
  }
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
    case "investigate": {
      const fix = intent.fix ? { fix: true } : {};
      // 新しい機能要望は、直前に見たPRや前の調査対象へ結び付けない（選択リポジトリの実装を調べる）
      if (intent.request) return { type: "investigate", target: null, candidates: [], request: true };
      const explicit = intent.ref ? withRepo(intent.ref, context) : null;
      if (explicit) return { type: "investigate", target: explicit, candidates: [], ...fix };
      const known = context.investigation?.target ?? null;
      if (context.targets.length === 1) {
        const [t] = context.targets;
        return { type: "investigate", target: { repo: t.repo, number: t.number }, candidates: [], ...fix };
      }
      if (known && (context.targets.length === 0 || context.targets.some((t) => t.number === known.number))) {
        return { type: "investigate", target: { repo: known.repo, number: known.number }, candidates: [], ...fix };
      }
      return { type: "investigate", target: null, candidates: context.targets.slice(0, 4), ...fix };
    }
    case "unknown":
      return { type: "unknown" };
  }
}

export const CHAT_HELP_TEXT =
  "次のように話しかけてください。\n- 「勤務画面を週表示にしたいかも」（番号なしの困りごと・改善案の相談。案の比較から「これでIssue起案して」まで進めます）\n- 「#3966はなぜ止まっている？」（レビュー・CIログまで調べて理由を答えます）\n- 「直して」「#3966を修正して」（停止理由・過去の自動修正・会話の合意を調べたうえで、必要な修正を確認カードで出します。自動修正だけの起動は「自動修正して」）\n- 「#3966どうなってる？」（複数なら「3960と3961どうなってる？」）\n- 「直して」「もう一度確認して」「マージできる？」（直前に見た対象を指します）\n- 「別Issueにして」（この会話を材料にIssue案を作ります）";
