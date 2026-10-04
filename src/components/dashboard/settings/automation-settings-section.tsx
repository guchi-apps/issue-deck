import {
  ExecutionSettingsSection,
  type ExecutionSettingsSectionProps,
} from "@/components/dashboard/settings/execution-settings-section";

/** 計画・レビュー・リリースの即時保存設定を集約する。 */
export function AutomationSettingsSection(props: Omit<ExecutionSettingsSectionProps, "mode">) {
  return <ExecutionSettingsSection {...props} mode="automation" />;
}
