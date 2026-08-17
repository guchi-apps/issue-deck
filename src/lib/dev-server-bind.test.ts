import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 開発サーバーの待ち受けアドレスの契約を固定する（#1526）。
//
// `next dev` の既定は全インターフェース（`::`）で、Tailscaleに参加しているホストでは
// **tailnet上の他端末からそのまま到達できる**。issue-1309のdevサーバーが `*:5309` で
// 待ち受けていたのがこれで、原因は「閉じる処理が条件付きだった」ことにある
// （`ISSUE_DECK_DEV_HOST` のexportか、そのポートが `tailscale serve` で公開中か・#1329）。
//
// worktreeは分岐した時点のスクリプトを持ち続けるため、**一度緩めると古いworktreeの数だけ
// 残り続け、後から直しても遡っては効かない**。既定が反転していないことをここで固定する。
//
// シェルスクリプトを実行して確かめる形にはしない。`scripts/dev.sh` は `.env.local` を読み、
// `setup-lan-access.sh` と smee を起こすため、テストから実行すると副作用が出る。
// `.github/workflows/reusable-workflow-contract.test.ts` と同じく、内容の検査に留める。
const SCRIPTS_DIR = join(process.cwd(), "scripts");

function read(relativePath: string): string {
  return readFileSync(join(SCRIPTS_DIR, relativePath), "utf8");
}

/** 行頭の `#` から始まるコメント行を落とす（説明文中の記述を拾わないため） */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("開発サーバーの待ち受けアドレス（#1526）", () => {
  it("scripts/dev.sh の既定は 127.0.0.1 で、環境変数が未指定でも -H を渡す", () => {
    const source = withoutComments(read("dev.sh"));

    // 既定値そのもの。`${ISSUE_DECK_DEV_HOST:-}`（既定なし）に戻すとここで落ちる。
    expect(source).toMatch(/DEV_HOST="\$\{ISSUE_DECK_DEV_HOST:-127\.0\.0\.1\}"/);
    // `-H` は常に渡す。条件付きで組み立てる形に戻っていないこと。
    expect(source).toMatch(/HOST_ARGS=\(-H "\$DEV_HOST"\)/);
    expect(source).toContain('next dev -p "${PORT}" "${HOST_ARGS[@]}"');
  });

  it("待ち受けを 0.0.0.0 に直書きしない（IPv4だけに絞られ、tailnetのIPv6から見えなくなる）", () => {
    for (const name of ["dev.sh", "start-develop-dev.sh", "run-issue-session.sh"]) {
      expect(withoutComments(read(name))).not.toMatch(/-H\s+0\.0\.0\.0/);
    }
  });

  it("scripts/run-issue-session.sh は条件を付けずに ISSUE_DECK_DEV_HOST=127.0.0.1 を渡す", () => {
    const source = withoutComments(read("run-issue-session.sh"));

    // `tailscale serve` が使えるホストかどうかで分けない。分けると、#1329より前に作られた
    // worktree（自前の dev.sh に閉じる判定を持たない）が起動経路ごと素通りする。
    expect(source).toMatch(/:\s*"\$\{ISSUE_DECK_DEV_HOST:=127\.0\.0\.1\}"/);
    expect(source).toMatch(/export ISSUE_DECK_DEV_HOST/);
    expect(source).not.toMatch(/if.*ISSUE_DECK_DEV_HOST.*tailscale_serve_available/);
  });

  it("develop常駐サーバーは tailscale serve で公開し、停止時に撤去する", () => {
    const source = withoutComments(read("start-develop-dev.sh"));

    // 待ち受けを閉じたぶん、tailnetへ出す手段はserveに一本化されている。
    expect(source).toContain("tailscale_serve_publish");
    // 撤去し忘れると繋がらないURLが残るうえ、そのポートで next dev が起こせなくなる（#1403）。
    expect(source).toContain("tailscale_serve_unpublish");
  });

  it("scripts/dev.sh は起動のたびに tailscale serve を張り直す（#1363）", () => {
    const source = withoutComments(read("dev.sh"));

    // 開発サーバーだけがアイドルで回収されると（#1223）、転送先に待ち受けが無くなるため
    // reap-dev-servers.sh が serve を孤児として撤去する（#1403）。張り直す一手が
    // **手で `pnpm dev` を叩き直す経路**に無いと、localhostでは見えるのに
    // tailnetのURL（issue-deckの画面に出たまま）が死んだままになる。
    expect(source).toContain("lib/tailscale-serve.sh");
    expect(source).toContain("tailscale_serve_publish");

    // 待ち受けを開けているときは張らない。serveがtailnetアドレスを先に掴むと、
    // `::` を要求する next dev が EADDRINUSE で起動できなくなる。
    expect(source).toMatch(/dev_host_is_loopback "\$DEV_HOST"/);
  });

  it("tailnetへの公開を知らせる文面は起動経路のあいだで揃っている（#1363）", () => {
    // プロンプト（scripts/start-issue.sh）が「起動ログのこの行に出ているURLを使う」と
    // 案内しているため、経路ごとに文面が割れると案内の側から拾えなくなる。
    const marker = "開発サーバーをtailnetへ公開しました";

    expect(read("dev.sh")).toContain(marker);
    expect(read("run-issue-session.sh")).toContain(marker);
    expect(read("start-issue.sh")).toContain(marker);
  });

  it("scripts/lib/dev-server.sh の全インターフェース判定は tailscale serve 自身の待ち受けを拾わない", () => {
    const source = read("lib/dev-server.sh");

    expect(source).toContain("dev_server_wildcard_listening");
    // 拾うのはワイルドカードだけ。具体的なtailnetアドレス（100.x / [fd7a:...]）はserve自身のもので、
    // これを拾うと公開中のセッションすべてが警告対象になる。
    const body = /dev_server_wildcard_listening\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(body).toContain("'*' | '0.0.0.0' | '[::]'");
    expect(body).not.toContain("127.");
  });
});
