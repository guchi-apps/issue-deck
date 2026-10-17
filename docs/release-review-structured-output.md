# 全体レビューの構造化出力

Codex経路は `scripts/prompts/release-review-result.schema.json` を `--output-schema` で渡す。バッチと最後の相互作用確認に同じ契約を使い、既存の確認項目・指摘・再レビュー情報を保持する（#4704）。
schemaはJSON構文を安定させるだけで、確認済みや合格を保証しない。サーバー側の対象SHA・確認範囲・未確認・阻害指摘の検査と本番公開条件は変更しない。不正な応答を推測で修復しない。
Claude経路と既存のJSONコードブロックの解析は維持する。サブPCへ通常のコード更新が反映された後に再実行する。CLIがschema指定を受け付けない場合も失敗として扱い、形式指定なしでの黙ったフォールバックはしない。

参考: https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex
