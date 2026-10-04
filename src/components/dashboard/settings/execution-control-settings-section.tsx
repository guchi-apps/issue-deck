import {
  ExecutionSettingsSection,
  type ExecutionSettingsSectionProps,
} from "@/components/dashboard/settings/execution-settings-section";

/** モデル選択を含めず、処理の走らせ方だけを扱う。 */
export function ExecutionControlSettingsSection(props: Omit<ExecutionSettingsSectionProps, "mode">) {
  return <ExecutionSettingsSection {...props} mode="execution" />;
}
