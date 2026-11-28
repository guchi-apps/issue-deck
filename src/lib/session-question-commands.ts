import { matchManualStepDeviceNames } from "@/lib/manual-step-guide";

/**
 * フェンス付きコードブロック（言語指定は問わない）か、1個のバッククォートで囲んだ部分。
 * 1個の方は`` ` ``が連続する箇所を避ける（閉じが切れたフェンスを誤って拾わないため）
 */
const CODE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```|(?<!`)`([^`\n]+)`(?!`)/g;

/**
 * 1個のバッククォートの中身を「実行するコマンド」とみなす先頭の語。**引数があるときだけ**
 * コマンドとして抜き出すので、`scope`や`git`のような単語1つは地の文に残る
 */
const COMMAND_HEAD_PATTERN =
  /^(?:(?:ssh|cd|git|gh|sudo|npm|npx|pnpm|yarn|node|python3?|pip3?|docker|systemctl|journalctl|launchctl|tmux|curl|brew|apt(?:-get)?|pm2|mysql|op|tailscale|bash|sh|claude|codex)|(?:\.\/|~\/|\/|scripts\/)\S+)\s+\S/;

/** `ssh`のうち、次の語を値として取るオプション */
const SSH_OPTIONS_WITH_VALUE = new Set(["-i", "-p", "-o", "-l", "-J", "-L", "-R", "-D", "-F"]);

export type QuestionCommand = {
  /** コピーする文字列そのもの */
  command: string;
  /** フェンスに添えられた実行する端末（```` ```bash VPS ````）。書かれていなければ`null` */
  device: string | null;
  /** フェンスの言語指定を含む1行目。Issueコメントへ書き戻すときに使う */
  info: string;
};

export type QuestionTextSegment =
  | { type: "text"; value: string }
  /** コマンドではないインラインコード（`scope`など） */
  | { type: "code"; value: string }
  /** 地の文から抜き出したインラインのコマンドがあった位置。`index`は`commands`の添字 */
  | { type: "command"; index: number };

export type QuestionCommandBlocks = {
  /** 地の文。フェンスは取り除き、インラインのコマンドは位置の印に置き換える */
  segments: QuestionTextSegment[];
  /** 抜き出したコマンドの一覧（書かれた順） */
  commands: QuestionCommand[];
};

/**
 * 質問文（`AskUserQuestion`の`question`）に埋め込まれたコマンドを、地の文から切り離す（#2818・#5652）。
 *
 * `question.question`はMarkdownとして描画していないため、そのまま出すとバッククォートが
 * 文字どおり表示され、どこをコピーすればよいのか分からない。**1つのフェンスは1件のまま扱う**
 * （改行・`&&`で分けない）——何回コピーして何回貼るのかを読む側に考えさせないため。
 *
 * **ここで変えるのは表示だけ。** 質問文は回答の照合キーなので、保存した値は書き換えない。
 */
export function extractQuestionCommandBlocks(question: string): QuestionCommandBlocks {
  const segments: QuestionTextSegment[] = [];
  const commands: QuestionCommand[] = [];
  let text = "";
  let last = 0;

  const flushText = () => {
    const value = text.replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n");
    if (value !== "") segments.push({ type: "text", value });
    text = "";
  };

  for (const match of question.matchAll(CODE_PATTERN)) {
    const [whole, info, body, inline] = match;
    text += question.slice(last, match.index);
    last = match.index + whole.length;

    if (inline === undefined) {
      const command = body.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
      if (command !== "") {
        commands.push({ command, device: parseFenceDevice(info), info: info.trim() });
      }
      continue;
    }

    flushText();
    const value = inline.trim();
    if (COMMAND_HEAD_PATTERN.test(value)) {
      segments.push({ type: "command", index: commands.length });
      commands.push({ command: value, device: null, info: "" });
    } else {
      segments.push({ type: "code", value: inline });
    }
  }
  text += question.slice(last);
  flushText();

  return { segments: trimSegments(segments), commands };
}

/** 地の文の両端の空白を落とす */
function trimSegments(segments: QuestionTextSegment[]): QuestionTextSegment[] {
  return segments
    .map((segment, i) => {
      if (segment.type !== "text") return segment;
      let value = segment.value;
      if (i === 0) value = value.trimStart();
      if (i === segments.length - 1) value = value.trimEnd();
      return { type: "text" as const, value };
    })
    .filter((segment) => segment.type !== "text" || segment.value !== "");
}

/** フェンスの1行目に添えられた端末を読む。**書かれた語だけを見て、推測しない** */
function parseFenceDevice(info: string): string | null {
  if (info.includes("手元")) return "手元の端末";
  const names = matchManualStepDeviceNames(info);
  return names.length === 1 ? names[0] : null;
}

/** `ssh`で始まるコマンドの接続先。読み取れなければ`null` */
function sshDestination(command: string): string | null {
  const tokens = command.split(/\s+/);
  if (tokens[0] !== "ssh") return null;
  for (let i = 1; i < tokens.length; i += 1) {
    if (SSH_OPTIONS_WITH_VALUE.has(tokens[i])) i += 1;
    else if (!tokens[i].startsWith("-")) return tokens[i];
  }
  return null;
}

/**
 * コマンドの枠に出す「どこで実行するか」。端末の指定が無いときに言い切れるのは、
 * `ssh`（接続元＝手元の端末で打つもの）だけ。
 */
export function describeQuestionCommandTarget({ command, device }: QuestionCommand): {
  title: string;
  note: string | null;
} {
  const destination = sshDestination(command);
  const where = device ?? (destination !== null ? "手元の端末" : null);
  return {
    title: where !== null ? `${where}で実行` : "実行する端末の指定なし",
    note: destination !== null ? `このコマンドが ${destination} へSSH接続します` : null,
  };
}

/** 1始まりの番号を丸数字にする（20を超えたら数字のまま） */
export function circledNumber(order: number): string {
  return order >= 1 && order <= 20 ? String.fromCodePoint(0x2460 + order - 1) : `(${order})`;
}
