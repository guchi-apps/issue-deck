#!/usr/bin/env node
// チャット調査の読み取りツールを、1回の`codex exec`へ渡すMCP（stdio）ブリッジ（#4199）。
//
// Codexはこのプロセスを子として起こし、ツール呼び出しを標準入出力のJSON-RPCで送ってくる。
// ここは呼び出しを`POST /api/dispatch/chat-turn/tool`へ中継するだけで、ツールの実行・上限の判定・
// 機密の伏せ字はサーバー側が行う（Codexはリポジトリにも認証情報にも触れない）。
//
//   node chat-tool-bridge.mjs <設定JSONのパス>
//
// 設定JSON（`run-chat-codex.sh`が0600で作る）: {baseUrl, secret, jobId, host, tools:[{name, description}]}
// シークレットは`ps`で見えるコマンドライン・環境変数に置かず、ファイルで受け取る。
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
const CALL_TIMEOUT_MS = 60_000;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "owner/repo。省略すると会話の既定のリポジトリ" },
    number: { type: "integer", description: "IssueまたはPRの番号" },
    path: { type: "string", description: "ファイルのパス" },
    query: { type: "string", description: "検索語" },
    ref: { type: "string", description: "ブランチ・コミット（省略可）" },
  },
  additionalProperties: false,
};

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      description: "同時に取得したい読み取りの一覧（互いに依存しないものだけ）",
      items: {
        type: "object",
        properties: { tool: { type: "string" }, args: INPUT_SCHEMA },
        required: ["tool"],
        additionalProperties: false,
      },
    },
  },
  required: ["calls"],
  additionalProperties: false,
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function toolList() {
  return [
    ...config.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: INPUT_SCHEMA, annotations: READ_ONLY })),
    {
      name: "read_many",
      description: "互いに依存しない複数の読み取りを1回でまとめて実行する。往復を減らすため、独立した取得はこれを使う",
      inputSchema: BATCH_SCHEMA,
      annotations: READ_ONLY,
    },
  ];
}

async function callServer(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/dispatch/chat-turn/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
      body: JSON.stringify({ jobId: config.jobId, host: config.host, name, args }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 回答待ちが終わった（取消・時間切れ・再起動）なら、続けても結果が使われない。Codexごと終える
      if (response.status === 409 || response.status === 403 || response.status === 404) {
        process.stderr.write(`ツール呼び出しが拒否されました（HTTP ${response.status}）。終了します。\n`);
        setTimeout(() => process.exit(3), 50);
      }
      return { isError: true, text: `ツールを実行できませんでした（${body.error ?? response.status}）` };
    }
    return { isError: body.ok === false, text: String(body.text ?? "") };
  } catch (error) {
    return { isError: true, text: `ツールの呼び出しに失敗しました（${error instanceof Error ? error.name : "error"}）` };
  } finally {
    clearTimeout(timer);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "issue-deck-chat", version: "1" },
      },
    });
  } else if (method === "tools/list") {
    send({ id, result: { tools: toolList() } });
  } else if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const result = await callServer(name, args);
    send({ id, result: { content: [{ type: "text", text: result.text }], isError: result.isError } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `未対応のメソッド: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void handle(request);
});
