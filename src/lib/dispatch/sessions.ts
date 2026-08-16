import type { DispatchSession } from "@prisma/client";

import { db } from "@/lib/db";
import {
  isRevivedSession,
  nextEscalatedState,
  parseSessionReapReason,
  resolveSessionState,
  resolveStartingActivityTransition,
  shouldEscalateSession,
  type DispatchSessionActivity,
  type DispatchSessionReport,
  type DispatchSessionState,
  type DispatchSessionView,
} from "@/lib/dispatch/session-state";
import {
  escalateFailedSession,
  escalateNotStartedSession,
  resolveNotStartedSession,
} from "@/lib/dispatch/session-escalation";
import { postSessionWrapupComment } from "@/lib/dispatch/session-wrapup";

/**
 * 起動後のtmuxセッションの状態（#1217）のDB操作。
 *
 * 判定そのものは`session-state.ts`（DBに触らない純粋関数）が持つ。ここは保存と、
 * 報告に含まれなくなった行を`GONE`へ倒す突き合わせを担当する。
 *
 * `jobs.ts`と同じく、このモジュールはPrismaクライアントを読み込むためクライアント
 * コンポーネントからimportできない。型は`session-state.ts`側に置いてある。
 */

export type { DispatchSessionView };

function toSessionView(session: DispatchSession): DispatchSessionView {
  return {
    host: session.host,
    tmuxSessionName: session.tmuxSessionName,
    repositoryFullName: session.repositoryFullName,
    issueNumber: session.issueNumber,
    // タイトルとidの引き当ては`listDispatchState`（jobs.ts）が一括で行う（#1567・#1625）。
    // ここで引くとセッション1件ごとにクエリが増えるうえ、jobs.ts → sessions.ts の依存が逆流する
    issueTitle: null,
    issueId: null,
    state: session.state as DispatchSessionState,
    exitStatus: session.exitStatus,
    firstSeenAt: session.firstSeenAt.toISOString(),
    lastReportedAt: session.lastReportedAt.toISOString(),
    activity: (session.activity as DispatchSessionActivity | null) ?? null,
    activityAt: session.activityAt?.toISOString() ?? null,
    remoteControlUrl: session.remoteControlUrl,
    previewUrl: session.previewUrl,
    // 畳む予定（#1817）。**保存されている理由コードも読み直しで検証する**（列はStringなので、
    // 古い版が書いた・知らないコードが残っていることがある）
    reapAt: session.reapAt?.toISOString() ?? null,
    reapReason: parseSessionReapReason(session.reapReason),
  };
}

/**
 * セッション自身がフック（#1219）から報告してくる様子を記録する（#1264）。
 *
 * **pollerの一括報告（`reportDispatchSessions`）とは別の入口にする。** あちらは「そのホストで
 * 今見えているセッションの全て」を前提に、含まれない行を`GONE`へ倒す。フックの1件を同じ
 * 経路へ流すと、他のセッションが全部消えたことになる。
 *
 * **セッションの行が無ければ何もしない。** フックはpollerより先に飛びうるが、行を作ると
 * `host`・`tmuxSessionName`をフック側が知らないため嘘の値が入る。1巡（既定30秒）待てば
 * pollerが作るので、取りこぼしても次のフックで載る。
 */
export async function recordDispatchSessionActivity(params: {
  repositoryFullName: string;
  issueNumber: number;
  /** 様子。URLだけを報告する呼び出し（#1265のプレビュー公開時）では省略する */
  activity?: DispatchSessionActivity | null;
  remoteControlUrl?: string | null;
  previewUrl?: string | null;
  now?: Date;
}): Promise<{ updated: number }> {
  const now = params.now ?? new Date();
  const result = await db.dispatchSession.updateMany({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      // 終わったセッションの行に「入力待ち」を後から書かない
      state: "ALIVE",
    },
    data: {
      // **渡された項目だけを書く。** URLが取れなかった回で既存の値を消さない
      // （Claude Codeの内部ファイル依存で欠けうる。プレビューは公開時の1回しか報告しない）
      ...(params.activity ? { activity: params.activity, activityAt: now } : {}),
      ...(params.remoteControlUrl ? { remoteControlUrl: params.remoteControlUrl } : {}),
      ...(params.previewUrl ? { previewUrl: params.previewUrl } : {}),
    },
  });
  return { updated: result.count };
}

/**
 * セッション自身が「畳まれた」ことを終了時に報告してきたときの記録（#1321）。
 *
 * **pollerの一括報告を待たずに`ALIVE`を降ろすためだけの入口。** #1311で生きているセッションの
 * あるIssueは起動を押せなくしたため、`tmux kill-session`で畳んだ直後に「畳んだのにまだ押せない」
 * 時間が最大75秒（当時の`sleep`60秒＋1巡の実処理の約14秒）生まれていた。#1624で既定の間隔を
 * 30秒へ短くしたぶん縮むが、遅れが残ること自体は変わらない。報告するのは
 * `scripts/run-issue-session.sh`の`cleanup`（`trap ... EXIT HUP TERM`）。
 *
 * **終了コードは受け取らず、`FAILED`にも`EXITED`にもしない。** `tmux kill-session`ではHUPで
 * trapに入るため、そこで拾える終了コードは「セッションが異常終了したか」を表さない。ここから
 * `FAILED`を書けるようにすると、**畳んだだけのセッションでIssueコメント＋`00.check-user`の
 * 引き上げが起きる**。異常終了の判定はpollerの担当のまま（`remain-on-exit`で死んだペインが
 * 残っている場合は、次の巡回で`EXITED`/`FAILED`へ上書きされる。`escalatedState`をここで
 * 落としているため、引き上げも従来どおり働く）。
 *
 * **`ALIVE`の行だけを倒す。** 二重に報告されても2回目は0件で、pollerが先に`FAILED`を
 * 書いていればそれを消さない。
 */
export async function markDispatchSessionEnded(params: {
  hostName: string;
  tmuxSessionName: string;
  now?: Date;
}): Promise<{ updated: number }> {
  const now = params.now ?? new Date();
  // 締めコメント（#1119）の判定に`repositoryFullName`・`issueNumber`・`firstSeenAt`が要る。
  // `updateMany`は更新後の行を返さないので、倒す前に読んでおく
  const target = await db.dispatchSession.findUnique({
    where: {
      host_tmuxSessionName: {
        host: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
      },
    },
  });
  const result = await db.dispatchSession.updateMany({
    where: {
      host: params.hostName,
      tmuxSessionName: params.tmuxSessionName,
      state: "ALIVE",
    },
    data: {
      state: "GONE",
      lastReportedAt: now,
      // 消えた時点で引き上げの記録は落とす（`reportDispatchSessions`のGONE化と同じ理由）。
      // 同じ名前で起動し直して落ちたときに、2回目の引き上げが起きなくなる
      escalatedState: null,
    },
  });

  // **実際に`ALIVE`から倒した1回だけ締める（#1119）。** 二重に報告されても2回目は0件なので、
  // ここを通らない。投稿するかどうか（記録が残っているか）の判定は`session-wrapup.ts`側。
  if (result.count > 0 && target) {
    await postSessionWrapupComment({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName: params.hostName,
      tmuxSessionName: params.tmuxSessionName,
      firstSeenAt: target.firstSeenAt,
      now,
    });
  }

  return { updated: result.count };
}

/**
 * 消えたセッションの行を残しておく期間。
 *
 * すぐ消さないのは、**画面が「さっきまで動いていたセッションが終わった」ことを出せるようにする**
 * ため。無期限に残すと一覧が伸び続けるだけなので、`DispatchJob`の終了済みジョブと同じ感覚で切る。
 */
const GONE_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * ホストからの報告を1件まとめて受ける。
 *
 * **報告は「そのホストで今見えているセッションの全て」**という前提で扱う。含まれていない行は
 * 消えたとみなして`GONE`へ倒す。そのためpoller側は、セッションが0本でも空配列を送る必要がある
 * （送らないと消失を判定できない）。
 *
 * 戻り値の`escalated`は、このリクエストで引き上げ（Issueコメント＋`00.check-user`）を行った件数。
 * 異常終了（#1217）と、Claude Codeが開始しないまま止まっているセッション（#1465）の合計。
 */
export async function reportDispatchSessions(params: {
  hostName: string;
  sessions: DispatchSessionReport[];
  now?: Date;
}): Promise<{ sessions: DispatchSessionView[]; escalated: number }> {
  const now = params.now ?? new Date();
  const existing = await db.dispatchSession.findMany({ where: { host: params.hostName } });
  const existingByName = new Map(existing.map((row) => [row.tmuxSessionName, row]));

  const reportedNames = new Set<string>();
  const escalations: { repositoryFullName: string; issueNumber: number; session: string; exitStatus: number | null }[] =
    [];
  // Claude Codeが開始しないまま止まっているセッション（#1465）。異常終了の引き上げと同じく、
  // DBの更新を終えてからまとめて処理する
  const notStarted: { repositoryFullName: string; issueNumber: number; session: string }[] = [];
  const notStartedResolved: { repositoryFullName: string; issueNumber: number }[] = [];

  for (const report of params.sessions) {
    reportedNames.add(report.tmuxSessionName);
    const previous = existingByName.get(report.tmuxSessionName) ?? null;
    const state = resolveSessionState(report);
    const previousEscalated = (previous?.escalatedState ?? null) as DispatchSessionState | null;
    const escalate = shouldEscalateSession(previousEscalated, state);
    const escalatedState = nextEscalatedState(previousEscalated, state, escalate);
    const revived = isRevivedSession(previous?.state as DispatchSessionState | undefined, state);
    // 立ち上がり直した行は前のセッションの様子を捨てるので、判定でも捨てた後の値を見る（#1353）
    const startingTransition = resolveStartingActivityTransition({
      state,
      previousActivity: revived
        ? null
        : ((previous?.activity ?? null) as DispatchSessionActivity | null),
      claudeStarting: report.claudeStarting,
    });
    // 畳む予定（#1817）。**送ってきた巡の値でそのまま置き換える。** 回収スクリプトは毎巡
    // 判定し直し、条件を満たさなくなれば予定を消すので、前の巡の値を残す意味が無い（残すと
    // 作業が再開したセッションに終了予告が出たままになる）。
    // 古いpollerは項目そのものを送ってこない（`undefined`）ので、そのときは触らない。
    const reap =
      report.reapAt === undefined
        ? {}
        : {
            reapAt: report.reapAt === null ? null : new Date(report.reapAt),
            reapReason: report.reapReason ?? null,
          };

    await db.dispatchSession.upsert({
      where: {
        host_tmuxSessionName: {
          host: params.hostName,
          tmuxSessionName: report.tmuxSessionName,
        },
      },
      create: {
        host: params.hostName,
        tmuxSessionName: report.tmuxSessionName,
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        state,
        exitStatus: report.paneDeadStatus,
        firstSeenAt: now,
        lastReportedAt: now,
        escalatedState,
        escalatedAt: escalate ? now : null,
        // 1巡目の報告で既に止まっている場合（起動から猶予を過ぎてからpollerが最初に見た場合）
        ...(startingTransition === "enter" ? { activity: "NOT_STARTED", activityAt: now } : {}),
        ...reap,
      },
      update: {
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        state,
        exitStatus: report.paneDeadStatus,
        lastReportedAt: now,
        escalatedState,
        ...(escalate ? { escalatedAt: now } : {}),
        // 立ち上がり直した行は、前のセッションが残した様子を捨てる（#1353）。
        // **`previewUrl`だけは残す。** あれはworktreeに固定のポートを指すので次のセッションでも
        // 繋がる一方、報告は起動時の1回だけで、その時点の行が`GONE`だと（`ALIVE`の行しか
        // 更新しないため）捨てられて二度と載らない。
        // **畳む予定（#1817）も捨てる。** 前のセッションに出ていた「あと3分で自動終了」が、
        // 起動し直した直後のセッションにそのまま出るのを防ぐ（古いpollerで`reap`が空のときも）
        ...(revived
          ? {
              activity: null,
              activityAt: null,
              remoteControlUrl: null,
              firstSeenAt: now,
              reapAt: null,
              reapReason: null,
            }
          : {}),
        // 起動確認で止まっている／人が答えて始まった（#1465）。**`revived`の後に置く**
        // （立ち上がり直した行では、捨てた後の状態から立て直す）
        ...(startingTransition === "enter"
          ? { activity: "NOT_STARTED" as const, activityAt: now }
          : {}),
        ...(startingTransition === "leave" ? { activity: null, activityAt: null } : {}),
        // **`revived`の後に置く**（立ち上がり直した行では、捨てた後にこの巡の値を入れる）
        ...reap,
      },
    });

    if (startingTransition === "enter") {
      notStarted.push({
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        session: report.tmuxSessionName,
      });
    }
    if (startingTransition === "leave") {
      notStartedResolved.push({
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
      });
    }

    if (escalate) {
      escalations.push({
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        session: report.tmuxSessionName,
        exitStatus: report.paneDeadStatus,
      });
    }
  }

  // 報告に含まれなくなった行はGONEへ倒す。**削除しない。**
  // 引き上げ済みかどうか（escalatedState）を覚えておく必要があるのと、画面が「終わった
  // セッション」を出せるようにするため。
  const goneRows = existing.filter(
    (row) => !reportedNames.has(row.tmuxSessionName) && row.state !== "GONE",
  );
  const goneNames = goneRows.map((row) => row.tmuxSessionName);
  if (goneNames.length > 0) {
    await db.dispatchSession.updateMany({
      where: { host: params.hostName, tmuxSessionName: { in: goneNames } },
      data: {
        state: "GONE",
        lastReportedAt: now,
        // 消えた時点で引き上げの記録は落とす。同じ名前で起動し直して再び落ちたときに、
        // 前回の記録が残っていると2回目の引き上げが起きない
        escalatedState: null,
      },
    });
  }

  // 何も記録を残さずに終わったセッションを締める（#1119）。**`markDispatchSessionEnded`と
  // 二重に呼ばれうるが、投稿は1回で済む**（`session-wrapup.ts`が自分のマーカーを「記録あり」に
  // 数える）。ここを残しておかないと、`SIGKILL`・ホストの再起動で`trap`を通らなかったセッションを
  // 拾えない（#1321の多層防御と同じ理由）。
  //
  // **引き上げ（`escalations`）と同じく、失敗で報告APIを落とさない。**
  for (const row of goneRows) {
    await postSessionWrapupComment({
      repositoryFullName: row.repositoryFullName,
      issueNumber: row.issueNumber,
      hostName: params.hostName,
      tmuxSessionName: row.tmuxSessionName,
      firstSeenAt: row.firstSeenAt,
      now,
    });
  }

  await db.dispatchSession.deleteMany({
    where: {
      host: params.hostName,
      state: "GONE",
      lastReportedAt: { lt: new Date(now.getTime() - GONE_SESSION_RETENTION_MS) },
    },
  });

  // **引き上げの失敗で報告APIを失敗させない。** pollerは報告の失敗で処理を止めない取り決めなので、
  // ここで500を返しても状態は既に保存済みで、pollerにできることは何も無い。
  let escalated = 0;
  for (const target of escalations) {
    const ok = await escalateFailedSession({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName: params.hostName,
      tmuxSessionName: target.session,
      exitStatus: target.exitStatus,
    });
    if (ok) escalated += 1;
  }

  // 起動確認で止まっているセッション（#1465）。**引き上げと同じく、失敗で報告APIを落とさない。**
  for (const target of notStarted) {
    const ok = await escalateNotStartedSession({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName: params.hostName,
      tmuxSessionName: target.session,
    });
    if (ok) escalated += 1;
  }
  for (const target of notStartedResolved) {
    await resolveNotStartedSession({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
    });
  }

  const saved = await db.dispatchSession.findMany({
    where: { host: params.hostName },
    orderBy: { lastReportedAt: "desc" },
  });
  return { sessions: saved.map(toSessionView), escalated };
}

/** 画面へ返すセッション一覧。`listDispatchState`から呼ぶ */
export async function listDispatchSessions(now: Date = new Date()): Promise<DispatchSessionView[]> {
  const sessions = await db.dispatchSession.findMany({
    where: {
      OR: [
        { state: { in: ["ALIVE", "EXITED", "FAILED"] } },
        { lastReportedAt: { gte: new Date(now.getTime() - GONE_SESSION_RETENTION_MS) } },
      ],
    },
    orderBy: { lastReportedAt: "desc" },
    take: 100,
  });
  return sessions.map(toSessionView);
}
