export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** GitHubの応答本文（生の文字列）。画面向けに理由を読み直す呼び出し側だけが渡す（#4878） */
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}
