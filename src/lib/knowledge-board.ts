/**
 * 「共通知識」画面（#2912）の整形ロジック。**純粋関数だけを置く。**
 *
 * 材料は2つで、取得は`lib/github/knowledge-api.ts`が、見せ方は
 * `components/dashboard/knowledge-board-panel.tsx`が持つ。
 *
 * 1. **たまった共通知識** — `guchi-apps/docs`の`knowledge/`にあるMarkdownの`##`見出し。
 *    1見出し＝1知見という書式は共有知識側のルールで、`knowledge/README.md`が正本
 * 2. **知見の候補** — 各リポジトリのIssueに残る知見メモ（`<!-- knowledge-candidate -->`）と、
 *    格上げ判定エージェントの結果コメント（`<!-- knowledge-promotion:judged -->`）
 *
 * **実物の書式は揃っていない。** 知見メモは`###`の見出し・`**太字**`・地の文が混在し、
 * マーカーの位置もコメントの先頭だったり末尾だったりする。したがって解析はbest-effortに振り、
 * 取れなかったものは落とさず本文の冒頭を見出しとして出す。**落とすと「メモを書いたのに
 * 一覧に出ない」という最悪の形になる**ため、精度より取りこぼしの無さを優先する。
 */

import { startOfJstDayMs } from "@/lib/format-date-time";

/** 知見メモの目印。`promote-knowledge.yml`・各プロンプトが使うものと同じ */
export const CANDIDATE_MARKER = "<!-- knowledge-candidate -->";

/** 格上げ判定が済んだ目印。判定エージェントが結果コメントの末尾へ付ける */
export const JUDGED_MARKER = "<!-- knowledge-promotion:judged -->";

export type PromotionVerdict = "approved" | "rejected" | "pending";

/** 共通知識の1セクション（`##`見出し1つ＝1知見） */
export type KnowledgeSection = {
  /** `knowledge/github-actions.md`のようなリポジトリ内パス */
  path: string;
  /** 見出しの本文（`## `を除いたもの） */
  title: string;
  /** `- **結論**: ...`の値。無ければ本文の冒頭 */
  summary: string;
  /** `- **確認日**: 2026-08-31`の値（`YYYY-MM-DD`）。取れなければnull */
  confirmedOn: string | null;
  /** `- **出典リポジトリ**: guchi-apps/issue-deck#123`の値。取れなければnull */
  source: string | null;
};

/** 知見メモ1件（`###`見出し1つ、またはマーカー1つぶん） */
export type MemoItem = {
  title: string;
};

/** 判定コメントから取り出した1行 */
export type VerdictNote = {
  verdict: "approved" | "rejected";
  /** 判定対象の知見の見出し */
  title: string;
  /** 反映先（`knowledge/github-actions.md`）。却下・書式崩れではnull */
  destination: string | null;
  /** 理由の1行。取れなければnull */
  reason: string | null;
};

/** 候補の一覧に並ぶ1件（Issue1件ぶん） */
export type KnowledgeCandidate = {
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  /** 知見メモの見出し */
  memos: MemoItem[];
  /** 判定の内訳。未判定では空 */
  notes: VerdictNote[];
  verdict: PromotionVerdict;
  /** 承認された知見の数（未判定では0） */
  approvedCount: number;
  /** 却下された知見の数（未判定では0） */
  rejectedCount: number;
  /** 判定コメントに書かれた反映Pull RequestのURL。無ければnull */
  promotionPullRequestUrl: string | null;
  /** 未判定なら最後の知見メモ、判定済みなら判定コメントの投稿日時（ISO） */
  at: string;
};

/** 知見メモの総数（検索の`total_count`から取る概算。取れなければnull） */
export type KnowledgeCounts = {
  total: number | null;
  unjudged: number | null;
  judged: number | null;
};

/** 画面が受け取るデータ一式 */
export type KnowledgeBoardData = {
  sections: KnowledgeSection[];
  /** 共通知識のファイル数（`README.md`を除く） */
  fileCount: number;
  candidates: KnowledgeCandidate[];
  /** 検索の上限に達して見ていないIssueが残っているか */
  truncated: boolean;
  /**
   * 検索の総数（概算）。**一覧は300件で打ち切っている**ので、件数のKPIはこちらから出す。
   * 打ち切りの影響を受けない代わり、本文で言及しているだけのIssueも含む（実測で5%ほど多い）
   */
  counts: KnowledgeCounts;
  /** 格上げ判定エージェントが1回に集める上限（`promote-knowledge.yml`の`--limit`） */
  collectLimit: number;
  /** 共有知識リポジトリのURL（見出しからのリンク先） */
  docsRepoUrl: string;
};

/** 取得元のコメント1件（`knowledge-api.ts`が返す形） */
export type RawComment = {
  body: string;
  createdAt: string;
};

/** 取得元のIssue1件 */
export type RawIssue = {
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  comments: RawComment[];
};

/** 取得元のファイル1件 */
export type RawKnowledgeFile = {
  path: string;
  text: string;
};

// ---- マーカーの判定 --------------------------------------------------------

/**
 * コードフェンスで囲まれた部分を落とす。
 *
 * **この仕組み自体を設計したIssueが誤検出の元になる。** 運用を決めたIssueは、書式の説明として
 * マーカーを囲みの中に貼っている。そのまま数えると、判定していないIssueが「判定済み」になり、
 * 知見でもないコメント（計画・実装完了の報告）が知見として並ぶ。
 *
 * フェンスはバッククォート3つ以上・チルダ3つ以上のどちらもあり、知見メモのテンプレートは
 * バッククォート4つで書かれることがあるため、開いた記号と同じ種類・同じ長さ以上で閉じる
 * というMarkdownの規則に合わせる。
 */
export function stripCodeFences(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const char = match[1][0];
      const length = match[1].length;
      if (!fence) {
        fence = { char, length };
        continue;
      }
      if (char === fence.char && length >= fence.length) {
        fence = null;
        continue;
      }
    }
    if (!fence) kept.push(line);
  }

  return kept.join("\n");
}

/**
 * マーカーが「そのコメント自身のもの」として置かれているか。
 *
 * **行全体がマーカーであることまで見る**（`guchi-apps/aide#161`の知見）。各テンプレートは
 * マーカーを独立した行に置くのに対し、設計の説明で言及するときは`` `<!-- ... -->` ``のように
 * 地の文へ埋め込まれる。単なる`includes`では後者まで拾う。
 */
export function hasMarkerLine(body: string, marker: string): boolean {
  return stripCodeFences(body)
    .split("\n")
    .some((line) => line.trim() === marker);
}

// ---- 知見メモ -------------------------------------------------------------

/**
 * 先頭の記号・強調を落として1行の見出しにする。
 *
 * **リンクは表示文字だけにする。** 知見メモには`[owner/repo#123](https://…)`の形で出典が
 * 埋め込まれることがあり、そのまま出すとURLが見出しの大半を占め、長さで切ったときに
 * URLの途中で終わる。
 */
function cleanHeading(text: string): string {
  return text
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * `- **結論**: ...`のような項目の、折り返した続きの行を1つにつなぐ。
 *
 * **実物は1行に収まっていない。** 共有知識のセクションも判定コメントも、値が長いと次の行へ
 * 折り返して書かれる（実データの`結論`はほとんどが複数行）。1行目だけを取ると、画面に出るのは
 * 文の途中で切れた文字列になる。続きと見なすのは、**元の行より深く字下げされていて、
 * 新しい箇条書きを始めていない行**だけ。
 */
function joinContinuation(lines: string[], startIndex: number, baseIndent: number): string {
  const parts: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    if (/^\s*[-*]\s/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join("");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * 「知見メモ」という前置きだけの行。**見出しとしては何も言っていない**ので落とす。
 *
 * 実データでは`**知見メモ**`だけの行に続けて本文が始まる書き方が多く、そのまま見出しにすると
 * 一覧が「知見メモ」で埋まる。`**知見メモ: <結論>**`のように後ろへ結論が続く形もあるため、
 * 前置きを剥がしてから中身が残るかを見る。
 */
function stripMemoLead(text: string): string {
  return text.replace(/^(?:知見メモ|メモ|内容|補足)\s*[:：]?\s*/, "").trim();
}

/** 行全体が`**...**`の、見出しとして書かれた太字の行か */
function isBoldHeadingLine(line: string): boolean {
  return /^\*\*[^*].*\*\*$/.test(line.trim());
}

/**
 * 太字の行を「知見の見出し」と見なす最小の長さ。
 *
 * **短い太字は見出しではなく、メモの中の小見出し**（`**根拠**`・`**なぜ非自明か**`・`**記載先**`）。
 * 実データではこれらが知見と同じ形で並ぶため、長さで切らないと一覧が「根拠」「出典」で埋まる。
 * 逆に知見の結論は一行で言い切る決まりなので、必ずこれより長い。
 */
const MEMO_HEADING_MIN_LENGTH = 16;

/**
 * 知見メモ1件ぶんの本文から見出しを決める。
 *
 * 実物の書式は3通りある（`##`・`###`の見出し・`**太字**`の1行・地の文）。どれでも取れるように
 * し、**最後は本文の冒頭を切り出して必ず何かを返す**（空を返すと一覧から消える）。
 */
export function resolveMemoTitle(body: string): string {
  const lines = stripCodeFences(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"));

  // `## 知見メモ`のように前置きだけの見出しがあるので、中身が残るものを探す
  for (const line of lines) {
    if (!/^#{2,6}\s+\S/.test(line)) continue;
    const title = stripMemoLead(cleanHeading(line));
    if (title) return truncateTitle(title);
  }

  const boldLines = lines.filter(isBoldHeadingLine).map((line) => stripMemoLead(cleanHeading(line)));
  const longBold = boldLines.find((line) => line.length >= MEMO_HEADING_MIN_LENGTH);
  if (longBold) return truncateTitle(longBold);

  const prose = lines
    .filter((line) => !isBoldHeadingLine(line) && !/^#{1,6}\s/.test(line))
    .map((line) => stripMemoLead(cleanHeading(line)))
    .find(Boolean);
  if (prose) return truncateTitle(prose);

  const anyBold = boldLines.find(Boolean);
  if (anyBold) return truncateTitle(anyBold);

  return "(本文なし)";
}

function truncateTitle(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * 知見メモのコメント本文を、知見ごとに切り分ける。
 *
 * **マーカーの位置で切る。** 1つのコメントに知見を複数書くときは知見ごとにマーカーを置く
 * 書き方が実際にあり、逆にマーカーが末尾に1つだけのコメントもある。マーカーで分割すると、
 * どちらも同じ扱いで切り出せる。切ったあとに`###`の見出しが複数あればさらに分ける。
 */
export function parseMemoComment(body: string): MemoItem[] {
  const chunks = body
    .split(new RegExp(`^\\s*${escapeRegExp(CANDIDATE_MARKER)}\\s*$`, "m"))
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const items: MemoItem[] = [];
  for (const chunk of chunks) {
    // マーカーの後ろに役割マーカー（`<!-- issue-deck-agent:implementer -->`）だけが残る形が
    // 多い。中身の無い切れ端を「(本文なし)」として並べない
    const stripped = stripCodeFences(chunk);
    if (!stripped.split("\n").some((line) => line.trim() && !line.trim().startsWith("<!--"))) {
      continue;
    }

    const headings = stripped
      .split(/^#{3}\s+/m)
      .slice(1)
      .map((heading) => stripMemoLead(cleanHeading(heading.split("\n")[0])))
      .filter(Boolean);
    if (headings.length > 0) {
      for (const heading of headings) items.push({ title: truncateTitle(heading) });
      continue;
    }

    // `###`を使わず、`**1. …**`のような太字の行を見出し代わりにするメモが実際にある。
    // **2つ以上あるときだけ**そこで分ける（1つなら前置きの可能性があるため`resolveMemoTitle`に任せる）
    const boldHeadings = stripped
      .split("\n")
      .filter(isBoldHeadingLine)
      .map((line) => stripMemoLead(cleanHeading(line)))
      .filter((line) => line.length >= MEMO_HEADING_MIN_LENGTH);
    if (boldHeadings.length >= 2) {
      for (const heading of boldHeadings) items.push({ title: truncateTitle(heading) });
      continue;
    }

    items.push({ title: resolveMemoTitle(chunk) });
  }
  return items;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- 判定コメント ---------------------------------------------------------

/**
 * 判定コメントの本文から、知見ごとの承認・却下と理由を取る。
 *
 * 書式は`promote-knowledge.yml`のプロンプトが指定している。指定どおりに書かれていない場合は
 * 空配列を返すので、呼び出し側は「判定済み・内訳不明」として扱える（未判定には落とさない）。
 */
export function parseVerdictComment(body: string): VerdictNote[] {
  const lines = stripCodeFences(body).split("\n");
  const notes: VerdictNote[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*[-*]\s*(✅|❌)\s*(?:承認|却下)\s*[:：]\s*(.+)$/.exec(lines[i]);
    if (!match) continue;

    const verdict = match[1] === "✅" ? "approved" : "rejected";
    let rest = match[2].trim();
    let destination: string | null = null;

    // `... → \`knowledge/foo.md\`（新設）` の形から反映先を取る
    const arrow = rest.lastIndexOf("→");
    if (arrow >= 0) {
      const tail = rest.slice(arrow + 1);
      const path = /`?(knowledge\/[\w.-]+\.md)`?/.exec(tail);
      if (path) destination = path[1];
      rest = rest.slice(0, arrow).trim();
    }

    // 直後のインデントされた `- 理由: ...` を、折り返した続きの行までつないで拾う
    let reason: string | null = null;
    const next = lines[i + 1];
    const reasonMatch = next ? /^\s+[-*]\s*理由\s*[:：]\s*(.+)$/.exec(next) : null;
    if (reasonMatch && next) {
      reason = (reasonMatch[1].trim() + joinContinuation(lines, i + 2, indentOf(next))).trim();
    }

    notes.push({ verdict, title: cleanHeading(rest), destination, reason });
  }

  return notes;
}

/** 判定コメントに書かれた反映Pull RequestのURLを取る */
export function extractPromotionPullRequestUrl(body: string): string | null {
  const match = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(stripCodeFences(body));
  return match ? match[0] : null;
}

// ---- Issue 1件 -> 候補1件 --------------------------------------------------

/**
 * 知見メモを持つIssue1件を、一覧の1行にする。
 *
 * 知見メモが1件も無ければnull。**GitHubのIssue検索は本文もコメントも対象にする**ため、
 * この仕組みを設計したIssueのように「本文にマーカーの文字列が出てくるだけ」のものが混ざる。
 * `promote-knowledge.yml`と同じくコメント側にマーカーがあるかで判定し、さらに囲みの中と
 * 地の文への言及も除く（`hasMarkerLine`）。
 */
export function buildCandidate(issue: RawIssue): KnowledgeCandidate | null {
  const memoComments = issue.comments.filter((c) => hasMarkerLine(c.body, CANDIDATE_MARKER));
  if (memoComments.length === 0) return null;

  const judgedComments = issue.comments.filter((c) => hasMarkerLine(c.body, JUDGED_MARKER));
  const memos = memoComments.flatMap((c) => parseMemoComment(c.body));

  const latestJudged = judgedComments[judgedComments.length - 1] ?? null;
  const notes = latestJudged ? parseVerdictComment(latestJudged.body) : [];
  const approvedCount = notes.filter((n) => n.verdict === "approved").length;
  const rejectedCount = notes.filter((n) => n.verdict === "rejected").length;

  // 判定済みかどうかはマーカーだけで決める。内訳が取れなくても未判定へは落とさない
  // （落とすと「判定エージェントが止まっている」の合図が実態より多く出る）。
  const verdict: PromotionVerdict = !latestJudged
    ? "pending"
    : approvedCount > 0
      ? "approved"
      : "rejected";

  const at = latestJudged?.createdAt ?? memoComments[memoComments.length - 1].createdAt;

  return {
    repoFullName: issue.repoFullName,
    number: issue.number,
    title: issue.title,
    htmlUrl: issue.htmlUrl,
    memos,
    notes,
    verdict,
    approvedCount,
    rejectedCount,
    promotionPullRequestUrl: latestJudged
      ? extractPromotionPullRequestUrl(latestJudged.body)
      : null,
    at,
  };
}

/**
 * 候補を一覧の並び順にする。**未判定が先、その中では古い順。**
 *
 * 未判定は放置されているほど問題なので、上に来るのが古いものになるようにする。判定済みは
 * 逆に新しい順（最近何が採用されたかを見る場所なので）。
 */
export function sortCandidates(candidates: KnowledgeCandidate[]): KnowledgeCandidate[] {
  const pending = candidates
    .filter((c) => c.verdict === "pending")
    .sort((a, b) => a.at.localeCompare(b.at));
  const judged = candidates
    .filter((c) => c.verdict !== "pending")
    .sort((a, b) => b.at.localeCompare(a.at));
  return [...pending, ...judged];
}

// ---- knowledge/ のファイル -------------------------------------------------

/**
 * `- **確認日**: 2026-08-31`のような行から値を取る。太字の有無・全角コロン・行頭の空白は
 * どれも通し、**折り返した続きの行までつなぐ**（実データの`結論`はほとんどが複数行）。
 */
function fieldValue(text: string, label: string): string | null {
  const lines = text.split("\n");
  const pattern = new RegExp(`^\\s*[-*]\\s*\\**${label}\\**\\s*[:：]\\s*(.+)$`);

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const value = match[1].trim() + joinContinuation(lines, i + 1, indentOf(lines[i]));
    return value.trim().replace(/\*\*/g, "");
  }
  return null;
}

/**
 * 共通知識のファイル1つを、`##`見出しごとのセクションへ分ける。
 *
 * **`README.md`は索引なので呼び出し側が除く。** ここでは判定しない。
 */
export function parseKnowledgeFile(file: RawKnowledgeFile): KnowledgeSection[] {
  const body = stripCodeFences(file.text);
  const chunks = body.split(/^##\s+/m).slice(1);

  return chunks.map((chunk) => {
    const lines = chunk.split("\n");
    const title = cleanHeading(lines[0]);
    const rest = lines.slice(1).join("\n");
    const conclusion = fieldValue(rest, "結論");
    const confirmedOn = fieldValue(rest, "確認日");
    const source = fieldValue(rest, "出典リポジトリ") ?? fieldValue(rest, "出典");

    const fallback = rest
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("[") && !line.startsWith("<!--"));

    return {
      path: file.path,
      title,
      summary: conclusion ?? fallback ?? "",
      confirmedOn: confirmedOn && /^\d{4}-\d{2}-\d{2}$/.test(confirmedOn) ? confirmedOn : null,
      source: source ? source.replace(/[`（(].*$/, "").trim() : null,
    };
  });
}

/**
 * 共通知識を新しい順に並べる。**確認日が無いものは末尾へ。**
 *
 * 「最近ためた共通知識」を見る画面なので、日付の降順が主軸。同じ日の中はファイル名で揃える
 * （同じファイルへ足された知見が離れて並ぶと、1回の反映で入ったことが読み取れない）。
 */
export function sortKnowledgeSections(sections: KnowledgeSection[]): KnowledgeSection[] {
  return [...sections].sort((a, b) => {
    if (a.confirmedOn !== b.confirmedOn) {
      if (!a.confirmedOn) return 1;
      if (!b.confirmedOn) return -1;
      return b.confirmedOn.localeCompare(a.confirmedOn);
    }
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.title.localeCompare(b.title);
  });
}

/** 確認日ごとのまとまり（画面の見出し用） */
export type KnowledgeDateGroup = {
  /** `2026-08-31`。確認日が無いものは`null` */
  date: string | null;
  sections: KnowledgeSection[];
};

export function groupKnowledgeByDate(sections: KnowledgeSection[]): KnowledgeDateGroup[] {
  const groups: KnowledgeDateGroup[] = [];
  for (const section of sortKnowledgeSections(sections)) {
    const last = groups[groups.length - 1];
    if (last && last.date === section.confirmedOn) {
      last.sections.push(section);
      continue;
    }
    groups.push({ date: section.confirmedOn, sections: [section] });
  }
  return groups;
}

/** ファイル別の件数（絞り込みのチップ用）。多い順 */
export function countByFile(sections: KnowledgeSection[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const section of sections) counts.set(section.path, (counts.get(section.path) ?? 0) + 1);
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

/**
 * `YYYY-MM-DD`から今日までの経過日数。解釈できなければnull。
 *
 * **確認日は「日本時間の日付」として人が書いた文字列**で、時刻を持たない。`new Date("2026-08-31")`
 * はUTCの0時に解釈されるため、そのまま引き算するとUTCで動く本番・CIで1日ずれる。日付どうしの
 * 引き算になるよう、両方をJSTの0時へ揃えてから比べる（`docs/code-map.md`の日時の規約）。
 */
export function daysSinceJstDate(date: string, now: number | Date = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = Date.parse(`${date}T00:00:00+09:00`);
  const today = startOfJstDayMs(now);
  if (Number.isNaN(at) || today === null) return null;
  return Math.round((today - at) / (24 * 60 * 60_000));
}

// ---- 滞留の判定 ------------------------------------------------------------

export type KnowledgeStall = {
  /** 一覧の中の未判定の件数（マーカーの行全体一致で確かめたもの） */
  pendingCount: number;
  /** 検索の総数から見た未判定の件数（概算・打ち切りの影響を受けない）。取れなければnull */
  pendingTotal: number | null;
  /** いちばん古い未判定メモの日時（ISO）。未判定が無ければnull */
  oldestPendingAt: string | null;
  /** 最後に共通知識へ反映された確認日（`YYYY-MM-DD`）。取れなければnull */
  lastPromotedOn: string | null;
  /** 未判定が滞留しているか */
  shouldWarn: boolean;
  /**
   * **格上げ判定の収集の窓が、判定済みで埋まっているか**（#2912）。
   *
   * ここが真のとき、ワークフローは毎晩`success`で終わりながら1件も判定しない。
   * `shouldWarn`（メモが古いまま残っている）とは別に出す——原因が違うと打つ手も違う
   * （落ちているなら実行ログ、埋まっているなら収集の窓の設定）。
   */
  collectWindowSaturated: boolean;
};

export function detectKnowledgeStall(
  candidates: KnowledgeCandidate[],
  sections: KnowledgeSection[],
  counts: KnowledgeCounts = { total: null, unjudged: null, judged: null },
  collectLimit = 0,
  now: Date = new Date(),
): KnowledgeStall {
  const pending = candidates.filter((c) => c.verdict === "pending");
  const oldestPendingAt =
    pending.length > 0
      ? pending.map((c) => c.at).sort((a, b) => a.localeCompare(b))[0]
      : null;

  const lastPromotedOn =
    sections
      .map((s) => s.confirmedOn)
      .filter((d): d is string => Boolean(d))
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

  const STALE_MS = 2 * 24 * 60 * 60_000;
  const shouldWarn = Boolean(
    oldestPendingAt && now.getTime() - new Date(oldestPendingAt).getTime() > STALE_MS,
  );

  // 判定済みが収集の上限に張り付いていたら、窓（作成の古い順N件）が判定済みで埋まっている。
  // 窓は古い側から数えるので判定済みはこの数を超えず、達したまま止まるのが詰まりの形。
  const collectWindowSaturated =
    collectLimit > 0 && counts.judged !== null && counts.judged >= collectLimit;

  return {
    pendingCount: pending.length,
    pendingTotal: counts.unjudged,
    oldestPendingAt,
    lastPromotedOn,
    shouldWarn,
    collectWindowSaturated,
  };
}
