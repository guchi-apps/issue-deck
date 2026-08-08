import type { CiState } from "@/lib/github/release-api";

/**
 * scripts/seed-ci-db.mjsが投入するCI用ダミーリポジトリ（最初の1件）のgithubRepositoryId。
 * 実在しないリポジトリのためGitHub APIからは取得できず、無人でのスクリーンショット撮影時は
 * このIDのリポジトリに対してのみ固定のダミーデータを返す(#550)。
 */
export const CI_DUMMY_REPOSITORY_GITHUB_ID = 900000001;

/**
 * 設定画面の「mainへのマージ待ち」表示（#858）をCI環境でも確認できるよう、
 * develop→mainのPRがオープン中の状態を再現する固定のダミーデータ。
 * scripts/seed-ci-db.mjsがCI_DUMMY_REPOSITORY_GITHUB_IDのリポジトリにのみ
 * hasClaudeWorkflow: trueを設定し、この状態を再現している。
 */
export const CI_DUMMY_RELEASE_PULL_REQUEST_NUMBER = 9999;
export const CI_DUMMY_RELEASE_PULL_REQUEST_TITLE = "v2.4.0をmainへ反映する";
export const CI_DUMMY_RELEASE_PULL_REQUEST_CI_STATE: CiState = "success";
export const CI_DUMMY_MAIN_VERSION = "2.3.0";
export const CI_DUMMY_DEVELOP_VERSION = "2.4.0";
