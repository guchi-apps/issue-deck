import {
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

/** ランチャー（`generic-start-issue.sh`）が組み立てているコメント欄と同じ書式にそろえる */
function formatComments(
  comments: readonly { author: { login: string }; createdAtLabel: string; body: string }[],
): string {
  if (comments.length === 0) return "(コメントなし)";
  return comments
    .map((comment) => `- ${comment.author.login} (${comment.createdAtLabel}):\n${comment.body}`)
    .join("\n\n");
}

export function buildImplementationPrompt(params: {
  repositoryFullName: string;
  issueNumber: number;
  title: string;
  body: string | null;
  labels: readonly { name: string }[];
  comments: readonly { author: { login: string }; createdAtLabel: string; body: string }[];
}): string {
  const { repositoryFullName, issueNumber, title, body, labels, comments } = params;
  const labelNames = new Set(labels.map((label) => label.name));

  const replacements: Record<string, string> = {
    "{{REPOSITORY}}": repositoryFullName,
    "{{ISSUE_NUMBER}}": String(issueNumber),
    "{{ISSUE_TITLE}}": title,
    "{{ISSUE_LABELS}}": [...labelNames].sort().join(", ") || "(なし)",
    "{{ISSUE_BODY}}": body?.trim() ? body : "(本文なし)",
    "{{ISSUE_COMMENTS}}": formatComments(comments),
    "{{WORKTREE_DIR}}": PROVIDED_BY_SESSION,
    "{{BASE_BRANCH}}": PROVIDED_BY_SESSION,
    "{{PACKAGE_MANAGER}}": PROVIDED_BY_SESSION,
    "{{DEV_COMMAND}}": PROVIDED_BY_SESSION,
    "{{DEV_PORT}}": PROVIDED_BY_SESSION,
    "{{PREVIEW_INSTRUCTIONS}}": previewInstructions(labelNames),
    "{{SCREENSHOT_INSTRUCTIONS}}": screenshotInstructions(labelNames),
  };

  const filled = Object.entries(replacements).reduce(
    (text, [placeholder, value]) => text.split(placeholder).join(value),
    GENERIC_IMPLEMENTATION_AGENT_TEMPLATE,
  );

  return `${preamble(repositoryFullName, issueNumber)}\n${filled}`;
}
