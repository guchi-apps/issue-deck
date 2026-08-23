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

/**
 * 全アプリ共通の共有知識リポジトリ（#1741）。
 *
 * **実装対象がこのリポジトリ自身のときは文面ごと差し替える。** 既定の文面は「共有知識は
 * 読み取り専用」と書いており、そのリポジトリを実装する回では指示が自己矛盾する。
 *
 * **ここだけはリポジトリ名で判定する。** ランチャー（`scripts/generic-start-issue.sh`）は
 * チェックアウト先と共有知識ディレクトリのパス一致（`-ef`）で判定できるが、この経路は
 * ブラウザから来るため貼り付け先のローカルパスが分からない。
 */
const SHARED_CONTEXT_REPOSITORY = "guchi-apps/docs";
const SHARED_CONTEXT_DIR = "~/apps/_docs";

function sharedContextInstructions(repositoryFullName: string): string {
  if (repositoryFullName === SHARED_CONTEXT_REPOSITORY) {
    return [
      `**このリポジトリ自身が全アプリ共通の共有知識リポジトリです**（\`${SHARED_CONTEXT_DIR}\` = \`${SHARED_CONTEXT_REPOSITORY}\`）。読むのも書くのも、**このセッションの作業ツリーの中のファイル**です。`,
      "",
      `- \`${SHARED_CONTEXT_DIR}\` は同じリポジトリの**本体チェックアウト**で、他のセッションが実行中に読んでいます。**そちらは編集しないでください**（貼り付け先が本体チェックアウトそのものの場合は、先にworktreeを作ってください）`,
      "- 索引は作業ツリー内の `CLAUDE.md`、実装エージェント向けの共通ルールは `agent-rules/implementation.md` です",
      "- 後述「実装中に得た知見の記録」にある「共有知識リポジトリへ反映できません」は、**実装対象がこのリポジトリ自身である今回は当てはまりません**",
    ].join("\n");
  }
  return [
    `このセッションで共有知識リポジトリ（\`${SHARED_CONTEXT_DIR}\` = \`${SHARED_CONTEXT_REPOSITORY}\`）をローカルにcloneしてある場合は、実装の前提として必要な範囲だけ読んでください。`,
    "",
    `- \`${SHARED_CONTEXT_DIR}/CLAUDE.md\` — 共有知識の索引・読む順序`,
    `- \`${SHARED_CONTEXT_DIR}/agent-rules/implementation.md\` — 実装エージェントの共通ルール`,
    `- \`${SHARED_CONTEXT_DIR}/knowledge/\` — 今回触る領域（GitHub Actions・デプロイ・認証・DB等）に対応するファイルがあれば着手前に読む`,
    "",
    "共有知識リポジトリのファイルは**読み取り専用**として扱い、編集・コミットは行わないでください。内容が対象リポジトリの `CLAUDE.md` / `docs/` と矛盾する場合は、対象リポジトリ側を優先します。",
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
 * **計画レビューで見た目が変わったときの差し替え手順もここに書く**（#2110）。手順そのものは#1745で
 * 決めて`docs/multi-agent/labels.md`に書いてあるが、汎用ランチャーで起動した他リポジトリの
 * セッションからissue-deckの`docs/`は読めず、実際に手順が届かずに止まった（guchi-apps/myroom#109）。
 * 運用の決め事はプロンプトへ写して初めてエージェントに届く。
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
      "- `21.plan-required`が併用されている場合は、**Plan modeに入る前に公開**し、URLを計画本文へ含めてください（Plan modeで書けるのは計画ファイルだけなので、最初の1枚はPlan modeへ入る前に作ります）。計画と見た目を1回のやり取りで承認できます",
      "- 計画本文へURLを載せるときは、`アーティファクト: <URL>（計画のやり取りで見た目が変わった場合は、承認後・コードを書く前に同じURLへ差し替えます）`のように**差し替えがあり得ることも添えて**ください。計画レビューで見た目が変わるのは正常な流れで、断りが無いと古い版のURLが承認済みの記録として残ります",
      "- **計画のやり取りで見た目の直しを求められたら、計画ファイルの中で差し替えます**（#2200）。Plan modeで書けるのはやはり計画ファイルだけですが、**その中に置いたHTMLはissue-deckが取り出して「アーティファクト」カードへ取り込みます。**「Plan modeでは差し替えられません」と答えて先送りしないでください。手順は4つです。(1) 計画ファイルの末尾に`## アーティファクト`の見出しを作る (2) その下に`<!-- artifact: <最初に公開したHTMLファイルの絶対パス> -->`を1行置く (3) 続けて**バッククォート4つ＋`artifact`**で開くフェンス（閉じも同じ数）にHTML全文を入れる (4) `ExitPlanMode`で計画を出し直す。パスを公開時と同じにすると同じカードが差し替わり、計画コメントにHTMLは載りません",
      "- 承認の直後、コードを書く前に**最初と同じファイルパス**へそのHTMLを書き、`Artifact`を呼び直して再公開してください。**差し替わるのは先にissue-deckのカードだけで、claude.aiのURLはこの再公開までは修正前の見た目のままです。** パスが同じなら同じURLへ再デプロイされるため、計画コメントに残ったリンクもそのまま新しい見た目を指すようになります。**パスが1文字でも違うとカードが2枚に増えます**",
      "- **見た目の直しだけを再承認させるゲートは足しません**（#1745）。直しは計画の「修正を送る」の1往復に相乗りさせ、承認は1回に保ちます",
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
    "Plan modeの最中に見た目の直しを求められた場合も、計画ファイルの末尾へ`<!-- artifact: <HTMLファイルの絶対パス> -->`とHTML全文（バッククォート4つ＋`artifact`のフェンス）を置いて計画を出し直せば、issue-deckが「アーティファクト」カードへ取り込みます（#2200）。",
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

type PromptRelation = {
  number: number;
  title: string;
  state: string;
  relation: "parent" | "sub";
  /** その親子が置かれているリポジトリ（`owner/repo`）。省略時は担当Issueと同じとみなす */
  repositoryFullName?: string;
};

/**
 * 親子Issueの一覧（#1267）。**子Issueを起こしたときに親の背景が丸ごと落ちる**のを防ぐ。
 * 取得できていない場合は、無いのか取っていないのかが分かる文言にする。
 *
 * **別リポジトリの親子は`owner/repo#123`と書く**（#1722）。サブIssueはリポジトリをまたげるのに
 * `#123`とだけ書くと、受け取ったエージェントの側では自分のリポジトリの無関係なIssueに解決する。
 */
function formatRelations(
  relations: readonly PromptRelation[] | undefined,
  repositoryFullName: string,
): string {
  if (relations === undefined) return "（この経路では取得していません）";
  if (relations.length === 0) return "(親子関係のあるIssueはありません)";
  return relations
    .map((relation) => {
      const ref =
        relation.repositoryFullName && relation.repositoryFullName !== repositoryFullName
          ? `${relation.repositoryFullName}#${relation.number}`
          : `#${relation.number}`;
      return `- ${relation.relation === "parent" ? "親" : "子"}: ${ref} ${relation.title}（${relation.state}）`;
    })
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
  relations?: readonly PromptRelation[];
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
    "{{ISSUE_RELATIONS}}": formatRelations(relations, repositoryFullName),
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
    "{{SHARED_CONTEXT_INSTRUCTIONS}}": sharedContextInstructions(repositoryFullName),
  };

  const filled = Object.entries(replacements).reduce(
    (text, [placeholder, value]) => text.split(placeholder).join(value),
    GENERIC_IMPLEMENTATION_AGENT_TEMPLATE,
  );

  return `${preamble(repositoryFullName, issueNumber)}\n${filled}`;
}
