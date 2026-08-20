import { parseManualStepGuide, type ManualStepGuideStep } from "@/lib/manual-step-guide";

/**
 * VPS・サブPCの設定ファイルが、どのリポジトリのどこで管理されているかの対応表（#2021）。
 *
 * VPS（`guchi-apps/vps`）とサブPC（`guchi-apps/subpc`）の実機設定はGitで管理されており、
 * **mainへマージすれば`deploy.yml`が実機へ自動で反映する**。にもかかわらず手作業Issueには
 * 実機を直接書き換える手順が書かれることがあり、そうすると変更がGitに残らずドリフトになる
 * （どちらのリポジトリも毎日ドリフト検知を回しているので、後から差分としてだけ出てくる）。
 *
 * ここは「その手順がどのリポジトリの管理下か」を判定する**唯一の場所**にする。画面の導線も
 * 起票側のプロンプトも、この表を正として同じ判断をする。
 *
 * **推定は挟まない。** 実機のパスの文字列一致と、書き換えを表す語だけで判定する。書き方が
 * 違えば取りこぼすが、その場合は従来どおり手作業のまま進むだけで害は無い——逆に、当たって
 * いない手順を「リポジトリ経由でやるもの」と表示すると、実機に反映されないPRだけが残る。
 *
 * **対応表の正は各リポジトリの反映スクリプト**（`guchi-apps/vps`の`scripts/apply.sh`、
 * `guchi-apps/subpc`の`setup.sh`）。あちらの構成が変わったらここも直す。
 *
 * **載せるのは`deploy.yml`の`paths`に入っている受け口だけにする。** マージしても実機が
 * 変わらない置き場（vpsの`mysql/`は記録のみで`apply.sh`が配らない）を載せると、切り出した
 * PRをマージしても実機は元のままなのに「対応済み」に見える。Git管理外の領域は、従来どおり
 * 手作業のまま残すのが正しい。
 *
 * **実機へ出るまでにマージは2回ある。** 切り出したIssueのブランチが向くのは`develop`で、
 * `deploy.yml`が起動するのは`main`へのpush。`develop`→`main`のリリースPRのマージは
 * 自動マージ不可カテゴリ（CLAUDE.md）にあたるため人が行う。案内と本文はこの2段で書く。
 */

export type InfraConfigDevice = "vps" | "subpc";

/** 実機のパス1つぶんの対応 */
export type InfraConfigEntry = {
  /** 実機のパス。本文の中に**前方一致**で現れたら当たりとみなす */
  livePath: string;
  /** リポジトリ内の置き場所 */
  repoPath: string;
  /** 何の設定か（切り出すIssueの本文に書く） */
  description: string;
  /**
   * パス以外に当たりとみなす文字列（`crontab -e`のように、書き換える対象がパスとして
   * 現れないもの）。
   */
  extraPatterns?: string[];
  /** 反映のされ方がリポジトリ既定と違う場合の但し書き */
  applyNote?: string;
};

export type InfraConfigRepo = {
  device: InfraConfigDevice;
  /** 画面と本文に出す端末の呼び方 */
  deviceLabel: string;
  repositoryFullName: string;
  /** PRの向き先 */
  baseBranch: string;
  /** マージした後に何が起きるか（切り出すIssueの本文に書く） */
  applyNote: string;
  entries: InfraConfigEntry[];
};

/**
 * VPS。`main`へのpushで`.github/workflows/deploy.yml`がrsync＋`scripts/apply.sh`まで走る。
 */
const VPS_REPO: InfraConfigRepo = {
  device: "vps",
  deviceLabel: "VPS",
  repositoryFullName: "guchi-apps/vps",
  baseBranch: "develop",
  applyNote:
    "`develop`へマージしたうえで、`develop`→`main`のリリースPR（`release-develop-to-main.yml`）をマージすると、`.github/workflows/deploy.yml`がVPSへ同期し`scripts/apply.sh`が実機へ反映する",
  entries: [
    {
      livePath: "/etc/apache2/sites-available/",
      repoPath: "apache/sites-available/",
      description: "ApacheのVirtualHost",
    },
    {
      livePath: "/etc/apache2/conf-available/",
      repoPath: "apache/conf-available/",
      description: "Apacheの追加設定（phpMyAdmin等）",
    },
    {
      livePath: "/etc/apache2/mods-available/",
      repoPath: "apache/mods-available/",
      description: "Apacheのモジュール設定",
    },
    {
      livePath: "/var/www/html/healthz",
      repoPath: "apache/www/healthz",
      description: "死活監視用の静的ファイル",
    },
    {
      livePath: "/etc/systemd/system/",
      repoPath: "systemd/system/",
      description: "systemd（system）ユニット",
    },
    {
      livePath: "~/.config/systemd/user/",
      repoPath: "systemd/user/",
      description: "systemd（user）ユニット",
    },
    {
      livePath: "/usr/local/bin/",
      repoPath: "scripts/",
      description: "運用スクリプト（監視・バックアップ・通知）",
    },
    {
      livePath: "/etc/profile.d/signaly_login_notify.sh",
      repoPath: "scripts/signaly_login_notify.sh",
      description: "ログイン通知スクリプト",
    },
    {
      livePath: "/etc/fail2ban/jail.local",
      repoPath: "fail2ban/jail.local",
      description: "fail2banの設定",
    },
    {
      livePath: "/var/spool/cron/crontabs/",
      repoPath: "cron/crontab.txt",
      description: "crontab",
      extraPatterns: ["crontab -e", "crontab -r"],
    },
  ],
};

/**
 * サブPC。`main`へのpushで`.github/workflows/deploy.yml`がself-hostedランナー上で
 * `scripts/setup-apply.sh`（＝`setup.sh`）を走らせる。
 */
const SUBPC_REPO: InfraConfigRepo = {
  device: "subpc",
  deviceLabel: "サブPC",
  repositoryFullName: "guchi-apps/subpc",
  baseBranch: "develop",
  applyNote:
    "`develop`へマージしたうえで、`develop`→`main`のリリースPR（`release-develop-to-main.yml`）をマージすると、`.github/workflows/deploy.yml`がサブPC上のself-hostedランナーで`scripts/setup-apply.sh`を実行し実機へ反映する",
  entries: [
    {
      livePath: "/etc/default/grub",
      repoPath: "configs/grub/default-grub",
      description: "GRUBの設定",
    },
    {
      livePath: "/etc/netplan/",
      repoPath: "configs/netplan/01-netcfg.yaml",
      description: "ネットワーク設定（netplan）",
      // setup-apply.shはnetplanのapplyまではやらない（失敗すると到達不能になるため）
      applyNote: "**`netplan apply`と再起動は自動では行われない**（反映には別途操作が要る）",
    },
    {
      livePath: "/etc/apt/sources.list.d/tailscale.list",
      repoPath: "configs/apt/tailscale.list",
      description: "Tailscaleのaptリポジトリ定義",
    },
    {
      livePath: "/etc/systemd/system/ssh.socket.d/",
      repoPath: "configs/ssh/ssh-socket-port.conf",
      description: "ssh.socketの待ち受けポート",
    },
    {
      livePath: "/etc/ssh/sshd_config.d/",
      repoPath: "configs/ssh/10-subpc-hardening.conf",
      description: "sshdの設定",
    },
    {
      livePath: "/etc/systemd/system/systemd-time-wait-sync.service.d/",
      repoPath: "configs/systemd/time-wait-sync-timeout.conf",
      description: "時刻同期待ちのタイムアウト",
    },
    {
      livePath: "/etc/mysql/mysql.conf.d/zz-subpc.cnf",
      repoPath: "configs/mysql/zz-subpc.cnf",
      description: "MySQLの設定",
    },
    {
      livePath: "~/.bashrc.local",
      repoPath: "configs/bash/bashrc.local",
      description: "ログインシェルの設定（対話シェル）",
    },
    {
      livePath: "~/.profile.local",
      repoPath: "configs/bash/profile.local",
      description: "ログインシェルの設定（PATH）",
    },
    {
      livePath: "~/.bashrc",
      repoPath: "configs/bash/bashrc",
      description: "ログインシェルの設定",
    },
  ],
};

export const INFRA_CONFIG_REPOS: InfraConfigRepo[] = [VPS_REPO, SUBPC_REPO];

/** 検出した1件 */
export type InfraConfigTarget = {
  repo: InfraConfigRepo;
  entry: InfraConfigEntry;
  /** 当たった手順の行番号（1始まり）。チェックリストでない手順ではnull */
  line: number | null;
  /** 当たった手順の見出し文（本文へ引くために持つ） */
  stepText: string;
  /** 当たった手順のMarkdown（見出し文＋直下のコードブロック） */
  stepMarkdown: string;
};

/**
 * 書き換えを表す語。**読み取り（`cat`・`ls`・`systemctl status`）では当てない。**
 *
 * シェルの記法と日本語の動詞を分けずに1つの配列で見るのは、判定が「その行が書き換えを
 * 言っているか」の1問だけだから。手順の見出し文とコードブロックのどちらに書かれていても
 * 同じ意味に読む。
 */
const WRITE_MARKERS = [
  "cp ",
  "mv ",
  "tee ",
  "sed -i",
  "nano ",
  "vim ",
  "vi ",
  "install -",
  "ln -s",
  "rm ",
  "touch ",
  "chmod ",
  "chown ",
  "crontab ",
  ">>",
  "> ",
  "編集",
  "追記",
  "追加",
  "書き換え",
  "書き換える",
  "作成",
  "置き換え",
  "差し替え",
  "修正",
  "変更",
  "配置",
  "削除",
];

/** `## 前提条件`の「実行するデバイス」から、どちらの実機かを決める */
export function resolveInfraConfigDevice(device: string | null): InfraConfigDevice | null {
  if (!device) return null;
  const normalized = device.toLowerCase();
  // 「メインPC」は管理リポジトリを持たないため、どちらにも寄せない
  if (normalized.includes("メインpc") || normalized.includes("mainpc")) return null;
  if (normalized.includes("サブpc") || normalized.includes("subpc")) return "subpc";
  if (normalized.includes("vps")) return "vps";
  return null;
}

/**
 * 手作業Issueの本文から、実機のファイルを書き換える手順を拾う。
 *
 * **手順に割れている本文（`## やること`のチェックリスト）だけを見る。** 解析は
 * `parseManualStepGuide`に任せ、ここで本文の切り方を持たない——画面の案内と別々に
 * 本文を読むと、案内に出ている手順と検出結果がずれる。
 *
 * デバイスが読めないときは、**当たったリポジトリが1つに絞れる場合だけ**返す。
 * `/etc/systemd/system/`のようにVPS・サブPCの両方にあるパスは、どちらの実機の話か
 * 分からないまま切り出すと、反映されないリポジトリへPRが出る。
 */
export function detectInfraConfigTargets(body: string | null): InfraConfigTarget[] {
  const guide = parseManualStepGuide(body);
  if (!guide.hasTemplate || guide.steps.length === 0) return [];

  const device = resolveInfraConfigDevice(guide.where.device);
  const repos = device ? INFRA_CONFIG_REPOS.filter((repo) => repo.device === device) : INFRA_CONFIG_REPOS;

  const targets: InfraConfigTarget[] = [];
  const seen = new Set<string>();

  const options = { allowHomePaths: device !== null };
  for (const step of guide.steps) {
    for (const target of detectStepTargets(step, repos, options)) {
      // デバイスが読めないまま複数のリポジトリに当たったら、どちらとも決められないので捨てる
      const ambiguous =
        device === null &&
        repos.some(
          (repo) =>
            repo.repositoryFullName !== target.repo.repositoryFullName &&
            matchEntry(target.matchedText, repo, options) !== null,
        );
      if (ambiguous) continue;

      const key = `${target.repo.repositoryFullName}:${target.entry.repoPath}:${step.line ?? step.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        repo: target.repo,
        entry: target.entry,
        line: step.line,
        stepText: step.text,
        stepMarkdown: step.markdown,
      });
    }
  }

  return targets;
}

/** 手順1つぶんの判定。**行単位で見る**——書き換えの語とパスが同じ行にあるものだけを当てる */
function detectStepTargets(
  step: ManualStepGuideStep,
  repos: InfraConfigRepo[],
  options: { allowHomePaths: boolean },
): { repo: InfraConfigRepo; entry: InfraConfigEntry; matchedText: string }[] {
  const found: { repo: InfraConfigRepo; entry: InfraConfigEntry; matchedText: string }[] = [];
  for (const line of step.markdown.split("\n")) {
    if (!WRITE_MARKERS.some((marker) => line.includes(marker))) continue;
    for (const repo of repos) {
      const entry = matchEntry(line, repo, options);
      if (entry) found.push({ repo, entry, matchedText: line });
    }
  }
  return found;
}

/**
 * 1行がどの対応に当たるかを返す。**いちばん長いパスに当てる**——
 * `/etc/systemd/system/ssh.socket.d/`は`/etc/systemd/system/`にも前方一致するため、
 * 短い方を採ると置き場所を間違える。
 */
function matchEntry(
  text: string,
  repo: InfraConfigRepo,
  options: { allowHomePaths: boolean } = { allowHomePaths: true },
): InfraConfigEntry | null {
  let best: InfraConfigEntry | null = null;
  for (const entry of repo.entries) {
    // **ホーム配下のパスは、実機が分かっているときだけ当てる。** `~/.config/systemd/user/`は
    // どちらの端末にもあり、片方のリポジトリにしか対応が無いために「1つに絞れた」と
    // 誤って読める（サブPCの手順をVPSへ切り出すことになる）
    if (!options.allowHomePaths && entry.livePath.startsWith("~")) continue;
    const patterns = [entry.livePath, ...(entry.extraPatterns ?? [])];
    if (!patterns.some((pattern) => text.includes(pattern))) continue;
    if (best === null || entry.livePath.length > best.livePath.length) best = entry;
  }
  return best;
}

/** 切り出すIssueの下書き。`CreateIssueDialog`のプリフィルにそのまま渡す */
export type InfraConfigIssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
};

/**
 * 対象リポジトリへ切り出すIssueの下書きを組み立てる。
 *
 * **やることを推定して書かない。** 手作業Issueに書かれていた手順をそのまま引用し、
 * 「このファイルはこのリポジトリで管理されている」という事実と反映のされ方を添えるだけに
 * する。実際の変更内容は、対象リポジトリのセッションが元の手順を読んで決める。
 */
export function buildInfraConfigIssueDraft(params: {
  target: InfraConfigTarget;
  originRepositoryFullName: string;
  originNumber: number;
  originTitle: string;
}): InfraConfigIssueDraft {
  const { target, originRepositoryFullName, originNumber, originTitle } = params;
  const originRef = `${originRepositoryFullName}#${originNumber}`;
  const applyNote = target.entry.applyNote ?? target.repo.applyNote;

  const body = [
    "## 背景",
    "",
    `手作業Issue「${originTitle}」（${originRef}）に、${target.repo.deviceLabel}の\`${target.entry.livePath}\`を書き換える手順が含まれている。`,
    `このファイルは当リポジトリの\`${target.entry.repoPath}\`（${target.entry.description}）で管理されているため、実機を直接編集せずPR経由で変更する。`,
    "",
    "## やること",
    "",
    `- [ ] \`${target.entry.repoPath}\` を、下記の手順が意図している内容へ更新する`,
    `- [ ] \`${target.repo.baseBranch}\` 宛のPull Requestを作成する`,
    "- [ ] マージ後、`develop`→`main`のリリースPRを作成する（実機へ出るのはこのマージ。人が行う）",
    "",
    "## 元の手作業の手順",
    "",
    target.stepMarkdown.trim(),
    "",
    "## 反映のされ方",
    "",
    `- ${applyNote}`,
    "",
    "## 関連",
    "",
    `- 起点の手作業Issue: ${originRef}`,
  ].join("\n");

  return {
    repositoryFullName: target.repo.repositoryFullName,
    title: `${target.entry.repoPath} を更新する（${originRef} の手作業ぶん）`,
    body,
  };
}
