/**
 * セッション詳細の「ターミナルで開く」に出す、tmuxへ入るコマンドの組み立て（#5574）。
 *
 * コピーして端末へ貼るコマンドなので、シェルに解釈される文字を含む名前では組み立てない
 * （ホスト名・セッション名は実機の識別子で、英数字・`_`・`-`・`.`だけで作られている）。
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SessionTerminalCommands = {
  /** そのホスト上のターミナルで直接実行する（既定） */
  onHost: string;
  /** 別の端末からSSH（Tailscale・MagicDNSの短い名前）で入る */
  viaSsh: string;
};

/** 組み立てられない（名前が安全でない）ときはnullを返し、画面は欄ごと出さない */
export function buildSessionTerminalCommands(params: {
  hostName: string;
  tmuxSessionName: string;
}): SessionTerminalCommands | null {
  const { hostName, tmuxSessionName } = params;
  if (!SAFE_NAME.test(hostName) || !SAFE_NAME.test(tmuxSessionName)) return null;

  const attach = `tmux attach -t ${tmuxSessionName}`;
  return {
    onHost: attach,
    // 非対話のSSHはmacOSでHomebrewのPATHを持たないため、ログインシェル経由でtmuxを見つけさせる
    viaSsh: `ssh -t ${hostName} 'exec "$SHELL" -lc "${attach}"'`,
  };
}
