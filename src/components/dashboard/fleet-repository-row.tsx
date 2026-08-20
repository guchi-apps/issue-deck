import type { ReactNode } from "react";

/**
 * 設定 → フリート運用の一覧に共通する「リポジトリ1件ぶんの行」（#1952）。
 *
 * **どの幅でも横にはみ出さないことが要点。** 以前はどの一覧も
 * 「アイコン ＋ `truncate`したリポジトリ名 ＋ `ml-auto shrink-0`の結果」で組んでおり、
 * `uses と prompts-ref が不一致`のような長い文言が入ると結果が画面の外へ出て読めず、
 * 先にリポジトリ名の方が欠けていた。
 *
 * 代わりに、狭い画面では「名前」「結果」の2段・広い画面（`sm:`）では1行に並べ、
 * 長い文（失敗の理由・不一致・不足しているワークフロー名）は`detail`として段を改めて
 * 全文を折り返す。行の境目は罫線で区切る。
 *
 * **3つの一覧（シークレット同期・共有ワークフローのタグ・自動修復ワークフロー）は
 * 同じ画面で隣り合っているため、行の作りをここへ寄せる**（#1942で片方だけ直した結果、
 * 同じ画面で罫線の有無も名前の見え方も割れていた）。
 */
export function FleetRepositoryRow({
  icon,
  fullName,
  result,
  detail,
  action,
  expansion,
}: {
  /** 状態を表すアイコン。大きさ（`size-3.5`）と色は呼び出し側で指定する */
  icon: ReactNode;
  fullName: string;
  /** 名前の隣（狭い画面では下）に出す結果。折り返せるように組むこと */
  result: ReactNode;
  /** 長い文言。幅いっぱいに段を改めて出す */
  detail?: ReactNode;
  /** 行の右端に置く操作。無い一覧もある */
  action?: ReactNode;
  /**
   * 押して開く詳細（#2022）。`detail`と違い**エラーの色を持たない**枠で、
   * 幅いっぱいに段を改めて出す。シークレット同期の「内訳」（項目名の一覧）が使う。
   */
  expansion?: ReactNode;
}) {
  const [owner, name] = splitRepositoryName(fullName);

  return (
    <li className="flex items-start gap-2 border-t py-1.5 text-xs first:border-t-0">
      <span className="mt-0.5 flex shrink-0">{icon}</span>

      {/* 名前と結果は、狭い画面では2段・広い画面では1行に並べる。**どちらの幅でも
          はみ出さない**ことが要点で、長い文言は必ず段を改めて折り返す（#1942・#1952） */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2">
        <span className="min-w-0 break-words sm:flex-1">
          <span className="text-muted-foreground">{owner}</span>
          <span className="font-medium">{name}</span>
        </span>

        {result}

        {detail && (
          <p className="basis-full border-l-2 border-destructive/40 pl-1.5 break-words text-destructive">
            {detail}
          </p>
        )}

        {expansion && <div className="basis-full">{expansion}</div>}
      </div>

      {action}
    </li>
  );
}

/** `guchi-apps/issue-deck`を`guchi-apps/`と`issue-deck`に分ける。前者は全リポジトリで同じ */
export function splitRepositoryName(fullName: string): [string, string] {
  const index = fullName.indexOf("/");
  if (index < 0) return ["", fullName];
  return [fullName.slice(0, index + 1), fullName.slice(index + 1)];
}
