export type ConnectedRepository = {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  hasClaudeWorkflow: boolean;
  /** ローカル起動プロトコルに適合しているか（#1073。scripts/start-issue.sh のマーカー行で判定） */
  hasLocalStartScript: boolean;
  /**
   * サブPCのローカルセッションで起動できると申告されているか（#1888）。
   *
   * `DispatchHost.repositories`（`~/.config/issue-deck/local-repos.conf`をサブPCが走査して
   * 申告したもの）に含まれていれば`true`。**`hasLocalStartScript`とは別物**で、あちらは
   * GitHub上に契約適合の`scripts/start-issue.sh`があるか（メインPCへ貼る起動コマンドの可否）、
   * こちらは実際にcloneして起動できるとサブPCが言っているか。汎用ランチャー（#1224）が
   * あるため、マーカー行を持たないリポジトリでも`true`になる。
   *
   * **ホストが応答しているか（online）は見ない。** 一覧の印はリポジトリの構成を表すもので、
   * サブPCの生死で付いたり消えたりさせない（`lib/repository-automation.ts`）。
   */
  dispatchRunnable: boolean;
  hidden: boolean;
  favorite: boolean;
};
