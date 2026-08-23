import { describe, expect, it } from "vitest";

import {
  chooseAvailablePort,
  collectHostnameUsage,
  describeUsedPorts,
  isHostnameTaken,
  parseLocationCell,
  parseServerNames,
  parseVpsInventory,
  usedPorts,
} from "@/lib/new-app/vps-inventory";

/** `guchi-apps/vps`のREADMEから、解析に関わる部分だけを抜き出したもの。 */
const README = `# vps

## アプリ一覧

ドメイン・ポート・プロセス管理方式の一次情報はこの表のみです。

| アプリ | 説明 | ドメイン / ポート | プロセス管理 | リポジトリ / ecosystem |
|-------|------|------------------|------------|----------------------|
| car-care | 車の記録 | car.gucchii.com / 3104 | PM2（プロセス名 \`car-app\`） | [m-guchi/car-care](https://github.com/m-guchi/car-care) |
| shopping-list | 買い物リスト | gucchii.com/shopping-list / 3101 | PM2 | [m-guchi/shopping-list](https://github.com/m-guchi/shopping-list) |
| aide | ハブ | aide.gucchii.com / 3114 | PM2 | [guchi-apps/aide](https://github.com/guchi-apps/aide) |
| solitaire | ソリティア | klondike.game.gucchii.com | Apache DocumentRoot（静的ファイル） | [m-guchi/solitaire](https://github.com/m-guchi/solitaire) |
| wifi-speed | Raspberry Pi 上で運用 | — | — | [m-guchi/wifi-speed](https://github.com/m-guchi/wifi-speed) |

PM2全体の自動起動は systemd が担っている。

| ユニット | 所有ユーザー | 稼働中の扱い |
|---|---|---|
| \`signaly.service\` | \`github-user\` | 再起動しない |

### 予約済みポート（未デプロイ）

まだ本番稼働していないが、アプリ側で本番ポートを決め打ちしているものを先にここへ記録する。

| ポート | アプリ | 想定ドメイン | 出典 | 状態 |
|-------|-------|-------------|------|------|
| 3115 | kakei-report | kakei-report.gucchii.com | #2188 | 予約 |

払い出し済みを除いた空きは **3103**・**3112**、および **3114以降**。

## 構成
`;

describe("parseLocationCell", () => {
  it("サブドメインとポート", () => {
    expect(parseLocationCell("car.gucchii.com / 3104")).toEqual({
      hostname: "car.gucchii.com",
      basePath: null,
      port: 3104,
    });
  });

  it("パス配置はホスト名とパスに割る（パス中のスラッシュと取り違えない）", () => {
    expect(parseLocationCell("gucchii.com/shopping-list / 3101")).toEqual({
      hostname: "gucchii.com",
      basePath: "shopping-list",
      port: 3101,
    });
  });

  it("ポートを持たない静的サイト", () => {
    expect(parseLocationCell("klondike.game.gucchii.com")).toEqual({
      hostname: "klondike.game.gucchii.com",
      basePath: null,
      port: null,
    });
  });

  it("VPS外は空", () => {
    expect(parseLocationCell("—")).toEqual({ hostname: null, basePath: null, port: null });
  });
});

describe("parseVpsInventory", () => {
  const inventory = parseVpsInventory(README);

  it("アプリ一覧の表だけを読み、後続の別の表を混ぜない", () => {
    expect(inventory.apps.map((app) => app.name)).toEqual([
      "car-care",
      "shopping-list",
      "aide",
      "solitaire",
      "wifi-speed",
    ]);
  });

  it("予約済みポートの表も読む", () => {
    expect(inventory.reserved).toEqual([
      { port: 3115, app: "kakei-report", hostname: "kakei-report.gucchii.com" },
    ]);
  });
});

describe("usedPorts / chooseAvailablePort", () => {
  const inventory = parseVpsInventory(README);
  const used = usedPorts(inventory);

  it("予約済みのポートも払い出し済みとして扱う", () => {
    expect(used.has(3115)).toBe(true);
  });

  it("いちばん小さい空き番号を返す", () => {
    expect(chooseAvailablePort(used, { from: 3101, to: 3199 })).toBe(3102);
  });

  it("READMEの散文（「3114以降が空き」）ではなく表から計算する", () => {
    // 散文は古く、実際には3114をaideが使っている
    expect(used.has(3114)).toBe(true);
  });

  it("空きが無ければnull", () => {
    expect(chooseAvailablePort(new Set([1, 2]), { from: 1, to: 2 })).toBeNull();
  });
});

describe("parseServerNames", () => {
  it("ServerNameとServerAliasを取り出し、コメント行は無視する", () => {
    const conf = `# ServerName commented.example.com
<VirtualHost *:80>
    ServerName blog.gucchii.com
    ServerAlias www.blog.gucchii.com  old.gucchii.com
    DocumentRoot /var/www/html/wordpress
</VirtualHost>`;
    expect(parseServerNames(conf)).toEqual([
      "blog.gucchii.com",
      "www.blog.gucchii.com",
      "old.gucchii.com",
    ]);
  });
});

describe("isHostnameTaken", () => {
  const inventory = parseVpsInventory(README);

  it("ファイル名ではなくServerNameで判定する（wordpress.conf → blog.gucchii.com）", () => {
    const usage = collectHostnameUsage(inventory, [
      "<VirtualHost *:80>\n  ServerName blog.gucchii.com\n</VirtualHost>",
    ]);
    expect(isHostnameTaken("blog.gucchii.com", usage)).toBe(true);
    expect(isHostnameTaken("wordpress.gucchii.com", usage)).toBe(false);
  });

  it("vhostがまだ無くてもREADMEに載っていれば使用中とみなす", () => {
    const usage = collectHostnameUsage(inventory, []);
    expect(isHostnameTaken("kakei-report.gucchii.com", usage)).toBe(true);
    expect(isHostnameTaken("aide.gucchii.com", usage)).toBe(true);
    expect(isHostnameTaken("newapp.gucchii.com", usage)).toBe(false);
  });

  it("大文字小文字を区別しない", () => {
    const usage = collectHostnameUsage(inventory, [" ServerName Car.Gucchii.Com"]);
    expect(isHostnameTaken("car.gucchii.com", usage)).toBe(true);
  });
});

describe("describeUsedPorts", () => {
  it("実際に埋まっている番号を並べる", () => {
    expect(describeUsedPorts(new Set([3101, 3104, 3114]), { from: 3101, to: 3199 })).toBe(
      "使用中: 3101・3104・3114",
    );
  });

  it("多いときは省略したことが分かるようにする", () => {
    const many = new Set(Array.from({ length: 15 }, (_, i) => 3101 + i));
    expect(describeUsedPorts(many, { from: 3101, to: 3199 })).toContain("ほか3件");
  });

  it("範囲外のポートは数えない", () => {
    expect(describeUsedPorts(new Set([8002]), { from: 3101, to: 3199 })).toBe(
      "3101〜3199に使用中のポートはありません",
    );
  });
});
