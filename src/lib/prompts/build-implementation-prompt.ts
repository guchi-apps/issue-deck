import {
  ARTIFACT_REQUIRED_LABEL,
  PREVIEW_REQUIRED_LABEL,
  SCREENSHOT_REQUIRED_LABEL,
} from "@/lib/github/start-implementation";
import { GENERIC_IMPLEMENTATION_AGENT_TEMPLATE } from "@/lib/prompts/templates.generated";

/**
 * 画面の「実装プロンプトをコピー」が渡す文面を組み立てる（#1263）。
 *
 * 「このPC」（`issuedeck://`でWSLのセッションを丸ごと立ち上げる経路）を廃止した代わりの導線。
 * **手元でVS Codeを既に開いている状況では、新しいセッションを立てるのではなく、開いている
 * セッションへ貼れる文面が要る。**
 *
 * **文面の正はサブPCのランチャーと同じ`scripts/prompts/generic-implementation-agent.md`**で、
 * `scripts/generate-prompt-templates.mjs`がTSへ書き出したものを読む。2か所に分けると必ず
 * 片方が古くなる（`local-repo-resolve.sh`・`env-file-sync.sh`と同じ理由）。ずれていないことは
 * `templates.test.ts`が検証する。
 *
 * ランチャー経路との違いは、**起動しないと決まらない値が無いこと**。worktree・ベースブランチ・
 * パッケージマネージャ・開発サーバーのポートは貼る側が用意するので、プレースホルダを残さず
 * その旨に差し替える。
 */

/** 起動しないと決まらない値の差し替え文言。プレースホルダのまま残すと指示として読めてしまう */
const PROVIDED_BY_SESSION = "（貼り付け先のセッションで用意してください）";

/**
 * 並行状況（#1267）。**ブラウザからはgitもghも叩けない**ので、ここでは埋められない。
 * 黙って空にすると「並行しているものは無い」と読まれるため、取得していないことを明示する。
 */
const CONCURRENT_WORK_UNAVAILABLE = [
  "（この文面はブラウザからコピーされたものなので、並行状況は取得できていません）",
  "",
  "着手前に自分で確認してください。",
  "",
  "```bash",
  "git fetch origin && git log --oneline -5 origin/develop   # developの先端",
  "gh pr list --repo {{REPOSITORY}} --base develop --state open   # 未マージPR",
  "tmux list-sessions   # 同じホストで走っている他セッション",
  "```",
].join("\n");

/**
 * 冒頭に足す但し書き。テンプレート本体は「ランチャーが起動した」前提で書かれているため、
 * **何が済んでいて何が済んでいないか**をここで明示しないと、worktreeが既にあるものとして
 * 進んでしまう。
 */
function preamble(repositoryFullName: string, issueNumber: number): string {
  return [
    "> **この文面はissue-deckの画面からコピーされたものです。**",
    ">",
    "> - **済んでいること**: `11.local`ラベルの付与と進捗（Project Status）の報告",
    "> - **済んでいないこと**: worktreeの作成・ブランチの作成・依存インストール・開発サーバーの起動",
    ">",
    `> 作業を始める前に、\`issue-${issueNumber}\`ブランチを作るところから自分で行ってください。`,
    `> 以下の本文・コメントはコピーした時点のスナップショットです（最新は \`gh issue view ${issueNumber} --repo ${repositoryFullName} --comments\`）。`,
    "",
  ].join("\n");
}

function previewInstructions(labelNames: ReadonlySet<string>): string {
  if (labelNames.has(PREVIEW_REQUIRED_LABEL)) {
    return [
      `このIssueには\`${PREVIEW_REQUIRED_LABEL}\`ラベルが付いています。実装・テストが完了したら、PRを作成する**前**に次の手順を行ってください。`,
      "",
      "1. 開発サーバーを起動し、実際の画面を確認する",
      "2. 確認した画面・操作手順をユーザーに提示し、問題ないか明示的な承認を得る",
      "3. 承認が得られてから初めてPRを作成する",
    ].join("\n");
  }
  return [
    "画面に関わる変更を行った場合、PR本文の「確認方法」に次の情報を含めてください。",
    "",
    "- 開発サーバーのアクセスURL",
    "- 実際に確認すべき画面・操作手順",
    "",
    "承認待ちで止まる必要はなく、そのままPR作成まで進めてよいです。",
  ].join("\n");
}

function screenshotInstructions(labelNames: ReadonlySet<string>): string {
  if (labelNames.has(SCREENSHOT_REQUIRED_LABEL)) {
    return `このIssueには\`${SCREENSHOT_REQUIRED_LABEL}\`ラベルが付いています。実装・テストが完了したら、PRを作成する**前**に変更箇所のスクリーンショットを取得し、ユーザーの承認を得てからPRを作成してください（新規依存関係の追加が必要な場合は、追加前に必ず確認する）。`;
  }
  return `このIssueには\`${SCREENSHOT_REQUIRED_LABEL}\`ラベルが付いていないため、Playwright等によるスクリーンショットの自動取得は不要です（トークン消費が大きいため）。`;
}

/**
 * 見た目のアーティファクト（#1473・#1540）。
 *
 * **出すのは実装着手前**（#1540）。実装・テストが済んでから見せる形だと、見た目がNGだったときに
 * 実装がまるごとやり直しになる。アーティファクトの効きどころは「作る前に見た目を合意する」ことなので、
 * ゲートをPR作成前から実装着手前へ移した。実装後の見た目は`23.preview-required`（実物）が受け持つ。
 *
 * **画面デザインはPC・スマホ（iPhone 15）の2画面を並べて出す**（#1632）。PCの見た目だけを承認しても
 * スマホ幅での崩れは実装後の実画面まで分からず、「作る前に見た目を合意する」効きどころが半分になる。
 * ラベルの有無によらない原則なので、ラベルが無いときの文面にも但し書きとして入れている。
 *
 * **同じ文面が`scripts/start-issue.sh`・`scripts/generic-start-issue.sh`にもある。**
 * 起動経路によって指示が変わらないよう、変えるときは3か所そろえる
 * （`scripts/lib/agent-language.sh`と同じ構造）。
 */
function artifactInstructions(labelNames: ReadonlySet<string>): string {
  if (labelNames.has(ARTIFACT_REQUIRED_LABEL)) {
    return [
      `このIssueには\`${ARTIFACT_REQUIRED_LABEL}\`ラベルが付いています。**コードを書き始める前に**、変更する画面の見た目を自己完結HTMLのアーティファクトとして公開し、URLを提示して見た目の承認を得てから実装に入ってください。`,
      "",
      "- **画面デザインは原則PC・スマホの2画面を並べて提示してください**（#1632）。1つのアーティファクトの中に、PC（デスクトップ幅）と**スマホ（iPhone 15 = 幅393px × 高さ852px）**の両方の見た目を並べます。どちらか一方だけにする場合は、その理由をアーティファクト本文に書いてください",
      "- **アーティファクトは実装前の見た目案であって実物ではありません。** 承認の意味は「この見た目で作ってよい」までで、実装が正しいことの確認にはなりません。実装後の見た目は開発サーバーの実画面で確かめてください。この但し書きはアーティファクト本文の先頭にも書きます",
      "- `21.plan-required`が併用されている場合は、**Plan modeに入る前に公開**し、URLを計画本文へ含めてください（Plan modeではファイルを書けないためアーティファクトを作れません）。計画と見た目を1回のやり取りで承認できます",
      "- `21.plan-required`が付いていない場合は、アーティファクトの提示そのものが承認ゲートです。承認可否は`AskUserQuestion`で尋ね（フックが自動で`00.check-user`を付け、答えた時点で外れます。#1417）、URLはIssueコメントにも残してください",
      "- 実装後にPR本文へURLを貼る必要はありません。出来上がった画面の確認は開発サーバー（`23.preview-required`）の役割です",
      "- アーティファクトは既定で非公開です。共有するかどうかを決めるのはユーザーです",
      "- 開発サーバーのURLと違い、セッションが終了した後も残ります。スマホなど別端末からの確認に向きます",
      "- アーティファクトを作れるのはローカルセッションだけです（無人実行では作成できません）",
    ].join("\n");
  }
  return [
    `このIssueには\`${ARTIFACT_REQUIRED_LABEL}\`ラベルが付いていないため、見た目のアーティファクトの作成は不要です。`,
    "ただし、ユーザーの求めなどで画面デザインをアーティファクトとして出す場合は、**PC（デスクトップ幅）とスマホ（iPhone 15 = 幅393px × 高さ852px）の2画面を1つのアーティファクトに並べて提示してください**（#1632）。",
  ].join("");
}

/** ランチャー（`generic-start-issue.sh`）が組み立てているコメント欄と同じ書式にそろえる */
function formatComments(
  comments: readonly { author: { login: string }; createdAtLabel: string; body: string }[],
): string {
  if (comments.length === 0) return "(コメントなし)";
  return comments
    .map((comment) => `- ${comment.author.login} (${comment.createdAtLabel}):\n${comment.body}`)
    .join("\n\n");
}

/**
 * 親子Issueの一覧（#1267）。**子Issueを起こしたときに親の背景が丸ごと落ちる**のを防ぐ。
 * 取得できていない場合は、無いのか取っていないのかが分かる文言にする。
 */
function formatRelations(
  relations: readonly { number: number; title: string; state: string; relation: "parent" | "sub" }[] | undefined,
): string {
  if (relations === undefined) return "（この経路では取得していません）";
  if (relations.length === 0) return "(親子関係のあるIssueはありません)";
  return relations
    .map(
      (relation) =>
        `- ${relation.relation === "parent" ? "親" : "子"}: #${relation.number} ${relation.title}（${relation.state}）`,
    )
    .join("\n");
}

export function buildImplementationPrompt(params: {
  repositoryFullName: string;
  issueNumber: number;
  title: string;
  body: string | null;
  labels: readonly { name: string }[];
  comments: readonly { author: { login: string }; createdAtLabel: string; body: string }[];
  /** 親子Issue（#1267）。省略すると「取得していません」と出す */
  relations?: readonly { number: number; title: string; state: string; relation: "parent" | "sub" }[];
}): string {
  const { repositoryFullName, issueNumber, title, body, labels, comments, relations } = params;
  const labelNames = new Set(labels.map((label) => label.name));

  const replacements: Record<string, string> = {
    "{{REPOSITORY}}": repositoryFullName,
    "{{ISSUE_NUMBER}}": String(issueNumber),
    "{{ISSUE_TITLE}}": title,
    "{{ISSUE_LABELS}}": [...labelNames].sort().join(", ") || "(なし)",
    "{{ISSUE_BODY}}": body?.trim() ? body : "(本文なし)",
    "{{ISSUE_COMMENTS}}": formatComments(comments),
    "{{ISSUE_RELATIONS}}": formatRelations(relations),
    "{{CONCURRENT_WORK}}": CONCURRENT_WORK_UNAVAILABLE.split("{{REPOSITORY}}").join(
      repositoryFullName,
    ),
    "{{WORKTREE_DIR}}": PROVIDED_BY_SESSION,
    "{{BASE_BRANCH}}": PROVIDED_BY_SESSION,
    "{{PACKAGE_MANAGER}}": PROVIDED_BY_SESSION,
    "{{DEV_COMMAND}}": PROVIDED_BY_SESSION,
    "{{DEV_PORT}}": PROVIDED_BY_SESSION,
    "{{PREVIEW_INSTRUCTIONS}}": previewInstructions(labelNames),
    "{{SCREENSHOT_INSTRUCTIONS}}": screenshotInstructions(labelNames),
    "{{ARTIFACT_INSTRUCTIONS}}": artifactInstructions(labelNames),
  };

  const filled = Object.entries(replacements).reduce(
    (text, [placeholder, value]) => text.split(placeholder).join(value),
    GENERIC_IMPLEMENTATION_AGENT_TEMPLATE,
  );

  return `${preamble(repositoryFullName, issueNumber)}\n${filled}`;
}
