import { describe, expect, it } from "vitest";

import {
  SESSION_STARTED_MARKER,
  buildSessionStartedCommentBody,
} from "@/lib/dispatch/session-start";

describe("buildSessionStartedCommentBody", () => {
  const params = { hostName: "subpc", tmuxSessionName: "issue-deck-issue-1119" };

  it("ホスト名は地の文では日本語表記、明細では識別子のまま出す（#1416の使い分け）", () => {
    const body = buildSessionStartedCommentBody(params);
    expect(body).toContain("サブPCのローカルセッションで対応を開始します");
    expect(body).toContain("- ホスト: `subpc`");
  });

  /**
   * **これがこのコメントの本題**（#1119）。Actions UIに相当する実行ログがローカルには無いので、
   * 様子を見に行く先を受付の時点で必ず書いておく。
   */
  it("tmux attachのコマンドを、そのままコピーできる形で載せる", () => {
    expect(buildSessionStartedCommentBody(params)).toContain(
      "```bash\ntmux attach -t issue-deck-issue-1119\n```",
    );
  });

  it("11.local中はコメント欄が届かないことを案内する（#1287と同じ文脈）", () => {
    expect(buildSessionStartedCommentBody(params)).toContain(
      "`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません。",
    );
  });

  it("Claude Codeとモデルを案内する", () => {
    const body = buildSessionStartedCommentBody({ ...params, agent: "claude", model: "sonnet" });
    expect(body).toContain("- エージェント: Claude Code");
    expect(body).toContain("- モデル: `sonnet`");
    expect(body).toContain("Remote Controlか端末から伝えてください。");
  });

  it("CodexではRemote Controlを案内しない", () => {
    const body = buildSessionStartedCommentBody({ ...params, agent: "codex", model: "gpt-5-codex" });
    expect(body).toContain("- エージェント: Codex CLI");
    expect(body).toContain("- モデル: `gpt-5-codex`");
    expect(body).toContain("追加の指示は端末から伝えてください。");
    expect(body).not.toContain("Remote Controlか端末から伝えてください。");
  });

  it("モデル未指定またはautoはCLIの既定と案内する", () => {
    expect(buildSessionStartedCommentBody(params)).toContain("- モデル: `CLIの既定`");
    expect(
      buildSessionStartedCommentBody({ ...params, agent: "codex", model: "auto" }),
    ).toContain("- モデル: `CLIの既定`");
  });

  /**
   * マーカーが無いと`comment-source.ts`が役割を判別できず、画面でユーザー本人の発言として
   * 表示される（#1346）。役割はActionsの受付コメントと同じ`guide`で揃える（#860）。
   */
  it("受付コメントのマーカーと案内ボットの役割マーカーを末尾に付ける", () => {
    const body = buildSessionStartedCommentBody(params);
    expect(body).toContain(SESSION_STARTED_MARKER);
    expect(body.trimEnd().endsWith("<!-- issue-deck-agent:guide -->")).toBe(true);
  });

  it("対応表に無いホストは表記を変えずにそのまま出す", () => {
    const body = buildSessionStartedCommentBody({ ...params, hostName: "mainpc" });
    expect(body).toContain("mainpcのローカルセッションで対応を開始します");
  });
});
