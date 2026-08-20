import { describe, expect, it } from "vitest";

import {
  buildInfraConfigIssueDraft,
  detectInfraConfigTargets,
  resolveInfraConfigDevice,
} from "@/lib/infra-config-repos";

/**
 * 材料は実際の手作業Issueの書かれ方（`## 前提条件`のデバイス行＋`## やること`の
 * チェック項目＋インデントしたコードブロック）に合わせる。**取りこぼしよりも誤検出を
 * 避ける**方針なので、当たらないことを確かめるテストを多めに置く。
 */
function buildBody(params: { device?: string; todo: string }): string {
  const prerequisites = params.device
    ? `## 前提条件

- 実行するデバイス: **${params.device}**
- カレントディレクトリ: 不要
- Gitブランチ: 不要

`
    : "";
  return `## この作業でできるようになること

- **できるようになること**: 例。

${prerequisites}## やること

${params.todo}

## 完了の確認方法

\`\`\`bash
echo ok
\`\`\`
`;
}

describe("resolveInfraConfigDevice", () => {
  it("VPS・サブPCを読み分け、メインPCと不明はnullにする", () => {
    expect(resolveInfraConfigDevice("VPS（`ssh vps`）")).toBe("vps");
    expect(resolveInfraConfigDevice("サブPC")).toBe("subpc");
    expect(resolveInfraConfigDevice("subpc")).toBe("subpc");
    expect(resolveInfraConfigDevice("メインPC")).toBeNull();
    expect(resolveInfraConfigDevice("ブラウザ")).toBeNull();
    expect(resolveInfraConfigDevice(null)).toBeNull();
  });
});

describe("detectInfraConfigTargets", () => {
  it("VPSのApache設定を書き換える手順を、vpsリポジトリの置き場所へ対応付ける", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] VirtualHostを配置する

    \`\`\`bash
    sudo cp aide.gucchii.com.conf /etc/apache2/sites-available/aide.gucchii.com.conf
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].repo.repositoryFullName).toBe("guchi-apps/vps");
    expect(targets[0].entry.repoPath).toBe("apache/sites-available/");
    expect(targets[0].stepText).toContain("VirtualHostを配置する");
  });

  it("サブPCのログインシェル設定を、subpcリポジトリの置き場所へ対応付ける", () => {
    const body = buildBody({
      device: "サブPC",
      todo: `- [ ] PATHを追記する

    \`\`\`bash
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile.local
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].repo.repositoryFullName).toBe("guchi-apps/subpc");
    expect(targets[0].entry.repoPath).toBe("configs/bash/profile.local");
  });

  it("読み取るだけの手順には当てない", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] 設定を確認する

    \`\`\`bash
    cat /etc/apache2/sites-available/aide.gucchii.com.conf
    \`\`\``,
    });

    expect(detectInfraConfigTargets(body)).toEqual([]);
  });

  it("管理下に無いパスには当てない", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] .envを書き換える

    \`\`\`bash
    nano ~/apps/issue-deck/.env
    \`\`\``,
    });

    expect(detectInfraConfigTargets(body)).toEqual([]);
  });

  it("デバイスが読めず、VPS・サブPCの両方に当たるパスは切り出さない", () => {
    const body = buildBody({
      todo: `- [ ] ユニットを置く

    \`\`\`bash
    sudo cp 10-subpc-port.conf /etc/systemd/system/ssh.socket.d/10-subpc-port.conf
    \`\`\``,
    });

    expect(detectInfraConfigTargets(body)).toEqual([]);
  });

  it("デバイスが読めないときは、ホーム配下のパスには当てない", () => {
    const body = buildBody({
      todo: `- [ ] ユニットを配置する

    \`\`\`bash
    cp signaly.service ~/.config/systemd/user/signaly.service
    \`\`\``,
    });

    expect(detectInfraConfigTargets(body)).toEqual([]);
  });

  it("デバイスが分かっていればホーム配下のパスにも当てる", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] ユニットを配置する

    \`\`\`bash
    cp signaly.service ~/.config/systemd/user/signaly.service
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].entry.repoPath).toBe("systemd/user/");
  });

  it("デバイスが読めなくても、当たるリポジトリが1つなら切り出す", () => {
    const body = buildBody({
      todo: `- [ ] fail2banの設定を修正する

    \`\`\`bash
    sudo nano /etc/fail2ban/jail.local
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].repo.repositoryFullName).toBe("guchi-apps/vps");
  });

  it("デバイスが分かっていれば、長いパスの対応を優先する", () => {
    const body = buildBody({
      device: "サブPC",
      todo: `- [ ] ssh.socketのポートを変更する

    \`\`\`bash
    sudo cp ssh-socket-port.conf /etc/systemd/system/ssh.socket.d/10-subpc-port.conf
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].entry.repoPath).toBe("configs/ssh/ssh-socket-port.conf");
  });

  it("パスとして現れないcrontabの編集も拾う", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] バックアップのcronを追加する

    \`\`\`bash
    crontab -e
    \`\`\``,
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].entry.repoPath).toBe("cron/crontab.txt");
  });

  it("見出し文だけで書かれた手順も、書き換えを言っていれば拾う", () => {
    const body = buildBody({
      device: "VPS",
      todo: "- [ ] `/etc/apache2/sites-available/aide.gucchii.com.conf` を編集してProxyPassを追加する",
    });

    const targets = detectInfraConfigTargets(body);
    expect(targets).toHaveLength(1);
    expect(targets[0].entry.repoPath).toBe("apache/sites-available/");
  });

  it("同じ手順で同じ置き場所に何度当たっても1件にまとめる", () => {
    const body = buildBody({
      device: "VPS",
      todo: `- [ ] 2つのVirtualHostを配置する

    \`\`\`bash
    sudo cp a.conf /etc/apache2/sites-available/a.conf
    sudo cp b.conf /etc/apache2/sites-available/b.conf
    \`\`\``,
    });

    expect(detectInfraConfigTargets(body)).toHaveLength(1);
  });

  it("テンプレートに沿っていない本文は手順に割れないので何も返さない", () => {
    expect(detectInfraConfigTargets("VPSの /etc/apache2/sites-available/x.conf を編集する")).toEqual(
      [],
    );
    expect(detectInfraConfigTargets(null)).toEqual([]);
  });
});

describe("buildInfraConfigIssueDraft", () => {
  const body = buildBody({
    device: "VPS",
    todo: `- [ ] VirtualHostを配置する

    \`\`\`bash
    sudo cp aide.gucchii.com.conf /etc/apache2/sites-available/aide.gucchii.com.conf
    \`\`\``,
  });

  it("対象リポジトリ・置き場所・起点・元の手順を含む下書きを組み立てる", () => {
    const [target] = detectInfraConfigTargets(body);
    const draft = buildInfraConfigIssueDraft({
      target,
      originRepositoryFullName: "guchi-apps/issue-deck",
      originNumber: 2001,
      originTitle: "[手作業] VPS: aideのVirtualHostを追加する",
    });

    expect(draft.repositoryFullName).toBe("guchi-apps/vps");
    expect(draft.title).toContain("apache/sites-available/");
    expect(draft.title).toContain("guchi-apps/issue-deck#2001");
    expect(draft.body).toContain("guchi-apps/issue-deck#2001");
    expect(draft.body).toContain("`apache/sites-available/`");
    expect(draft.body).toContain("sudo cp aide.gucchii.com.conf");
    expect(draft.body).toContain("scripts/apply.sh");
  });

  it("反映のされ方が既定と違う対応では、その但し書きを使う", () => {
    const netplanBody = buildBody({
      device: "サブPC",
      todo: `- [ ] ネットワーク設定を修正する

    \`\`\`bash
    sudo nano /etc/netplan/01-netcfg.yaml
    \`\`\``,
    });
    const [target] = detectInfraConfigTargets(netplanBody);
    const draft = buildInfraConfigIssueDraft({
      target,
      originRepositoryFullName: "guchi-apps/issue-deck",
      originNumber: 1,
      originTitle: "[手作業] サブPC: ネットワーク設定を直す",
    });

    expect(draft.body).toContain("`netplan apply`と再起動は自動では行われない");
  });
});
