import { computeManualStepReadiness, type ManualStepReadinessMap } from "@/lib/manual-step-attention";
import { FENCE_PATTERN, TASK_LINE_PATTERN } from "@/lib/markdown-task-list";
import type { Issue } from "@/types/issue";

/**
 * 手作業Issue（`71.manual-step`）の本文を、順番に案内できる形へ解析する（#1826）。
 *
 * 手作業Issueの本文はテンプレート（CLAUDE.md「ユーザーの手作業が残る場合は新規Issueとして
 * 起票する」）で見出しの並びが決まっている。**すでに機械が読める形になっている**ので、
 * ここでは解析だけを行い、Claude APIのような推定は挟まない——実行するコマンドを推定で
 * 書き換える余地を作ると、手作業ではそのまま事故になる。
 *
 * 画面（`components/dashboard/manual-step-guide-dialog.tsx`）はこの結果を
 * 「目的 → 手順1..n → 完了の確認」のステップに割って1手順ずつ出す。
 *
 * **テンプレートに沿っていない本文（`hasTemplate: false`）を隠さない。** 手順に割れない
 * だけで、案内する相手からは外さない（呼び出し側は本文をそのまま1画面で出す）。
 */

/** `## やること`から切り出した手順1件 */
export type ManualStepGuideStep = {
  /**
   * この手順が書かれている本文の行番号（1始まり）。`hooks/use-issue-task-list.ts`の
   * `toggleTask`へそのまま渡してチェックを付ける。チェックリストでない手順はnullで、
   * その場合は本文を書き換えず次へ進むだけになる。
   */
  line: number | null;
  checked: boolean;
  /**
   * 画面に描くMarkdown（見出し文＋直下のコードブロック）。行頭のインデントは
   * **リストマーカーぶんだけ**戻してある（`blockMarkdown`）。インデント記法で書かれた
   * コードブロックはコードブロックのまま残る
   */
  markdown: string;
  /** 一覧・見出しに使う素のテキスト（Markdownの記法を落としたもの） */
  text: string;
};

/** `## 前提条件`から拾った「どこで実行するか」。書かれていない項目はnull */
export type ManualStepGuideWhere = {
  device: string | null;
  directory: string | null;
  branch: string | null;
};

export type ManualStepGuide = {
  /**
   * `## やること`が見つかったか。falseなら手順に割れていないので、呼び出し側は
   * 本文をそのまま出すフォールバックへ落ちる
   */
  hasTemplate: boolean;
  /** `## この作業でできるようになること`（Markdownのまま） */
  outcome: string | null;
  where: ManualStepGuideWhere;
  /**
   * `## やること`の1つ目のチェック項目より前に書かれた前置き（Markdownのまま）。
   * 「発行し直さずVPSから移す」のような**手順全体に効く注意**がここに書かれることがあり、
   * 落とすと手順だけを読んだ人がその注意を踏まずに実行してしまう。
   */
  todoIntro: string | null;
  steps: ManualStepGuideStep[];
  /** `## 完了の確認方法`（Markdownのまま） */
  verification: string | null;
};

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

/**
 * 見出しの照合。テンプレートの文言そのままだけでなく、書き手の揺れ（`## 手順`・`## 確認方法`）も
 * 拾う。**部分一致で見る**のは、`## やること（サブPC）`のように補足が付く書き方が実際にあるため。
 */
const SECTION_MATCHERS = {
  outcome: ["できるようになること"],
  prerequisites: ["前提条件"],
  todo: ["やること", "手順"],
  verification: ["完了の確認方法", "確認方法"],
} as const;

type SectionKey = keyof typeof SECTION_MATCHERS;

type Section = { key: SectionKey | null; lines: string[]; startLine: number };

/**
 * 本文を見出しで区切る。**コードフェンスの中の`#`は見出しにしない**——コピペ用コマンドの
 * `# コメント`を見出しとして取ると、そこで節が切れる。
 *
 * @returns 各節。`startLine`はその節の1行目の本文中の行番号（1始まり）
 */
function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section = { key: null, lines: [], startLine: 1 };
  let openFence: string | null = null;

  lines.forEach((line, index) => {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      current.lines.push(line);
      return;
    }
    if (openFence !== null) {
      current.lines.push(line);
      return;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (!heading) {
      current.lines.push(line);
      return;
    }

    sections.push(current);
    current = { key: matchSectionKey(heading[2]), lines: [], startLine: index + 2 };
  });

  sections.push(current);
  return sections;
}

function matchSectionKey(title: string): SectionKey | null {
  const normalized = title.replace(/[\s*`]/g, "");
  for (const [key, needles] of Object.entries(SECTION_MATCHERS) as [
    SectionKey,
    readonly string[],
  ][]) {
    if (needles.some((needle) => normalized.includes(needle))) return key;
  }
  return null;
}

function findSection(sections: Section[], key: SectionKey): Section | null {
  return sections.find((section) => section.key === key) ?? null;
}

/** 節の本文。前後の空行を落とし、空なら`null` */
function sectionText(section: Section | null): string | null {
  if (!section) return null;
  const text = blockMarkdown(section.lines);
  return text === "" ? null : text;
}

/** `## 前提条件`から「どこで実行するか」を拾う */
function parseManualStepWhere(section: Section | null): ManualStepGuideWhere {
  const where: ManualStepGuideWhere = { device: null, directory: null, branch: null };
  if (!section) return where;

  for (const line of section.lines) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!item) continue;
    const separator = /[:：]/.exec(item[1]);
    if (!separator) continue;

    const label = normalizeInline(item[1].slice(0, separator.index));
    const value = cleanWhereValue(item[1].slice(separator.index + 1));
    if (value === null) continue;

    // 「カレントディレクトリ」より先に「ディレクトリ」を見ないよう、長い語から順に判定する
    if (where.device === null && label.includes("デバイス")) where.device = value;
    else if (where.directory === null && label.includes("ディレクトリ")) where.directory = value;
    else if (where.branch === null && label.includes("ブランチ")) where.branch = value;
  }

  return where;
}

/**
 * チップに出す値へ整える。
 *
 * テンプレートの実例は`**サブPC**（メインPCからなら \`ssh subpc\`）`のように、太字と
 * 補足の括弧書きが付く。チップは1行に並べるので**括弧書きは落とす**（読みたい人のために
 * 本文そのものは別に出る）。「不要」「なし」はチップを出す意味が無いのでnullにする。
 */
function cleanWhereValue(raw: string): string | null {
  let value = normalizeInline(raw);
  value = value.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
  if (value === "" || value === "不要" || value === "なし") return null;
  return value;
}

/** 太字・コード・リンクの記法を落として素のテキストにする */
function normalizeInline(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

/**
 * `## やること`を手順へ割る。
 *
 * チェック行から次のチェック行（または節の終わり）までを1手順とし、そのリスト項目の
 * インデントぶんだけ行頭を戻して`markdown`にする（`blockMarkdown`）。テンプレートでは
 * 手順の下にコードブロックを**インデントして**置く決まりなので、戻さないとコードブロックとして
 * 描かれない。
 *
 * **チェックリストが1つも無ければ節全体を1手順として返す**（手順が1つの手作業は
 * チェックリストにしなくてよい、という運用に合わせる）。
 */
function parseSteps(section: Section): { intro: string | null; steps: ManualStepGuideStep[] } {
  /** `indent`はそのチェック行のリストマーカーぶんの幅（`- [ ] `なら`- `の2） */
  const marks: { index: number; checked: boolean; indent: number }[] = [];
  let openFence: string | null = null;

  section.lines.forEach((line, index) => {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      return;
    }
    if (openFence !== null) return;

    const task = TASK_LINE_PATTERN.exec(line);
    if (task) marks.push({ index, checked: task[2] !== " ", indent: task[1].length });
  });

  if (marks.length === 0) {
    // 節の直下は列0から始まるので、ここでは何も削らない
    const markdown = blockMarkdown(section.lines);
    if (markdown === "") return { intro: null, steps: [] };
    return {
      intro: null,
      steps: [{ line: null, checked: false, markdown, text: firstLineText(markdown) }],
    };
  }

  const introText = blockMarkdown(section.lines.slice(0, marks[0].index));
  const steps = marks.map((mark, order) => {
    const end = order + 1 < marks.length ? marks[order + 1].index : section.lines.length;
    const head = section.lines[mark.index].replace(TASK_LINE_PATTERN, "").trim();
    const rest = blockMarkdown(section.lines.slice(mark.index + 1, end), mark.indent);
    const markdown = rest === "" ? head : `${head}\n\n${rest}`;
    return {
      line: section.startLine + mark.index,
      checked: mark.checked,
      markdown,
      text: normalizeInline(head),
    };
  });

  return { intro: introText === "" ? null : introText, steps };
}

/**
 * 画面へ渡すMarkdownへ整える。行頭から削るのは**その位置の構造ぶんだけ**にする。
 *
 * 1. リスト項目の中なら、マーカーぶんの列数（`indent`）。GitHubがその項目に対して削るのと同じ
 * 2. フェンス付きコードブロックは、開きフェンスのインデントぶん（Markdownの描画と同じ）
 *
 * 空行以外の**最小インデント**ぶんを削っていた頃は、テンプレートどおりに**インデント記法**
 * （4スペース）でコマンドを書いた手順が、コードブロックではなく素の段落として描かれていた
 * （#1835。`- [x] `の下に置かれた6スペースを6つとも削っていた）。構造ぶんだけ削る形にすると、
 * フェンス記法・インデント記法のどちらで書かれていてもGitHubと同じ見え方になり、
 * コードブロックとして描かれる＝コピーボタン（#1726）が付く。
 *
 * フェンスの中まで列0へ寄せるのは、`lib/manual-step-command.ts`（#1828の代行実行）が
 * この`markdown`からコマンドを取り出すため。描画では消えるインデントがコマンドに残ると、
 * 実行するコマンドの見た目が本文と食い違う。
 *
 * **前後の空行は行単位で落とす。** 文字単位の`trim()`だと、先頭がインデント記法の
 * コードブロックのときに行頭のスペースごと消えてしまい、ここで削らない意味が無くなる。
 *
 * @param indent 削る列数。手順ならそのリスト項目のマーカーぶん、節の直下なら0
 */
function blockMarkdown(lines: string[], indent = 0): string {
  const stripped: string[] = [];
  let fence: { marker: string; indent: number } | null = null;

  for (const raw of lines) {
    const line = stripLeadingSpaces(raw, indent);
    // 4スペース以上下がった``` はフェンスではなくインデント記法のコードブロックの中身
    // （CommonMarkと同じ扱い）。フェンスとして読むと、中身のインデントまで削ってしまう
    const marker = line.length - line.trimStart().length < 4
      ? FENCE_PATTERN.exec(line)?.[1][0]
      : undefined;

    if (marker !== undefined && fence === null) {
      fence = { marker, indent: line.length - line.trimStart().length };
      stripped.push(stripLeadingSpaces(line, fence.indent));
      continue;
    }
    if (marker !== undefined && marker === fence?.marker) {
      stripped.push(stripLeadingSpaces(line, fence.indent));
      fence = null;
      continue;
    }
    stripped.push(fence === null ? line : stripLeadingSpaces(line, fence.indent));
  }

  let start = 0;
  let end = stripped.length;
  while (start < end && stripped[start].trim() === "") start += 1;
  while (end > start && stripped[end - 1].trim() === "") end -= 1;
  return stripped.slice(start, end).join("\n");
}

/** 行頭のインデントを最大`width`文字ぶん削る（行頭以外は触らない） */
function stripLeadingSpaces(line: string, width: number): string {
  return line.slice(Math.min(width, line.length - line.trimStart().length));
}

function firstLineText(markdown: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return normalizeInline(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
}

export function parseManualStepGuide(body: string | null): ManualStepGuide {
  const empty: ManualStepGuide = {
    hasTemplate: false,
    outcome: null,
    where: { device: null, directory: null, branch: null },
    todoIntro: null,
    steps: [],
    verification: null,
  };
  if (!body || body.trim() === "") return empty;

  const sections = splitSections(body);
  const todo = findSection(sections, "todo");
  const parsed = todo ? parseSteps(todo) : { intro: null, steps: [] };

  return {
    hasTemplate: parsed.steps.length > 0,
    outcome: sectionText(findSection(sections, "outcome")),
    where: parseManualStepWhere(findSection(sections, "prerequisites")),
    todoIntro: parsed.intro,
    steps: parsed.steps,
    verification: sectionText(findSection(sections, "verification")),
  };
}

/**
 * アシスタントが案内するIssueの並びを決める（#1826）。
 *
 * **対象はいま実行できる手作業だけ**（左メニューの件数・通知ベルと同じ
 * `computeManualStepReadiness`）。先行する変更が本番へ出るまで実行できない手作業まで
 * 並べると、順番に進めても押せない画面に突き当たる。
 *
 * 並びは更新の古い順。放置されているものから片付ける。
 *
 * @param issues 判定の対象。左メニューの絞り込みを適用したあとの一覧でよい
 * @param readiness `computeManualStepReadiness`の結果。省略時はここで計算する
 * @param startIssueId Issue詳細から開いた場合の起点。**前提待ちでも先頭に入れる**——
 *   人が明示的に開いた1件を、本文からの推定でしかない前提判定で締め出さない
 */
export function buildManualStepQueue(
  issues: Issue[],
  readiness: ManualStepReadinessMap = computeManualStepReadiness(issues),
  startIssueId?: string,
): Issue[] {
  const actionable = issues
    .filter((issue) => issue.id !== startIssueId && readiness.get(issue.id)?.ready === true)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const start = startIssueId ? issues.find((issue) => issue.id === startIssueId) : undefined;
  return start ? [start, ...actionable] : actionable;
}
