import type { IssueDraftKind } from "@/hooks/use-issue-draft";
import type { QuickIssueStep } from "@/lib/quick-issue";

/**
 * Issue作成画面を別ウィンドウ（`/issues/new`）で開くための受け渡し（#1728）。
 *
 * **入口は作成ダイアログの中だけ**にしている。書き始めてから「一覧を見ながら書きたい」と
 * 気づく使い方が元の要望で、ヘッダーから直接開く口を増やすと、同じ物を作る導線が2つ並ぶ。
 *
 * 別ウィンドウは`window.open`で開くため、開いた先へ状態をそのまま渡せない。ダイアログの
 * 入力内容は**開く直前にlocalStorageへ書き、開いた側が読み取って消す**（一度きり）。
 * 下書きの自動保存（`use-issue-draft`）とはキーを分ける——あちらは「閉じても消えない書きかけ」で、
 * 復元するかどうかを人が選ぶもの。こちらは移し替えの途中経過であり、選ばせるものではない。
 */
export type IssueCreateHandoff = {
  kind: IssueDraftKind;
  repositoryFullName: string;
  title: string;
  body: string;
  selectedLabels: string[];
  assignee: string | null;
  /** 本文の先頭に固定で付くテキスト（引き継ぎ作成・#1322）。入力欄には入らないため別に運ぶ */
  bodyPrefix: string | null;
  /** 移す時点で開いていたステップ。確認まで進んでいたなら、開いた先も確認から始める */
  step: QuickIssueStep;
  savedAt: number;
};

export const ISSUE_CREATE_WINDOW_PATH = "/issues/new";
/**
 * 開くウィンドウの名前。**同じ名前を使い回すことで、押すたびにウィンドウが増えないようにする。**
 * すでに開いていれば、そのウィンドウが新しい内容で読み込み直される。
 */
export const ISSUE_CREATE_WINDOW_NAME = "issue-deck-create-issue";
const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 820;
const HANDOFF_STORAGE_KEY = "issue-create-handoff";
/**
 * 受け渡しの有効期限。ウィンドウが開かなかった（ポップアップブロック等）ときに書き残しが
 * 残るため、古いものは読まずに捨てる。次に開いたときへ持ち越すと、まったく別の書きかけが
 * 復活したように見える。
 */
const HANDOFF_MAX_AGE_MS = 5 * 60_000;

/**
 * `window.open`へ渡すウィンドウ設定を作る。画面の中央に、画面からはみ出さない大きさで開く。
 * `popup`を付けないとタブとして開くブラウザがあるため、常に付ける。
 */
export function buildIssueCreateWindowFeatures(screen: {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
}): string {
  const width = Math.min(WINDOW_WIDTH, Math.max(320, screen.availWidth - 40));
  const height = Math.min(WINDOW_HEIGHT, Math.max(400, screen.availHeight - 40));
  const left = Math.round((screen.availLeft ?? 0) + (screen.availWidth - width) / 2);
  const top = Math.round((screen.availTop ?? 0) + (screen.availHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/** 保存された受け渡しを読む。壊れている・古い場合はnull（＝空のフォームで始める） */
export function parseIssueCreateHandoff(raw: string | null, now: number): IssueCreateHandoff | null {
  if (raw === null) return null;
  let parsed: Partial<IssueCreateHandoff>;
  try {
    parsed = JSON.parse(raw) as Partial<IssueCreateHandoff>;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (typeof parsed.savedAt !== "number" || now - parsed.savedAt > HANDOFF_MAX_AGE_MS) return null;
  return {
    kind: parsed.kind === "question" ? "question" : "issue",
    repositoryFullName:
      typeof parsed.repositoryFullName === "string" ? parsed.repositoryFullName : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    selectedLabels: Array.isArray(parsed.selectedLabels)
      ? parsed.selectedLabels.filter((name): name is string => typeof name === "string")
      : [],
    assignee: typeof parsed.assignee === "string" ? parsed.assignee : null,
    bodyPrefix: typeof parsed.bodyPrefix === "string" ? parsed.bodyPrefix : null,
    step: parsed.step === "confirm" ? "confirm" : "input",
    savedAt: parsed.savedAt,
  };
}

/** 受け渡しを読み取って消す。**残さない**——同じ内容で2回開けると、書きかけが二重に現れる */
export function takeIssueCreateHandoff(now: number = Date.now()): IssueCreateHandoff | null {
  const raw = window.localStorage.getItem(HANDOFF_STORAGE_KEY);
  window.localStorage.removeItem(HANDOFF_STORAGE_KEY);
  return parseIssueCreateHandoff(raw, now);
}

/**
 * 作成中の内容を渡して別ウィンドウを開く。開けたかどうかを返す（ポップアップブロック時はfalse）。
 * 開けなかった場合は書き残しを消し、呼び出し側はダイアログを閉じずに続けられる状態に留める。
 */
export function openIssueCreateWindow(handoff: Omit<IssueCreateHandoff, "savedAt">): boolean {
  window.localStorage.setItem(
    HANDOFF_STORAGE_KEY,
    JSON.stringify({ ...handoff, savedAt: Date.now() } satisfies IssueCreateHandoff),
  );
  const opened = window.open(
    ISSUE_CREATE_WINDOW_PATH,
    ISSUE_CREATE_WINDOW_NAME,
    buildIssueCreateWindowFeatures(window.screen),
  );
  if (!opened) {
    window.localStorage.removeItem(HANDOFF_STORAGE_KEY);
    return false;
  }
  opened.focus();
  return true;
}
