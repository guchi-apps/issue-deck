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
 *
 * **実行する端末は手順ごとに持てる**（#2052）。実際の手作業は端末をまたぐ（手順1はブラウザ、
 * 手順2はサブPC、手順6はVPS）のに、書ける場所が`## 前提条件`の1行しか無かったため、
 * 代行の可否がIssue単位でしか決まらず「ブラウザ作業が大半のIssueでも代行対象になる」状態に
 * なっていた。手順の文頭の`（サブPC）`を`ManualStepGuideStep.device`として拾い、
 * 書かれていない手順は`where.defaultDevice`へ落とす（`resolveManualStepDevice`）。
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
  /**
   * 一覧・見出しに使う素のテキスト（Markdownの記法を落としたもの）。
   * **文頭のデバイスの印（`（サブPC）`）は落としてある**——一覧ではデバイスを隣に別に出すため、
   * 残すと同じ語が二重に並ぶ。`markdown`は本文のまま（GitHubと同じ見え方を崩さない）。
   */
  text: string;
  /**
   * この手順を実行する端末（#2052）。手順の文頭に`（サブPC）`と書かれていれば、その名前
   * （`MANUAL_STEP_DEVICE_NAMES`の`label`）。書かれていなければ`null`で、呼び出し側は
   * `where.defaultDevice`へフォールバックする（`resolveManualStepDevice`）。
   *
   * **明示された括弧書きだけを読む。** 「サブPCで〜する」のような散文からは推測しない——
   * デバイスを文字列の部分一致で決めたことがIssue単位の判定が壊れていた原因そのもの
   * （`isSubpcManualStepDevice`が「ブラウザとサブPC」で真になっていた）で、推測を足すと
   * 同じ壊れ方を手順単位で作り直すことになる。
   */
  device: string | null;
};

/**
 * 手作業の実行先として本文に書ける端末（#2052）。**この4つ以外はデバイスとして読まない。**
 *
 * ここが唯一の正で、本文の書式検査（`manual-step-body-check.ts`）も同じ定義を使う。
 * 別々に持つと、検査を通った書き方を画面が読めない（その逆も）が必ず出る。
 */
export const MANUAL_STEP_DEVICE_NAMES = [
  { label: "サブPC", needles: ["サブpc", "subpc"] },
  { label: "メインPC", needles: ["メインpc", "mainpc"] },
  { label: "VPS", needles: ["vps"] },
  { label: "ブラウザ", needles: ["ブラウザ"] },
] as const;

/**
 * 端末名の照合用に、装飾・空白・区切りを落として小文字へ寄せる。
 *
 * `sub-pc`・`ｻﾌﾞPC`のような書き方まで吸収するのは、**代行実行の可否がこの照合で決まる**ため
 * （`isSubpcManualStepDevice`が持っていた正規化をここへ寄せた。#2052）。読み取れなければ
 * 代行しない側へ倒す作りなので、揺れを吸収できないと書き方の違いだけで押せなくなる。
 */
function normalizeDeviceText(text: string): string {
  return text.replace(/ｻﾌﾞ/g, "サブ").replace(/[\s　*`_-]/g, "").toLowerCase();
}

/**
 * 文字列に現れる端末の名前を列挙する（現れた順ではなく`MANUAL_STEP_DEVICE_NAMES`の順）。
 *
 * 2つ以上返るということは、その1行では「どこで実行するのか」が1つに決まらないということ。
 * 呼び出し側はそれを**決まらないものとして扱う**（既定値にしない・指摘する）。
 */
export function matchManualStepDeviceNames(value: string | null): string[] {
  if (value === null) return [];
  const normalized = normalizeDeviceText(value);
  return MANUAL_STEP_DEVICE_NAMES.filter((entry) =>
    entry.needles.some((needle) => normalized.includes(needle)),
  ).map((entry) => entry.label);
}

/**
 * その手順を実行する端末を決める（#2052）。手順に書かれていればそれ、無ければ手作業の既定値。
 *
 * **代行の可否・チップ・接続の案内は、すべてこの1つの関数を通す。** 手順とIssueのどちらを
 * 見るかを呼び出し側ごとに書くと、画面では代行できるのにAPIが拒否する（その逆も）が生まれる。
 */
export function resolveManualStepDevice(
  where: ManualStepGuideWhere,
  step: Pick<ManualStepGuideStep, "device"> | null | undefined,
): string | null {
  return step?.device ?? where.defaultDevice;
}

/** `## 前提条件`から拾った「どこで実行するか」。書かれていない項目はnull */
export type ManualStepGuideWhere = {
  /** 「実行するデバイス」に書かれていた値そのまま（チップ・理由文の表示に使う） */
  device: string | null;
  /**
   * デバイスが書かれていない手順の既定値（#2052）。**判定に使うのはこちら。**
   *
   * `device`に端末が2つ以上書かれていたら`null`にする。「ブラウザ（…）とサブPC」のような
   * 本文で「サブPCを含むから代行してよい」と読むと、ブラウザでしかできない手順まで代行の
   * 対象になる（実際にそうなっていた）。**読み取れないものは代行しない側へ倒し**、どの手順を
   * どこで実行するかは手順の文頭に書いてもらう（`ManualStepGuideStep.device`）。
   */
  defaultDevice: string | null;
  directory: string | null;
  branch: string | null;
  /**
   * その端末へ入るためのコマンド（#1882）。テンプレートの「実行するデバイス」は
   * `**サブPC**（メインPCからなら \`ssh subpc\`）`のように**括弧書きで接続コマンドを書く**
   * 決まりで、チップに出す値からは括弧ごと落としている（`cleanWhereValue`）。
   *
   * 代行実行が失敗して自分で実行するとき、いちばん分からないのが「どこから実行するのか」
   * （#1882）。**本文に書かれたものだけを拾い、ホスト名から組み立てたりしない**——
   * 推測した接続先を出すと、それが正しいかを確かめる手間が増える。
   */
  connect: string | null;
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
  /**
   * `## 完了の確認方法`が本文のどこにあるか（1始まりの行番号。`end`はその節の最終行）。
   *
   * 確認節のコマンドも代行実行できるようにするため（#1869）、**節の中身ではなく位置**を返す。
   * `verification`は`blockMarkdown`でインデントと前後の空行を落とした後の文字列なので、
   * そこから本文の行番号へ戻せない。実行するコマンドの取り出しは本文の生の行を見る
   * （`lib/manual-step-command.ts`の`extractVerificationCommands`）。
   */
  verificationRange: { start: number; end: number } | null;
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

/**
 * 見出しで区切った1節。
 *
 * `heading`は見出しの文言そのまま（本文の先頭など、見出しの下でない節は`null`）。
 * `key`が`null`でも`heading`は残す——本文の書式検査（`manual-step-body-check.ts`）は
 * `## 関連`のように`SECTION_MATCHERS`に無い見出しも見る必要があるため。
 */
export type ManualStepSection = {
  key: SectionKey | null;
  heading: string | null;
  level: number;
  lines: string[];
  startLine: number;
};

type Section = ManualStepSection;

/**
 * 本文を見出しで区切る。**コードフェンスの中の`#`は見出しにしない**——コピペ用コマンドの
 * `# コメント`を見出しとして取ると、そこで節が切れる。
 *
 * @returns 各節。`startLine`はその節の1行目の本文中の行番号（1始まり）
 */
export function splitManualStepSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section = { key: null, heading: null, level: 0, lines: [], startLine: 1 };
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
    current = {
      key: matchSectionKey(heading[2]),
      heading: heading[2].trim(),
      level: heading[1].length,
      lines: [],
      startLine: index + 2,
    };
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
  const where: ManualStepGuideWhere = {
    device: null,
    defaultDevice: null,
    directory: null,
    branch: null,
    connect: null,
  };
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
    if (where.device === null && label.includes("デバイス")) {
      where.device = value;
      where.connect = extractConnectCommand(item[1].slice(separator.index + 1));
    }
    else if (where.directory === null && label.includes("ディレクトリ")) where.directory = value;
    else if (where.branch === null && label.includes("ブランチ")) where.branch = value;
  }

  // 端末が2つ以上書かれていたら既定値は決まらない（#2052）。0個・1個のときは書かれた値を
  // そのまま既定値にする——`本番VPS`のような書き方を、正式名へ丸めずチップにも理由文にも出す
  where.defaultDevice = matchManualStepDeviceNames(where.device).length >= 2 ? null : where.device;

  return where;
}

/**
 * 手順の文頭に置かれたデバイスの印（`（サブPC）`）。半角括弧・角括弧も受ける。
 *
 * **中身が端末の名前1つに読めるときだけ**デバイスとして扱う。`（任意）`や`（初回のみ）`のような
 * 別の注記を巻き込まないための条件で、読めなければ印そのものが無かったことにする（既定値へ落ちる）。
 */
const STEP_DEVICE_PATTERN = /^[（(［[]\s*([^）)］\]\n]+?)\s*[）)］\]]/;

/** @returns `[デバイス名, 印の文字数]`。デバイスとして読めなければ`[null, 0]` */
function parseStepDevice(head: string): [string | null, number] {
  const leading = /^[*`\s]*/.exec(head)?.[0].length ?? 0;
  const match = STEP_DEVICE_PATTERN.exec(head.slice(leading));
  if (!match) return [null, 0];
  const names = matchManualStepDeviceNames(match[1]);
  if (names.length !== 1) return [null, 0];
  return [names[0], leading + match[0].length];
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

/**
 * 「実行するデバイス」の行から接続コマンドを拾う（#1882）。
 *
 * **コードスパン（`` `ssh subpc` ``）を優先する。** テンプレートがそう書く決まりで、
 * 書き手が「これがコマンド」と印を付けたものだから。印が無い場合だけ、素の`ssh …`を拾う。
 * どちらも無ければ`null`（接続の案内そのものを出さない）。
 */
function extractConnectCommand(raw: string): string | null {
  for (const match of raw.matchAll(/`([^`]+)`/g)) {
    const command = match[1].trim();
    if (command !== "") return command;
  }
  const bare = /\bssh\s+[\w.@-]+(?:\s+[\w.@/-]+)?/.exec(raw);
  return bare === null ? null : bare[0].trim();
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
      steps: [
        { line: null, checked: false, markdown, text: firstLineText(markdown), device: null },
      ],
    };
  }

  const introText = blockMarkdown(section.lines.slice(0, marks[0].index));
  const steps = marks.map((mark, order) => {
    const end = order + 1 < marks.length ? marks[order + 1].index : section.lines.length;
    const head = section.lines[mark.index].replace(TASK_LINE_PATTERN, "").trim();
    const rest = blockMarkdown(section.lines.slice(mark.index + 1, end), mark.indent);
    const markdown = rest === "" ? head : `${head}\n\n${rest}`;
    const [device, marker] = parseStepDevice(head);
    return {
      line: section.startLine + mark.index,
      checked: mark.checked,
      markdown,
      text: normalizeInline(head.slice(marker)),
      device,
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
    where: { device: null, defaultDevice: null, directory: null, branch: null, connect: null },
    todoIntro: null,
    steps: [],
    verification: null,
    verificationRange: null,
  };
  if (!body || body.trim() === "") return empty;

  const sections = splitManualStepSections(body);
  const todo = findSection(sections, "todo");
  const parsed = todo ? parseSteps(todo) : { intro: null, steps: [] };
  const verification = findSection(sections, "verification");

  return {
    hasTemplate: parsed.steps.length > 0,
    outcome: sectionText(findSection(sections, "outcome")),
    where: parseManualStepWhere(findSection(sections, "prerequisites")),
    todoIntro: parsed.intro,
    steps: parsed.steps,
    verification: sectionText(verification),
    verificationRange: sectionRange(verification),
  };
}

/** 節が本文のどこにあるか（1始まり）。中身が無ければ`null` */
function sectionRange(section: Section | null): { start: number; end: number } | null {
  if (!section || section.lines.length === 0) return null;
  return { start: section.startLine, end: section.startLine + section.lines.length - 1 };
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
