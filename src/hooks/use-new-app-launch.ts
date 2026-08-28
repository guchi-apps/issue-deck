"use client";

import { useCallback, useState } from "react";

import type { ConsultMessage, NewAppDraft } from "@/lib/claude/new-app-consult";
import type { IdeaImport } from "@/lib/new-app/idea-doc";
import type { ExistingLaunchIssue } from "@/lib/new-app/launch-marker";
import type { NewAppCreatedRef } from "@/lib/new-app/plan";
import type { NewAppSpec } from "@/lib/new-app/spec";

/**
 * 新規アプリ立ち上げの、サーバーとのやり取り（#2188）。
 *
 * **4本のAPIを1つのフックにまとめている。** 構想の読み込み → 相談 → 検証 → 実行はウィザードの
 * 中で一続きに進み、途中で持ち回る状態（会話・空き確認の結果・作られたもの）も同じ画面が使うため。
 */

export type PreflightResult = {
  repository: { name: string; taken: boolean | null };
  hostname: { value: string; taken: boolean | null };
  port: { suggested: number | null; note: string | null; used?: number[] };
  /** ローカルセッションの開発サーバーのポート帯（#2225） */
  localPortBand: { base: number | null; alreadyListed: boolean; note: string };
  /**
   * GitHub Appのインストール対象の選び方（#2248）。`needsRepositoryAdd`が真のときだけ、
   * ブラウザの手作業Issueに「インストール対象へ追加する」が入る
   */
  githubApp: {
    repositorySelection: "all" | "selected" | null;
    needsRepositoryAdd: boolean;
  };
  /**
   * `guchi-apps/vps`に同じ対象のopenなIssueが既にあるか（#2250）。
   * あれば立ち上げは新しく作らず、そのIssueへコメントする
   */
  existingVpsIssue: ExistingLaunchIssue | null;
  /** `guchi-apps/vps`を読めたか。falseなら空き番号は提案されない */
  vpsRead: boolean;
};

export type ConsultReply = {
  reply: string;
  draft: NewAppDraft | null;
  ready: boolean;
};

/** 構想メモの一覧（#2432）。`available`が偽なら`guchi-apps/ideas`を読めていない */
export type IdeaListResult = {
  available: boolean;
  ideas: { name: string; path: string }[];
};

/** 読み込んだ構想メモ1件（#2432）。 */
export type IdeaImportResult = IdeaImport & { path: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (json as { message?: string; error?: string } | null)?.message ??
        (json as { error?: string } | null)?.error ??
        `リクエストに失敗しました (${res.status})`,
    );
  }
  return json as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(
      (json as { message?: string; error?: string } | null)?.message ??
        (json as { error?: string } | null)?.error ??
        `リクエストに失敗しました (${res.status})`,
    ) as Error & { payload?: unknown; status?: number };
    error.payload = json;
    error.status = res.status;
    throw error;
  }
  return json as T;
}

export function useNewAppLaunch() {
  const [isConsulting, setIsConsulting] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consult = useCallback(async (messages: ConsultMessage[]): Promise<ConsultReply | null> => {
    setIsConsulting(true);
    setError(null);
    try {
      return await postJson<ConsultReply>("/api/new-app/consult", { messages });
    } catch (e) {
      setError(
        e instanceof Error && e.message === "consult_exhausted"
          ? "相談の往復が上限に達しました。設定へ進んでください。"
          : e instanceof Error
            ? e.message
            : "相談に失敗しました",
      );
      return null;
    } finally {
      setIsConsulting(false);
    }
  }, []);

  /**
   * 構想メモの一覧（#2432）。**読めなくてもエラーにしない**——構想を使わずに立ち上げる
   * 経路まで巻き込んで画面にエラーを出さないため、空の一覧として扱う。
   */
  const listIdeas = useCallback(async (): Promise<IdeaListResult> => {
    try {
      return await getJson<IdeaListResult>("/api/new-app/ideas");
    } catch {
      return { available: false, ideas: [] };
    }
  }, []);

  /** 構想メモを1件読んで仕様案へ解析する（#2432）。読めなければ`null`。 */
  const importIdea = useCallback(async (path: string): Promise<IdeaImportResult | null> => {
    setIsImporting(true);
    setError(null);
    try {
      const result = await getJson<{ available: boolean; idea: IdeaImportResult | null }>(
        `/api/new-app/ideas?path=${encodeURIComponent(path)}`,
      );
      if (!result.available || !result.idea) {
        setError(`${path} を読めませんでした。構想メモが置かれているか確認してください。`);
        return null;
      }
      return result.idea;
    } catch (e) {
      setError(e instanceof Error ? e.message : "構想を読み込めませんでした");
      return null;
    } finally {
      setIsImporting(false);
    }
  }, []);

  const preflight = useCallback(
    async (input: {
      repositoryName: string;
      hostname: string;
      kind: NewAppSpec["kind"];
    }): Promise<PreflightResult | null> => {
      setIsChecking(true);
      setError(null);
      try {
        return await postJson<PreflightResult>("/api/new-app/preflight", input);
      } catch (e) {
        setError(e instanceof Error ? e.message : "空き状況を確認できませんでした");
        return null;
      } finally {
        setIsChecking(false);
      }
    },
    [],
  );

  /**
   * 立ち上げを実行する。
   *
   * **失敗しても、そこまでに作られたものを返す。** サーバーが409で`created`を返すので、
   * 画面はそれをリンクとして出せる（作られたのか何も起きていないのかが分からない、という
   * 状態を作らない）。
   */
  const launch = useCallback(
    async (
      spec: NewAppSpec,
    ): Promise<{ created: NewAppCreatedRef[]; warnings: string[]; failed: boolean }> => {
      setIsLaunching(true);
      setError(null);
      try {
        const result = await postJson<{ created: NewAppCreatedRef[]; warnings?: string[] }>(
          "/api/new-app",
          { spec },
        );
        return { created: result.created ?? [], warnings: result.warnings ?? [], failed: false };
      } catch (e) {
        const payload = (
          e as {
            payload?: { created?: NewAppCreatedRef[]; warnings?: string[]; error?: string };
          }
        ).payload;
        setError(describeLaunchError(payload?.error, e));
        return { created: payload?.created ?? [], warnings: payload?.warnings ?? [], failed: true };
      } finally {
        setIsLaunching(false);
      }
    },
    [],
  );

  return {
    consult,
    listIdeas,
    importIdea,
    preflight,
    launch,
    isConsulting,
    isImporting,
    isChecking,
    isLaunching,
    error,
    setError,
  };
}

function describeLaunchError(code: string | undefined, fallback: unknown): string {
  switch (code) {
    case "repository_taken":
      return "そのリポジトリ名は既に使われています。名前を変えてください。";
    case "hostname_taken":
      return "そのホスト名は既に使われています。サブドメインを変えてください。";
    case "port_band_unavailable":
      return "ローカルセッションのポート帯を決められませんでした（scripts/local-repo-ports.conf を読めていません）。まだ何も作っていないので、直してから押し直せます。";
    case "invalid_spec":
      return "入力に足りないところがあります。前のステップへ戻って直してください。";
    default:
      return fallback instanceof Error ? fallback.message : "立ち上げに失敗しました";
  }
}
