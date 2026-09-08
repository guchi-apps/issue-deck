"use client";

import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { MentionTextarea, type IssueSuggestion } from "@/components/dashboard/mention-textarea";

/**
 * 承認・修正カード共通のテキスト入力欄。MentionTextarea常設表示＋「音声入力を整理」ボタンを担う。
 *
 * **`comment-thread.tsx`から切り出したのは、修正依頼欄が画面上部へ移ったため**（#2914）。
 * マージ待ちの操作一式（レビュー本文・修正依頼）は対応PRセクションの中に置くので、
 * コメント欄の承認カードと同じ入力欄をそちらからも使う。
 */
export function ApprovalTextField({
  value,
  onChange,
  placeholder,
  repositoryFullName,
  issueSuggestions,
  disabled,
  onUploadingChange,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <MentionTextarea
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        issueSuggestions={issueSuggestions}
        repositoryFullName={repositoryFullName}
        onUploadingChange={onUploadingChange}
        disabled={disabled}
      />
      <BodyCleanupButton value={value} onCleaned={onChange} disabled={disabled} />
    </div>
  );
}
