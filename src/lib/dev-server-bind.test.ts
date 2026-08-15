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
