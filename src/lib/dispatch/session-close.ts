import { db } from "@/lib/db";
import { SESSION_LAUNCH_JOB_KINDS, type SessionControlRejection } from "@/lib/dispatch/dispatch-job";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";

/**
 * Issueがcloseされたときに、そのIssueで走っているローカルセッションを畳む（#1518）。
 *
 * **画面の「セッションを閉じる」（#1332）と同じ`KILL`ジョブを、人が押さなくても積む。**
 * closeしても走り続けるのが実害になっていたのは、サブPC側の自動回収
 * （`scripts/reap-sessions.sh`）がIssueのCLOSEDを見る前に`11.local`で`hold`するため。
 * あのラベルは実装エージェントが引き渡し時に自分で外すもので、**closeで打ち切った
 * セッションでは外れないまま残る**（加えて未コミットの変更・`Stop`フック未達でも残す）。
 * 結果、closeという明確な意思表示があってもセッションは残り、本数の上限（#1361）を
 * 1本ずつ埋め続けていた。
 *
 * **これは計器であって役ではない**（`docs/multi-agent/gates.md`）。判断は挟まず、
 * 「IssueがOPEN→CLOSEDへ変わった」という事実から固定の`tmux kill-session`を積むだけで、
 * 画面の停止・追加指示と違って`send-keys`は一切使わない。
 *
 * **新しい受け口も、pollerの新しい対応申告も要らない。** 既存の制御ジョブへ載せているので、
 * サブPC側を更新しなくても（`sessionControlCapable`を申告済みのpollerであれば）効く。
 */

/** 順番待ちの起動ジョブを取り消したときに`message`へ残す理由 */
export const ISSUE_CLOSED_CANCEL_MESSAGE = "Issueがクローズされたため取り消しました。";

export type IssueClosedDispatchResult = {
  /** `KILL`を積めたホスト名 */
  killedHosts: string[];
  /** 積めなかったホストと理由（ログ用。closeそのものは失敗させない） */
  skipped: { host: string; rejection: SessionControlRejection | "error" }[];
  /** 取り消した順番待ちの起動ジョブの件数 */
  canceledJobs: number;
};

/**
 * closeされたIssueに紐づくディスパッチの後片付け。
 *
 * 1. 生きている（`ALIVE`）セッションへ`KILL`を積む
 * 2. まだ流れていない（`QUEUED`）起動ジョブを取り消す
 *
 * **`ALIVE`以外のセッションには積まない。** 終了したペイン（`EXITED`/`FAILED`）は異常終了の
 * 証拠で、最後の出力を読めるように残すのが既存の方針（`reap-sessions.sh`「読む前に消さない」）。
 * 片付けたいときは画面の「セッションを閉じる」を押せばよく、自動で消す理由が無い。
 *
 * **投げない。** 呼び出し元はIssueの同期処理（`upsertIssueRow`）で、ここでの失敗が
 * closeそのものやDB同期を巻き込むと、セッションを畳むための機能でIssueが閉じられなくなる。
 */
export async function handleIssueClosedForDispatch(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<IssueClosedDispatchResult> {
  const now = params.now ?? new Date();
  const result: IssueClosedDispatchResult = { killedHosts: [], skipped: [], canceledJobs: 0 };

  try {
    const sessions = await db.dispatchSession.findMany({
      where: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        state: "ALIVE",
      },
      select: { host: true },
    });

    // 同じホストに複数行（同じIssueで名前の違うセッションが報告されている）ことは通常起きないが、
    // 起きても`KILL`は1回にする。`activeKey`のunique制約でも止まるが、拒否を数えたくない
    for (const host of new Set(sessions.map((session) => session.host))) {
      const enqueued = await enqueueSessionControlJob({
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        hostName: host,
        kind: "KILL",
        // **`requestedByUserId`は入れない。** 画面のボタンから積んだものと区別が付くようにする
        // （webhook・定期同期では押した人そのものが居ない）。表示にも判定にも使われていない
        requestedByUserId: null,
        now,
      });
      if (enqueued.ok) {
        result.killedHosts.push(host);
      } else {
        result.skipped.push({ host, rejection: enqueued.rejection });
      }
    }
  } catch (error) {
    // **握って続ける。** 次の`QUEUED`の取り消しは独立した後片付けで、片方の失敗で諦める理由が無い
    console.error("[dispatch] failed to enqueue KILL for closed issue", {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      error,
    });
    result.skipped.push({ host: "-", rejection: "error" });
  }

  try {
    // **`CLAIMED`以降は触らない。** pollerが既にworktreeの作成へ入っており、ここで
    // `CANCELED`にしても止まらないうえ、走っているものが画面から消える
    // （`cancelDispatchJob`が`RUNNING`を断るのと同じ立場）。立ってしまったセッションは
    // 上の`KILL`ではなく、次の巡でpollerが報告した後の自動回収が拾う。
    const canceled = await db.dispatchJob.updateMany({
      where: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        kind: { in: [...SESSION_LAUNCH_JOB_KINDS] },
        status: "QUEUED",
      },
      data: {
        status: "CANCELED",
        // 未完了の枠を空ける（`cancelDispatchJob`と同じ）。残すと同じIssueへ積み直せない
        activeKey: null,
        finishedAt: now,
        message: ISSUE_CLOSED_CANCEL_MESSAGE,
      },
    });
    result.canceledJobs = canceled.count;
  } catch (error) {
    console.error("[dispatch] failed to cancel queued jobs for closed issue", {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      error,
    });
  }

  return result;
}
