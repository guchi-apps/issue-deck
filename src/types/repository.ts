export type ConnectedRepository = {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  hasClaudeWorkflow: boolean;
  /** ローカル起動プロトコルに適合しているか（#1073。scripts/start-issue.sh のマーカー行で判定） */
  hasLocalStartScript: boolean;
  hidden: boolean;
  favorite: boolean;
};
