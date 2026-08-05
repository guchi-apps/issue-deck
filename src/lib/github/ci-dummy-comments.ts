import type { GithubApiComment } from "@/lib/github/issues-api";

/**
 * scripts/seed-ci-db.mjsが投入するCI用画面確認ダミーリポジトリのfullNameと必ず一致させること。
 * このリポジトリ宛のコメント取得だけ、実際のGitHub API呼び出し（CIには対応する実在の
 * GitHub Appインストールが無く必ず失敗する）を行わず、下記のダミーコメントを返す。
 */
export const CI_DUMMY_REPOSITORY_FULL_NAME = "ci-dummy-org/sample-repo";

/**
 * コメント単位AI要約機能（#571）の「要約を生成」ボタンがLONG_COMMENT_THRESHOLD
 * （src/components/dashboard/comment-thread.tsx）を超える本文にのみ表示されるため、
 * 画面確認用に長文コメントを1件含めている。
 */
export function getCiDummyComments(): GithubApiComment[] {
  const now = Date.now();
  const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

  return [
    {
      id: 1,
      user: { login: "ci-dummy-user" },
      body: "画面確認用のダミーコメントです。よろしくお願いします。",
      created_at: hoursAgo(5),
      reactions: { "+1": 0 },
    },
    {
      id: 2,
      user: { login: "ci-dummy-user" },
      body:
        "画面確認用の長文ダミーコメントです。このコメントはAI要約ボタンの表示確認のため、意図的に400文字を超える長さにしています。\n\n" +
        "現状整理: 既存のIssue全体AI要約機能とは別に、コメント単位で「重要な点」「変更点」「懸念点」の3観点の要約を生成・表示する機能を追加しました。コメント本体はDBに保存されず表示のたびにGitHub APIから取得する既存方針を踏襲しつつ、要約結果のみDBにキャッシュします。生成はボタン押下時のみ行い、Issue全体要約と同様に自動生成は行いません。\n\n" +
        "変更点: DBスキーマに新規モデルを追加し、コメント編集時にはキャッシュを削除して再生成をボタン操作に委ねる方式にしました。GitHub APIラッパーには単一コメント取得用の関数を追加し、全件取得APIを無駄に呼ばずに済むようにしています。\n\n" +
        "懸念点: 要約ボタンを表示する本文文字数の閾値は暫定値のため、実際の運用を見ながら調整が必要になる可能性があります。また、Claudeのプラン枠を消費するため、生成頻度についても引き続き注視が必要だと考えています。",
      created_at: hoursAgo(3),
      reactions: { "+1": 2 },
    },
    {
      id: 3,
      user: { login: "ci-dummy-user" },
      body: "確認しました、ありがとうございます。",
      created_at: hoursAgo(1),
      reactions: { "+1": 1 },
    },
  ];
}
