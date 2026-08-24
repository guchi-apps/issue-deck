"use client";

import { useCallback, useState } from "react";

import type { ConsultMessage, NewAppDraft } from "@/lib/claude/new-app-consult";
import type { NewAppCreatedRef } from "@/lib/new-app/plan";
import type { NewAppSpec } from "@/lib/new-app/spec";

/**
 * 新規アプリ立ち上げの、サーバーとのやり取り（#2188）。
 *
 * **3本のAPIを1つのフックにまとめている。** 相談 → 検証 → 実行はウィザードの中で
 * 一続きに進み、途中で持ち回る状態（会話・空き確認の結果・作られたもの）も同じ画面が使うため。
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
  /** `guchi-apps/vps`を読めたか。falseなら空き番号は提案されない */
  vpsRead: boolean;
};

export type ConsultReply = {
  reply: string;
  draft: NewAppDraft | null;
  ready: boolean;
};

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
    preflight,
    launch,
    isConsulting,
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
