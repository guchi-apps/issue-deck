/**
 * Push通知の種類（#4159）。**種類の一覧と表示名の正はここだけ**で、送信側は宛先を引くとき
 * `notMutedWhere(kind)`を足し、設定画面は`PUSH_KINDS`を並べる。
 *
 * OFFは`PushMutedKind`の行で表す（行があればOFF）。既定は全ON。
 */

export const PUSH_KINDS = ["check-user", "release-merge", "release", "deploy-launch"] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export const PUSH_KIND_LABELS: Record<PushKind, { title: string; description: string }> = {
  "check-user": {
    title: "確認待ち",
    description: "Issueに00.check-userが付いたとき",
  },
  "release-merge": {
    title: "本番マージ待ち",
    description: "develop→mainのリリースPRが人のマージ待ちで残っているとき",
  },
  release: {
    title: "リリース完了",
    description: "リポジトリのリリースが公開されたとき",
  },
  "deploy-launch": {
    title: "デプロイ起動漏れ",
    description: "mainへのマージ後にデプロイが起動しなかったとき",
  },
};

export function isPushKind(value: unknown): value is PushKind {
  return typeof value === "string" && (PUSH_KINDS as readonly string[]).includes(value);
}

/** その種類をOFFにしていないユーザーだけに絞る`user`条件。`user: { ..., ...notMutedWhere(kind) }`の形で足す */
export function notMutedWhere(kind: PushKind) {
  return { pushMutedKinds: { none: { kind } } };
}

/** その種類をOFFにしているユーザーの条件（OFFのせいで宛先が空になったかを数えるため） */
export function mutedWhere(kind: PushKind) {
  return { pushMutedKinds: { some: { kind } } };
}
