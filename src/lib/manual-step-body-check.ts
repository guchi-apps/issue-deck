import { collectShellBlocks } from "@/lib/manual-step-command";
import { parseManualStepGuide, splitManualStepSections } from "@/lib/manual-step-guide";
import { FENCE_PATTERN } from "@/lib/markdown-task-list";

/**
 * 手作業Issueの本文が、画面（手作業アシスタント）の読み方に合っているかを検査する（#2048）。
 *
 * **書式の揺れは見た目の問題ではなく、機能が黙って落ちる問題である。** 実測でopenだった3件
 * （guchi-apps/aide#103・asset-manager#210・car-care#99）は、太字の有無・コードブロックの
 * インデント・参照の書き方が3通りに割れていた。うち2件は`## 関連`の対応PRをURLで書いており、
 * `manual-step-prerequisites.ts`の参照抽出（`owner/repo#123`形式）から丸ごと落ちていた。
 *
 * **検査するのは画面が実際に使う項目だけにする。** 「テンプレートと文字が違う」を全部指摘すると
 * 読まれなくなる。ここに1つ足すときは、崩れたときにどの機能が落ちるかを言えることを条件にする。
 *
 * **プレースホルダ（`<控えたkey>`）は規則にしない**（#2051で判断した）。値を人が埋める手順は
 * 本来そう書くしかなく、崩れているわけではない。指摘にすると直しようのない指摘が正しい本文へ
 * 出続ける。代行実行から外す判定は`findPlaceholder`（`manual-step-command.ts`）が持つ。
 *
 * **判定はパーサーと同じ関数を通す**（`parseManualStepGuide`・`splitManualStepSections`・
 * `collectShellBlocks`）。別実装で書き直すと、検査を通った本文を画面が読めない・その逆、
 * という食い違いが必ず出る。
 *
 * **ここは指摘を返すだけで、ラベルもゲートも持たない。** 手作業Issueに`00.check-user`を
 * 付けない規約（docs/multi-agent/labels.md）があり、起票を止める仕組みでもないため。
 */

/** 指摘の重さ。`error`は画面の機能が落ちるもの、`warning`は揃っていないが落ちないもの */
export type ManualStepBodyFindingSeverity = "error" | "warning";

export type ManualStepBodyFinding = {
  /** 規則の識別子。コメントの重複判定やテストで使う */
  rule: string;
  severity: ManualStepBodyFindingSeverity;
  /** 何が崩れているか。**直し方まで含めて1文で書く** */
  message: string;
};

/**
 * `## `の見出しと、その順序。
 *
 * 照合は`parseManualStepGuide`の`SECTION_MATCHERS`と同じく**部分一致**にする
 * （`## やること（サブPC）`のように補足が付く書き方が実際にあるため）。
 */
const REQUIRED_HEADINGS = [
  { label: "## この作業でできるようになること", needles: ["できるようになること"] },
  { label: "## 前提条件", needles: ["前提条件"] },
  { label: "## やること", needles: ["やること", "手順"] },
  { label: "## 完了の確認方法", needles: ["完了の確認方法", "確認方法"] },
  { label: "## なぜエージェントが実施しないか", needles: ["エージェントが実施しない"] },
  { label: "## 関連", needles: ["関連"] },
] as const;

/**
 * `## 前提条件`に要る項目。`needles`は`parseManualStepWhere`の`label.includes(...)`と揃える。
 *
 * デバイス・ディレクトリ・ブランチは画面のチップと代行実行の可否に直結するので`error`、
 * 残り2つは欠けても画面は動くので`warning`にしている。
 */
const REQUIRED_PREREQUISITES = [
  { label: "実行するデバイス", needles: ["デバイス"], severity: "error" },
  { label: "カレントディレクトリ", needles: ["ディレクトリ"], severity: "error" },
  { label: "Gitブランチ", needles: ["ブランチ"], severity: "error" },
  { label: "先に完了している必要があるIssue・PR", needles: ["先に完了", "必要があるissue"], severity: "warning" },
  { label: "その他の前提", needles: ["その他"], severity: "warning" },
] as const satisfies readonly {
  label: string;
  needles: readonly string[];
  severity: ManualStepBodyFindingSeverity;
}[];

/** 「実行するデバイス」に1つだけ書かれているべき端末の名前 */
const DEVICE_NAMES = [
  { label: "サブPC", needles: ["サブpc", "subpc"] },
  { label: "メインPC", needles: ["メインpc", "mainpc"] },
  { label: "VPS", needles: ["vps"] },
  { label: "ブラウザ", needles: ["ブラウザ"] },
] as const;

/** `https://github.com/<owner>/<repo>/(issues|pull)/<番号>` */
const GITHUB_REFERENCE_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** 照合用に、装飾と空白を落として小文字へ寄せる */
function normalize(text: string): string {
  return text.replace(/[\s　*`_]/g, "").toLowerCase();
}

export function checkManualStepBody(
  body: string | null | undefined,
  options: { repositoryFullName?: string } = {},
): ManualStepBodyFinding[] {
  if (!body || body.trim() === "") {
    return [{ rule: "empty-body", severity: "error", message: "本文が空です。雛形（docs/multi-agent/manual-step-body-template.md）を埋めてください。" }];
  }

  const findings: ManualStepBodyFinding[] = [];
  const sections = splitManualStepSections(body);
  const guide = parseManualStepGuide(body);

  findings.push(...checkHeadings(sections));
  findings.push(...checkPrerequisites(sections));
  findings.push(...checkDevice(guide.where.device));
  findings.push(...checkTodo(sections, guide));
  findings.push(...checkRelatedReferences(sections, options.repositoryFullName));

  return findings;
}

/** 6つの見出しが規定の順で揃っているか */
function checkHeadings(sections: ReturnType<typeof splitManualStepSections>): ManualStepBodyFinding[] {
  const headings = sections
    .map((section) => section.heading)
    .filter((heading): heading is string => heading !== null)
    .map(normalize);

  const missing: string[] = [];
  // 文書に現れる順で貪欲に消し込む。残ったものが「不足」、消せたが順番が前後したものが「順序違い」
  let cursor = 0;
  let outOfOrder = false;
  for (const required of REQUIRED_HEADINGS) {
    const matches = (heading: string) => required.needles.some((needle) => heading.includes(needle));
    const at = headings.findIndex(matches);
    if (at === -1) {
      missing.push(required.label);
      continue;
    }
    if (at < cursor) outOfOrder = true;
    cursor = at;
  }

  const findings: ManualStepBodyFinding[] = [];
  if (missing.length > 0) {
    findings.push({
      rule: "missing-heading",
      severity: "error",
      message: `見出しが足りません: ${missing.join("・")}。画面はこの見出しで本文を節に割るため、無い節はそのまま欠けます。`,
    });
  }
  if (outOfOrder) {
    findings.push({
      rule: "heading-order",
      severity: "warning",
      message: `見出しの順が雛形と違います。${REQUIRED_HEADINGS.map((heading) => heading.label.replace("## ", "")).join(" → ")} の順にしてください。`,
    });
  }
  return findings;
}

/** `## 前提条件`の5項目が「ラベル: 値」の1行として読めるか */
function checkPrerequisites(
  sections: ReturnType<typeof splitManualStepSections>,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => entry.key === "prerequisites");
  if (!section) return [];

  const labels: string[] = [];
  const wrapped: string[] = [];
  let previousLabel: string | null = null;
  let openFence: string | null = null;

  for (const line of section.lines) {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      previousLabel = null;
      continue;
    }
    if (openFence !== null) continue;

    const item = LIST_ITEM.exec(line);
    if (item) {
      const separator = /[:：]/.exec(item[1]);
      previousLabel = separator ? normalize(item[1].slice(0, separator.index)) : null;
      if (previousLabel) labels.push(previousLabel);
      continue;
    }
    if (line.trim() === "" || HEADING.test(line)) {
      previousLabel = null;
      continue;
    }
    // リスト項目でも空行でもない行が項目の直後に続いている＝値の折り返し。
    // `parseManualStepWhere`は行単位でしか読まないため、続きは値に入らない
    if (previousLabel !== null) {
      wrapped.push(previousLabel);
      previousLabel = null;
    }
  }

  const findings: ManualStepBodyFinding[] = [];
  for (const required of REQUIRED_PREREQUISITES) {
    if (labels.some((label) => required.needles.some((needle) => label.includes(needle)))) continue;
    findings.push({
      rule: "missing-prerequisite",
      severity: required.severity,
      message: `\`## 前提条件\`に「${required.label}」の行がありません。\`- ${required.label}: …\`の形で1行足してください。`,
    });
  }
  if (wrapped.length > 0) {
    findings.push({
      rule: "wrapped-prerequisite",
      severity: "warning",
      message: "`## 前提条件`の項目が次の行へ折り返しています。続きの行は項目として読まれず値が途中で切れるため、1項目は1行に収めてください。",
    });
  }
  return findings;
}

/** 「実行するデバイス」に端末が1つだけ書かれているか */
function checkDevice(device: string | null): ManualStepBodyFinding[] {
  if (device === null) return [];
  const normalized = normalize(device);
  const found = DEVICE_NAMES.filter((entry) =>
    entry.needles.some((needle) => normalized.includes(needle)),
  );
  if (found.length < 2) return [];
  return [
    {
      rule: "multiple-devices",
      severity: "warning",
      message: `「実行するデバイス」に端末が複数書かれています（${found.map((entry) => entry.label).join("・")}）。この値はそのまま画面のチップに出るため1つだけにし、どの端末で何をするかは\`## やること\`の各手順の文頭に書いてください。`,
    },
  ];
}

/** `## やること`がチェックリストで割れているか・1手順のコードブロックが1つか */
function checkTodo(
  sections: ReturnType<typeof splitManualStepSections>,
  guide: ReturnType<typeof parseManualStepGuide>,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => entry.key === "todo");
  if (!section) return [];

  const findings: ManualStepBodyFinding[] = [];
  const hasChecklist = section.lines.some((line) => /^\s*[-*+]\s+\[[ xX]\]/.test(line));
  if (!hasChecklist) {
    // チェックリストが無い本文は節ごと1ステップになる（docs/multi-agent/labels.md）。
    // コードブロックが2つ以上あるなら、手順が2つ以上あるのに割れていないと分かる
    if (collectShellBlocks(section.lines.join("\n")).length >= 2) {
      findings.push({
        rule: "todo-not-checklist",
        severity: "warning",
        message: "`## やること`が`- [ ]`のチェックリストで割れていません。手順が2つ以上あるときは1手順＝1項目にしないと、画面では節まるごとが1ステップになり、途中まで進めた記録も残せません。",
      });
    }
    return findings;
  }

  const crowded = guide.steps.filter((step) => collectShellBlocks(step.markdown).length >= 2);
  if (crowded.length > 0) {
    findings.push({
      rule: "multiple-blocks-in-step",
      severity: "error",
      message: `1つの手順にコードブロックが2つ以上あります（${crowded.length}件）。「どれを実行したのか」がチェック1つに対応しないため、その手順は代行実行の対象から外れます。手順を分けるか、1つのブロックにまとめてください。`,
    });
  }
  return findings;
}

/** `## 関連`の参照が`#番号`形式か（URLは参照抽出に一致しない） */
function checkRelatedReferences(
  sections: ReturnType<typeof splitManualStepSections>,
  repositoryFullName?: string,
): ManualStepBodyFinding[] {
  const section = sections.find((entry) => normalize(entry.heading ?? "").includes("関連"));
  if (!section) return [];

  const urls: string[] = [];
  for (const line of section.lines) {
    // 同じ行に`#番号`があるなら参照は拾えている。URLは補足として置かれているだけ
    if (/(?:[\w.-]+\/[\w.-]+)?#\d+/.test(line)) continue;
    for (const match of line.matchAll(GITHUB_REFERENCE_URL)) {
      const [, owner, repo, number] = match;
      const full = `${owner}/${repo}`;
      urls.push(full === repositoryFullName ? `#${number}` : `${full}#${number}`);
    }
  }
  if (urls.length === 0) return [];

  return [
    {
      rule: "reference-not-hash-form",
      severity: "error",
      message: `\`## 関連\`の参照がURLで書かれています。\`manual-step-prerequisites.ts\`の参照抽出は\`#番号\`（別リポジトリは\`owner/repo#番号\`）にしか一致せず、実施順序の表示から落ちます。${urls.join("・")} と書き換えてください。`,
    },
  ];
}

/**
 * 指摘をIssueコメントの本文へ組み立てる。
 *
 * **文面をここに置くのは、規則と直し方が同じ場所にあるほうが古びないため。** ワークフロー側の
 * YAMLで組み立てると、規則を足したときに文面だけ取り残される。
 *
 * 先頭のマーカーで、次に本文が編集されたときに同じコメントを見つけて更新・削除する
 * （`reusable-issue-labels.yml`の`manual-step-body-check`ジョブ）。
 */
export const MANUAL_STEP_BODY_CHECK_MARKER = "<!-- issue-deck-source:manual-step-body-check -->";

const TEMPLATE_LINK =
  "https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/manual-step-body-template.md";

export function renderManualStepBodyCheckComment(
  findings: ManualStepBodyFinding[],
): string | null {
  if (findings.length === 0) return null;

  // errorを先に出す。画面の機能が落ちているものから直してほしい
  const ordered = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );

  return [
    MANUAL_STEP_BODY_CHECK_MARKER,
    "⚠️ 本文の書式が、issue-deckの手作業アシスタントが読む形から外れています。**このIssueの起票を止めるものではありません**が、直さないと下記の機能がそのIssueでは働きません。",
    "",
    ...ordered.map((finding) => `- ${finding.severity === "error" ? "❌" : "⚠️"} ${finding.message}`),
    "",
    `本文を編集するとこのコメントは自動で更新され、指摘が無くなれば消えます。雛形は [manual-step-body-template.md](${TEMPLATE_LINK}) にあります。`,
  ].join("\n");
}
