"use client";

import { useEffect, useState } from "react";

import { Check, Copy, Terminal } from "lucide-react";

import packageJson from "../../../package.json";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  readLocalSessionRegisteredVersion,
  writeLocalSessionRegisteredVersion,
} from "@/lib/local-session-setup";
import {
  LOCAL_SESSION_DEFAULT_WSL_DISTRO,
  LOCAL_SESSION_REGISTER_COMMAND,
  LOCAL_SESSION_REPO_PATH,
  LOCAL_SESSION_TEST_ISSUE_NUMBER,
  LOCAL_SESSION_TEST_URL,
  LOCAL_SESSION_URL_SCHEME,
  LOCAL_SESSION_WSL_DISTRO_ENV,
} from "@/lib/local-session";

type LocalSessionSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** このIssue向けのフォールバック起動コマンド（「ローカル起動コマンドをコピー」と同じもの） */
  localSessionCommand: string;
};

/** コピーできるコマンド1行。コピー後は一時的にラベルを変えて、押したことが分かるようにする */
function CommandBlock({ command, onCopy }: { command: string; onCopy?: () => void }) {
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (!isCopied) return;
    const timer = window.setTimeout(() => setIsCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [isCopied]);

  function handleCopy() {
    void navigator.clipboard.writeText(command);
    setIsCopied(true);
    onCopy?.();
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
      <code className="font-mono text-xs break-all whitespace-pre-wrap">{command}</code>
      <Button variant="outline" size="xs" className="w-fit" onClick={handleCopy}>
        {isCopied ? <Check /> : <Copy />}
        {isCopied ? "コピーしました" : "コピー"}
      </Button>
    </div>
  );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * ローカル起動（`issuedeck://`）の初回セットアップ手順を表示するダイアログ（#1088）。
 *
 * プロトコルが登録済みかどうかは**ブラウザからは検知できない**（詳細は
 * `src/lib/local-session-setup.ts`）。「押したのに何も起きない」を検知して出すのではなく、
 * 初回のボタン押下時に一度だけ自動で開き、以降は「…」メニューから任意に開ける形にしている。
 *
 * 手順自体は[docs/multi-agent/local-quick-start.md](../../../docs/multi-agent/local-quick-start.md)
 * にもあるが、画面から辿れないと「ボタンを押しても何も起きない」状態から自力でドキュメントへ
 * 行き着く必要がある。ここに出すのはそのため。
 */
export function LocalSessionSetupDialog({
  open,
  onOpenChange,
  localSessionCommand,
}: LocalSessionSetupDialogProps) {
  const currentVersion = packageJson.version;
  const [registeredVersion, setRegisteredVersion] = useState<string | null>(null);

  // localStorageはサーバー側では読めないため、開いた時点で読み込む。
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRegisteredVersion(readLocalSessionRegisteredVersion());
  }, [open]);

  function handleRegisterCommandCopied() {
    writeLocalSessionRegisteredVersion(currentVersion);
    setRegisteredVersion(currentVersion);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>ローカル起動のセットアップ</DialogTitle>
          <DialogDescription>
            「ローカルで開始」を使うには、Windows側に
            <code className="font-mono">{LOCAL_SESSION_URL_SCHEME}://</code>
            プロトコルを登録しておく必要があります（初回1回だけ）。登録されていない環境では、ボタンを押しても何も起きません。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Step title="1. プロトコルを登録する">
            <p className="text-xs text-muted-foreground">
              WSLのターミナルに貼り付けて実行します（Windows側のPowerShellスクリプトですが、WSLから起動できます）。管理者権限は不要です。
            </p>
            <CommandBlock
              command={LOCAL_SESSION_REGISTER_COMMAND}
              onCopy={handleRegisterCommandCopied}
            />
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              <li>
                リポジトリを<code className="font-mono">{LOCAL_SESSION_REPO_PATH}</code>
                以外に置いている場合は、パスを読み替えてください。
              </li>
              <li>
                WSLのディストロ名が<code className="font-mono">{LOCAL_SESSION_DEFAULT_WSL_DISTRO}</code>
                でない場合は、Windows側の環境変数
                <code className="font-mono">{LOCAL_SESSION_WSL_DISTRO_ENV}</code>
                にディストロ名を設定してから実行してください。
              </li>
            </ul>
          </Step>

          <Step title="2. 登録できたか確認する">
            <p className="text-xs text-muted-foreground">
              下のリンクを押すとWindows Terminalが開き、「issue #
              {LOCAL_SESSION_TEST_ISSUE_NUMBER}{" "}
              の取得に失敗しました」で止まります。そこまで進めば、登録からWSLの受け口までが繋がっています。実在しないIssue番号なので、ブランチもworktreeも作られません。
            </p>
            <Button variant="outline" size="xs" className="w-fit" asChild>
              <a href={LOCAL_SESSION_TEST_URL}>
                <Terminal />
                動作確認する
              </a>
            </Button>
            <code className="font-mono text-xs break-all text-muted-foreground">
              {LOCAL_SESSION_TEST_URL}
            </code>
          </Step>

          <Step title="3. 更新したら登録し直す">
            <p className="text-xs text-muted-foreground">
              登録時にハンドラと受け口スクリプトが固定の場所へ複製されるため、issue-deck側でそれらを更新しても自動では反映されません。アプリを更新した後に起動できなくなったら、1のコマンドをもう一度実行してください。
            </p>
            <p className="text-xs text-muted-foreground">
              現在のバージョン: <span className="font-mono">v{currentVersion}</span>
              {registeredVersion === null ? (
                "（この画面から登録コマンドをコピーした記録はありません）"
              ) : registeredVersion === currentVersion ? (
                "（この版の登録コマンドをコピー済み）"
              ) : (
                <>
                  （最後にコピーしたのは<span className="font-mono">v{registeredVersion}</span>
                  のとき。更新されているので登録し直すことをおすすめします）
                </>
              )}
            </p>
          </Step>

          <Step title="4. 登録せずに起動する">
            <p className="text-xs text-muted-foreground">
              プロトコルを登録しない場合は、このコマンドをWSLのターミナルに貼れば同じセッションが起動します（このIssue専用）。
            </p>
            <CommandBlock command={localSessionCommand} />
          </Step>
        </div>
      </DialogContent>
    </Dialog>
  );
}
