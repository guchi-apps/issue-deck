import {
  ExecutionSettingsSection,
  type ExecutionSettingsSectionProps,
} from "@/components/dashboard/settings/execution-settings-section";

/** AI構成を確認・変更する唯一の通常UI。保存はこの画面のモデル設定に限る。 */
export function AiModelSettingsSection(props: Omit<ExecutionSettingsSectionProps, "mode">) {
  return <ExecutionSettingsSection {...props} mode="ai" />;
}
