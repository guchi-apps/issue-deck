import { describe, expect, it } from "vitest";

import { buildManualStepQueue, parseManualStepGuide } from "@/lib/manual-step-guide";
import type { ManualStepReadinessMap } from "@/lib/manual-step-attention";
import type { Issue } from "@/types/issue";

/**
 * 材料は**実物の手作業Issueの本文**（#1823・#1795・guchi-apps/aide#59）。
 * 合成した理想的な本文だけで固めると、太字・括弧書きの補足・インデント幅の揺れ・
 * チェック項目の前に置かれた前置きといった実際の書かれ方を踏まない。
 */

/** #1823 サブPC: issue-deckのチェックアウトを更新してpollerを再起動する */
const ISSUE_1823 = `## この作業でできるようになること

- **できるようになること**: サブPCの回収スクリプトが、猶予待ちのセッションに理由を残すようになる。
- **実行するまでできないこと**: 画面には残り時間が一切出ない。

## 前提条件

- 実行するデバイス: **サブPC**（メインPCからなら \`ssh subpc\`）
- カレントディレクトリ: \`~/apps/issue-deck\`
- Gitブランチ: \`develop\`（本体チェックアウトがdevelopのため）
- 先に完了している必要があるIssue／PR: **#1822 がdevelopへマージされていること**
- その他の前提: \`issue-deck-dispatch-poller.service\`（systemd user unit）が動いていること

## やること

- [ ] 本体チェックアウトを最新のdevelopへ更新する

    \`\`\`bash
    cd ~/apps/issue-deck
    git pull --ff-only
    \`\`\`

- [ ] pollerを再起動する（常駐プロセスが読み込み中のファイルなので、pullとセットで行う）

    \`\`\`bash
    systemctl --user restart issue-deck-dispatch-poller.service
    \`\`\`

## 完了の確認方法

- 遅れが0になっていること（\`0\`が出れば最新）

    \`\`\`bash
    git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop   # 0 なら最新
    \`\`\`

## なぜエージェントが実施しないか

\`~/apps/issue-deck\`は本体チェックアウトで、実装エージェントが作業してよいのは自分のworktreeだけ。

## 関連

- 起点Issue: #1817
- 対応PR: #1822
`;

/** #1795 共有ワークフローのタグ配布。コードブロックのインデントが2スペース */
const ISSUE_1795 = `## この作業でできるようになること

- できるようになること: 他リポジトリでも受付コメントが消えるようになる

## 前提条件

- 実行するデバイス: ブラウザ（issue-deckの画面）とサブPCのどちらでもよい
- カレントディレクトリ: \`~/apps/issue-deck\`（画面から配る場合は不要）
- Gitブランチ: \`develop\`
- 先に完了している必要があるIssue・PR: #1794 が\`develop\`へマージされていること

## やること

- [x] \`main\`に#1794の内容が入っていることを確認する

  \`\`\`bash
  cd ~/apps/issue-deck
  git fetch origin
  \`\`\`

- [ ] \`workflows/v21\`タグを\`main\`に切って push する

  \`\`\`bash
  git tag workflows/v21 origin/main
  git push origin workflows/v21
  \`\`\`

- [ ] issue-deckの画面から\`workflows/v21\`を対象リポジトリへ配り、配布PRをマージする

## 完了の確認方法

- \`git ls-remote --tags origin | grep workflows/v21\` で1行返る
`;

/**
 * guchi-apps/ops-dashboard#59 相当（実物は ops-dashboard#90）。コマンドを**インデント記法の
 * コードブロック**（`- [x] `の下に6スペース）で書いた本文。テンプレートの文言が
 * 「インデントしたコードブロック」なので、フェンスを付けずにこう書かれることが実際にある。
 */
const OPS_90 = `## この作業でできるようになること

- **できるようになること**: 読み取りAPIがトークンで通るようになる。

## 前提条件

- **実行するデバイス**: サブPC
- **カレントディレクトリ**: \`~/apps/ops-dashboard\`
- **Gitブランチ**: \`develop\`

## やること

- [x] ランダムなトークンを生成する（32文字以上。値は端末の履歴やログに残さないよう注意する）

      openssl rand -hex 32

- [x] GitHub の secret へ同期する

      cd ~/apps/ops-dashboard
      git switch develop && git pull

## 完了の確認方法

1. GitHub 側に secret が入っていること

       gh secret list --repo guchi-apps/ops-dashboard | grep OPS_API_TOKEN
`;

/** guchi-apps/aide#59 チェック項目の前に前置きがあり、ラベルが太字 */
const AIDE_59 = `## この作業でできるようになること

- **できるようになること**: 本番のトークン3つが1Password経由で配られるようになる。

## 前提条件

- **実行するデバイス**: サブPC（1Passwordの操作は \`op\` CLI、同期は \`~/apps/aide\`）。確認にVPSへのSSHを使う
- **カレントディレクトリ**: \`/home/guchi/apps/aide\`
- **Gitブランチ**: \`develop\`（\`scripts/sync-github-secrets.sh\` は #55 のPRがマージされたものを使う）
- **先に完了している必要があるIssue・PR**: #55 の対応PRが \`develop\` へマージ済みであること

## やること

\`AIDE_GITHUB_TOKEN\` は**現在VPSの \`.env\` だけが正**なので、新規発行ではなく**そこから1Passwordへ移す**。

- [ ] VPSの \`.env\` から現在値を控える

    \`\`\`bash
    ssh vps
    grep -E '^(AIDE_GITHUB_TOKEN)=' .env
    \`\`\`

- [ ] 1Passwordへフィールドを作り、控えた値を入れる

## 完了の確認方法

- \`gh secret list\` に3件出ること
`;

describe("parseManualStepGuide", () => {
  it("テンプレートどおりの本文を、目的・実行する場所・手順・確認方法へ割る（#1823）", () => {
    const guide = parseManualStepGuide(ISSUE_1823);

    expect(guide.hasTemplate).toBe(true);
    expect(guide.outcome).toContain("猶予待ちのセッションに理由を残す");
    expect(guide.where).toEqual({
      connect: "ssh subpc",
      device: "サブPC",
      directory: "~/apps/issue-deck",
      branch: "develop",
    });
    expect(guide.steps).toHaveLength(2);
    expect(guide.verification).toContain("遅れが0になっていること");
  });

  it("手順の行番号は本文のチェック行を指し、コードブロックはインデントを戻して付く（#1823）", () => {
    const guide = parseManualStepGuide(ISSUE_1823);
    const lines = ISSUE_1823.split("\n");

    for (const step of guide.steps) {
      expect(step.line).not.toBeNull();
      // `toggleTaskListLine`がその行を書き換えられること＝チェック行を指していること
      expect(lines[(step.line as number) - 1]).toMatch(/^-\s\[[ xX]\]\s/);
    }
    expect(guide.steps[0].text).toBe("本体チェックアウトを最新のdevelopへ更新する");
    expect(guide.steps[0].markdown).toBe(
      "本体チェックアウトを最新のdevelopへ更新する\n\n```bash\ncd ~/apps/issue-deck\ngit pull --ff-only\n```",
    );
  });

  it("`## なぜエージェントが実施しないか`のコードブロックや後続の節を手順へ混ぜない（#1823）", () => {
    const guide = parseManualStepGuide(ISSUE_1823);
    const joined = guide.steps.map((step) => step.markdown).join("\n");

    expect(joined).not.toContain("起点Issue");
    expect(joined).not.toContain("本体チェックアウトで、実装エージェント");
  });

  it("チェック済みの手順は`checked`で返す（#1795）", () => {
    const guide = parseManualStepGuide(ISSUE_1795);

    expect(guide.steps.map((step) => step.checked)).toEqual([true, false, false]);
  });

  it("インデントが2スペースのコードブロックも手順に付く（#1795）", () => {
    const guide = parseManualStepGuide(ISSUE_1795);

    expect(guide.steps[1].markdown).toContain("```bash\ngit tag workflows/v21 origin/main");
  });

  it("インデント記法のコードブロックを潰さない（ops-dashboard#90・#1835）", () => {
    const guide = parseManualStepGuide(OPS_90);

    // 行頭に4スペース以上が残っていること＝コードブロックとして描かれること。
    // ここが潰れると本文と同じ字で並ぶだけになり、コピーボタン（#1726）も出ない
    expect(guide.steps[0].markdown).toBe(
      "ランダムなトークンを生成する（32文字以上。値は端末の履歴やログに残さないよう注意する）\n\n    openssl rand -hex 32",
    );
    expect(guide.steps[1].markdown).toBe(
      "GitHub の secret へ同期する\n\n    cd ~/apps/ops-dashboard\n    git switch develop && git pull",
    );
    expect(guide.verification).toContain(
      "       gh secret list --repo guchi-apps/ops-dashboard",
    );
  });

  it("インデント記法のコードブロックの中にある```をフェンスとして扱わない（#1835）", () => {
    const guide = parseManualStepGuide(
      "## やること\n\n- [ ] 例を貼る\n\n      ```bash\n      echo hi\n      ```\n",
    );

    // 4スペース以上下がった```はコードブロックの中身。フェンスとして読むと中身まで
    // 列0へ寄せてしまい、`echo hi`がコードブロックの外へ出る
    expect(guide.steps[0].markdown).toBe("例を貼る\n\n    ```bash\n    echo hi\n    ```");
  });

  it("チェックリストが無くインデント記法のコードブロックだけの節も潰さない（#1835）", () => {
    const guide = parseManualStepGuide("## やること\n\n    echo X=1 >> .env\n");

    expect(guide.steps).toHaveLength(1);
    expect(guide.steps[0].markdown).toBe("    echo X=1 >> .env");
  });

  it("コードブロックを持たない手順は見出し文だけになる（#1795）", () => {
    const guide = parseManualStepGuide(ISSUE_1795);

    expect(guide.steps[2].markdown).toBe(
      "issue-deckの画面から`workflows/v21`を対象リポジトリへ配り、配布PRをマージする",
    );
  });

  it("末尾の括弧書きだけを落とし、途中の括弧は残す（#1795）", () => {
    const guide = parseManualStepGuide(ISSUE_1795);

    expect(guide.where.directory).toBe("~/apps/issue-deck");
    expect(guide.where.device).toBe("ブラウザ（issue-deckの画面）とサブPCのどちらでもよい");
  });

  it("ラベルが太字でも実行する場所を拾う（aide#59）", () => {
    const guide = parseManualStepGuide(AIDE_59);

    expect(guide.where.directory).toBe("/home/guchi/apps/aide");
    expect(guide.where.branch).toBe("develop");
    expect(guide.where.device).toContain("サブPC");
  });

  it("チェック項目の前に置かれた前置きを落とさない（aide#59）", () => {
    const guide = parseManualStepGuide(AIDE_59);

    expect(guide.todoIntro).toContain("新規発行ではなく");
    expect(guide.steps).toHaveLength(2);
    expect(guide.steps[0].markdown).not.toContain("新規発行ではなく");
  });

  it("チェックリストの無い`## やること`は節ごと1手順にする", () => {
    const guide = parseManualStepGuide(
      "## やること\n\nVPSの`.env`へ1行足して再起動する。\n\n```bash\necho X=1 >> .env\n```\n",
    );

    expect(guide.hasTemplate).toBe(true);
    expect(guide.steps).toHaveLength(1);
    expect(guide.steps[0].line).toBeNull();
    expect(guide.steps[0].text).toBe("VPSの.envへ1行足して再起動する。");
  });

  it("`## やること`が無い本文は手順に割らない（テンプレート外）", () => {
    const guide = parseManualStepGuide("設定画面でトークンを入れ替えてください。");

    expect(guide.hasTemplate).toBe(false);
    expect(guide.steps).toEqual([]);
    expect(guide.where).toEqual({
      device: null,
      directory: null,
      branch: null,
      connect: null,
    });
  });

  it("本文が空でも落ちない", () => {
    expect(parseManualStepGuide(null).hasTemplate).toBe(false);
    expect(parseManualStepGuide("").steps).toEqual([]);
  });

  it("「不要」「なし」はチップに出さない", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: ブラウザ\n- カレントディレクトリ: 不要\n- Gitブランチ: なし\n\n## やること\n\n- [ ] 押す\n",
    );

    expect(guide.where).toEqual({
      device: "ブラウザ",
      directory: null,
      branch: null,
      connect: null,
    });
  });

  it("コードブロックの中の`#`を見出しとして扱わない", () => {
    const guide = parseManualStepGuide(
      "## やること\n\n- [ ] 実行する\n\n    ```bash\n    # 完了の確認方法\n    echo ok\n    ```\n\n## 完了の確認方法\n\n- `echo ok`が通ること\n",
    );

    expect(guide.steps).toHaveLength(1);
    expect(guide.steps[0].markdown).toContain("# 完了の確認方法");
    expect(guide.verification).toBe("- `echo ok`が通ること");
  });
});

function issue(id: string, updatedAt: string): Issue {
  return { id, updatedAt } as Issue;
}

function readiness(entries: Record<string, boolean>): ManualStepReadinessMap {
  return new Map(
    Object.entries(entries).map(([id, ready]) => [id, { ready, blocking: [], message: "" }]),
  );
}

describe("buildManualStepQueue", () => {
  it("いま実行できる手作業だけを、更新の古い順に並べる", () => {
    const issues = [
      issue("a", "2026-08-10T00:00:00Z"),
      issue("b", "2026-08-01T00:00:00Z"),
      issue("c", "2026-08-05T00:00:00Z"),
    ];

    const queue = buildManualStepQueue(issues, readiness({ a: true, b: true, c: false }));

    expect(queue.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("起点のIssueは先頭に置き、前提待ちでも外さない", () => {
    const issues = [issue("a", "2026-08-01T00:00:00Z"), issue("b", "2026-08-02T00:00:00Z")];

    const queue = buildManualStepQueue(issues, readiness({ a: true, b: false }), "b");

    expect(queue.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("起点のIssueを二重に並べない", () => {
    const issues = [issue("a", "2026-08-01T00:00:00Z"), issue("b", "2026-08-02T00:00:00Z")];

    const queue = buildManualStepQueue(issues, readiness({ a: true, b: true }), "a");

    expect(queue.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("verificationRange（#1869）", () => {
  it("`## 完了の確認方法`の行範囲を返す（確認節のコマンドを本文の行番号で指すため）", () => {
    const guide = parseManualStepGuide(ISSUE_1823);
    const lines = ISSUE_1823.split("\n");
    const range = guide.verificationRange;

    expect(range).not.toBeNull();
    // 節の見出しの次の行から始まる
    expect(lines[(range as { start: number }).start - 2]).toMatch(/^##\s.*確認方法/);
    // 範囲の中に確認のコマンドが含まれ、次の節の見出しは含まれない
    const inside = lines
      .slice((range as { start: number }).start - 1, (range as { end: number }).end)
      .join("\n");
    expect(inside).toContain("遅れが0になっていること");
    expect(inside).not.toMatch(/^##\s/m);
  });

  it("確認方法が書かれていない本文ではnull", () => {
    expect(parseManualStepGuide("## やること\n\n- [ ] 何かする").verificationRange).toBeNull();
    expect(parseManualStepGuide(null).verificationRange).toBeNull();
  });
});
