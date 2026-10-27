/**
 * 全体レビューが「poller更新・再起動」に触れたとき、それが実際に必要かを稼働情報と照らして判定する（#4665）。
 *
 * 以前（#4632）は`/poller|ポーラー|再起動/`の一致だけで「更新が必要・再実行では解決しない」と断定していた。
 * 互換性を確認しただけの記述や、更新済みと書いた記述まで拾い、サーバー側だけで有効になる変更にも
 * サブPCの更新を要求していた。ここでは次の順で決める。**確認できない事実を、必要とも済みとも言わない**。
 *
 * 1. レビュー文（未確認の項目の根拠・理由・未確認範囲）に、**更新・再起動を要求する文**があるか。
 *    言及だけ・「更新不要／更新済み／互換」等の文は要求として数えない
 * 2. issue-deck自身の候補（pollerのコードを含みうる）: 候補にpollerへ届くファイル（`scripts/`）の変更が
 *    無ければサーバー側だけで有効＝不要。有れば、オンラインのホストの**起動時コミット**（いま走っているコード）が
 *    候補headを含むかで「更新済み／更新が必要」。pollerは`develop`を追うので公開前でも更新でき、
 *    公開後にしかできない配布を公開前の条件にする循環は起きない
 * 3. 他リポジトリの候補: pollerのコードは候補に含まれない。チェックアウトの遅れ（issue-deckの`develop`基準）は
 *    このリポジトリの公開と無関係なので使わず、統合検証・全体レビューの能力を申告しているかだけを見る
 */

/** pollerの本体（`scripts/`配下）を持つリポジトリ。ここの候補だけがpollerのコードを変えうる */
export const POLLER_REPOSITORY = "guchi-apps/issue-deck";

/** 候補の変更のうち、サブPCのpollerへ届く（サーバーのデプロイでは有効にならない）もの */
export function isPollerDeliveredFile(path: string): boolean {
  return path.startsWith("scripts/");
}

/** 平易な説明。用語としての「poller」を知らない人にも、何を更新するのかが分かるようにする */
export const POLLER_EXPLANATION =
  "poller（ポーラー）は、サブPCで常に動いていて、issue-deckからの依頼を受け取ってAIの処理や検証を起動するプログラムです。";

export type ReleaseOpsHostFact = {
  name: string;
  online: boolean;
  /** いま走っているコードのコミット（起動時のチェックアウト）。申告していなければ`null` */
  startedCommit: string | null;
  /** チェックアウトの現在のHEAD。申告していなければ`null` */
  commit: string | null;
  releaseVerifyCapable: boolean;
  releaseReviewCapable: boolean;
  /** 最後に「更新して再起動」が成功した時刻（記録が残っていれば） */
  lastSelfUpdateAt: string | null;
  /** issue-deck自身の候補で、起動時コミットが候補headを含むか。照合できなければ`null` */
  includesCandidate: boolean | null;
};

/** 判定に使った事実。要求が無いときは集めない（GitHub APIを呼ばない） */
export type ReleaseOpsContext = {
  repositoryFullName: string;
  /** 候補（main…release head）の変更ファイル。取得できなければ`null` */
  changedFiles: string[] | null;
  /** このリポジトリを申告しているホスト */
  hosts: ReleaseOpsHostFact[];
};

export type ReleaseOpsRequest = {
  /** 要求していた文（抜粋） */
  excerpt: string;
  /** 公開前の更新を要する根拠（非互換など）が書かれていたか */
  incompatible: boolean;
  /** 文中で参照していたIssue番号（既存の運用・手作業Issueの再利用に使う） */
  relatedIssues: number[];
};

const OPS_SUBJECT = /poller|ポーラー|サブPC|常駐|再起動|self[-_ ]?update|更新して再起動/i;
const OPS_REQUEST =
  /(更新|再起動|反映|入れ替|pull|デプロイ|配布)[^。]{0,16}(必要|要る|要す|必須|待ち|後に有効|後から有効|されていない|していない|されておらず|しておらず|未確認|未実施|できていない|確認できない|確認できず|証跡が?(無|な))|未更新|未反映|未再起動|旧版|古いまま|古いpoller|旧poller/i;
const OPS_NEGATION =
  /不要|必要(は|が)?(ない|無い|ありません|なし)|更新済み|再起動済み|反映済み|入れ替え済み|影響しない|影響なし|影響はない|後方互換|互換性?(が|は)?(ある|あり|保たれ|を確認|を保)|サーバー(側)?(だけ|のみ)で(有効|完結)/;
const OPS_INCOMPATIBLE = /非互換|互換性?(が|は)?(ない|無い|無く|なく)|動かなくなる|壊れる|公開前に|先に更新|マージ前に/;

/** 文の単位に分ける（句点・改行・複数根拠の区切り` / `） */
function sentences(text: string): string[] {
  return text
    .split(/[。\n]|\s\/\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * レビュー文に、pollerの更新・再起動を**要求する文**があるかを探す。言及だけ・否定・更新済みの文は除く。
 * 無ければ`null`
 */
export function findOpsRequest(texts: readonly (string | null | undefined)[]): ReleaseOpsRequest | null {
  const hits: string[] = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const s of sentences(text)) {
      if (OPS_SUBJECT.test(s) && OPS_REQUEST.test(s) && !OPS_NEGATION.test(s)) hits.push(s);
    }
  }
  if (hits.length === 0) return null;
  const relatedIssues = [
    ...new Set(hits.flatMap((s) => [...s.matchAll(/#(\d{1,6})\b/g)].map((m) => Number(m[1])))),
  ];
  const excerpt = hits[0].length > 200 ? `${hits[0].slice(0, 200)}…` : hits[0];
  return { excerpt, incompatible: hits.some((s) => OPS_INCOMPATIBLE.test(s)), relatedIssues };
}

/** 要求を探す文: 未確認の理由・未確認範囲・未確認の確認項目の根拠。確認済みの項目・要約の言及は数えない */
export function opsRequestTexts(section: {
  reason: string | null;
  unverifiedScope?: string | null;
  review: { checks: { status: string; evidence: string | null }[] } | null;
}): (string | null)[] {
  return [
    section.reason,
    section.unverifiedScope ?? null,
    ...(section.review?.checks.filter((c) => c.status === "unconfirmed").map((c) => c.evidence) ?? []),
  ];
}

export type ReleaseOpsStatus = "not_needed" | "updated" | "needed" | "unknown";

export type ReleaseOpsAssessment = {
  status: ReleaseOpsStatus;
  /** `needed`のときだけ。公開（mainへのマージ）の前に必要か、公開後でよいか */
  timing: "before_release" | "after_release" | null;
  /** 1行の結論 */
  headline: string;
  /** なぜ更新に触れているか（レビュー文の抜粋） */
  reason: string;
  /** 対象ホスト */
  hosts: string[];
  /** 確認できた事実（確認できなかったことも含む） */
  facts: string[];
  /** 次の操作 */
  nextAction: string;
  relatedIssues: number[];
};

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "未申告");

function describeHost(host: ReleaseOpsHostFact, withCandidate: boolean): string {
  const parts = [
    host.online ? "オンライン" : "オフライン",
    `稼働コミット ${short(host.startedCommit)}`,
  ];
  if (withCandidate) {
    parts.push(
      host.includesCandidate === true
        ? "候補を含む"
        : host.includesCandidate === false
          ? "候補を含まない（旧版）"
          : "候補を含むか照合できず",
    );
  } else {
    parts.push(host.releaseVerifyCapable && host.releaseReviewCapable ? "統合検証・全体レビューに対応" : "統合検証・全体レビューに未対応");
  }
  if (host.lastSelfUpdateAt) parts.push(`最終「更新して再起動」${host.lastSelfUpdateAt}`);
  return `${host.name}: ${parts.join("・")}`;
}

// 自動更新（#4118）の有効・無効はDBに残っていないので、ここでは決め打ちしない
const UPDATE_ACTION =
  "実行状況パネルの対象ホストで「更新して再起動」を押してください（自動更新が有効なホストは、次の巡回で自動的に更新・再起動されます）。更新後に候補を含む版で動き出したことを確認できると、未確認の項目を自動で再評価します。";

/**
 * 要求と事実を照らして、運用状態の案内を作る。要求が無ければ`null`（案内しない）
 */
export function assessReleaseOps(
  request: ReleaseOpsRequest | null,
  context: ReleaseOpsContext | null | undefined,
): ReleaseOpsAssessment | null {
  if (!request) return null;
  const base = { reason: request.excerpt, relatedIssues: request.relatedIssues };
  if (!context) {
    return {
      ...base,
      status: "unknown",
      timing: null,
      headline: "サブPCの稼働状態を取得できず、更新が必要かを確認できません",
      hosts: [],
      facts: ["稼働情報を読み込めませんでした"],
      nextAction: "実行状況パネルでサブPCの稼働状態を確認してください。確認できるまで、この項目は未確認のまま残ります。",
    };
  }
  const isPollerRepo = context.repositoryFullName === POLLER_REPOSITORY;
  const hostNames = context.hosts.map((h) => h.name);
  const facts = context.hosts.map((h) => describeHost(h, isPollerRepo));
  const unknown = (headline: string, extra: string[] = []): ReleaseOpsAssessment => ({
    ...base,
    status: "unknown",
    timing: null,
    headline,
    hosts: hostNames,
    facts: [...extra, ...facts],
    nextAction:
      "実行状況パネルでサブPCがオンラインか、稼働コミットを確認してください。確認できるまで、この項目は未確認のまま残ります（更新が必要とも済みとも判定しません）。",
  });

  if (isPollerRepo) {
    if (context.changedFiles === null) return unknown("候補の変更ファイルを取得できず、サブPCの更新が要るかを確認できません");
    const delivered = context.changedFiles.filter(isPollerDeliveredFile);
    if (delivered.length === 0) {
      return {
        ...base,
        status: "not_needed",
        timing: null,
        headline: "この候補はサーバー（本番）へのデプロイだけで有効になります。サブPCの更新は不要です",
        hosts: hostNames,
        facts: [`候補の変更${context.changedFiles.length}ファイルに、サブPCへ届くファイル（scripts/）はありません`],
        nextAction: "対応は不要です。",
      };
    }
    const deliveredFact = `候補にサブPCへ届くファイルの変更が${delivered.length}件あります（例: ${delivered.slice(0, 3).join("、")}）`;
    const online = context.hosts.filter((h) => h.online);
    if (online.length === 0) {
      return unknown(
        context.hosts.length === 0
          ? "このリポジトリを申告しているサブPCが無く、稼働状態を確認できません"
          : "サブPCがオフラインで、いま走っているコードを確認できません",
        [deliveredFact],
      );
    }
    const updated = online.filter((h) => h.includesCandidate === true);
    const stale = online.filter((h) => h.includesCandidate === false);
    if (updated.length > 0 && stale.length === 0) {
      return {
        ...base,
        status: "updated",
        timing: null,
        headline: "サブPCのpollerは、この候補を含むコードで動いています（更新済み）",
        hosts: hostNames,
        facts: [deliveredFact, ...facts],
        nextAction: "更新は済んでいます。この事実を踏まえて未確認の項目を自動で再評価します（自動で開始できないときは理由を表示します。「全体レビューを再実行」でもやり直せます）。",
      };
    }
    if (stale.length > 0) {
      const before = request.incompatible;
      return {
        ...base,
        status: "needed",
        timing: before ? "before_release" : "after_release",
        headline: before
          ? "サブPCのpollerが旧版です。レビューは旧版だと動かなくなる変更を指摘しているため、公開前に更新してください"
          : "サブPCのpollerが旧版です。新しいpollerの機能はサブPCの更新後に有効になります（公開の条件ではありません）",
        hosts: stale.map((h) => h.name),
        facts: [deliveredFact, ...facts],
        nextAction: before
          ? UPDATE_ACTION
          : `pollerは開発ブランチ（develop）から更新するため、公開の前後どちらでも更新できます。公開（mainへのマージ）を止める理由にはなりません。${UPDATE_ACTION}`,
      };
    }
    return unknown("いま走っているコードが候補を含むかを照合できませんでした", [deliveredFact]);
  }

  // 他リポジトリ: 候補はpollerのコードを変えない。必要な能力の申告だけを見る
  if (context.hosts.length === 0) return unknown("このリポジトリを申告しているサブPCが無く、稼働状態を確認できません");
  const capable = context.hosts.filter((h) => h.releaseVerifyCapable && h.releaseReviewCapable);
  if (capable.length > 0) {
    return {
      ...base,
      status: "updated",
      timing: null,
      headline: "サブPCのpollerは、統合検証・全体レビューに必要な機能を申告しています（更新済み）",
      hosts: capable.map((h) => h.name),
      facts: ["この候補はpollerのコードを変えません（pollerはissue-deckのリポジトリにあります）", ...facts],
      nextAction: "サブPCの更新は不要です。この事実を踏まえて未確認の項目を自動で再評価します（自動で開始できないときは理由を表示します。「全体レビューを再実行」でもやり直せます）。",
    };
  }
  return {
    ...base,
    status: "needed",
    timing: "before_release",
    headline: "サブPCのpollerが旧版で、このリポジトリの統合検証・全体レビューに対応していません。公開前に更新が必要です",
    hosts: hostNames,
    facts,
    nextAction: UPDATE_ACTION,
  };
}
