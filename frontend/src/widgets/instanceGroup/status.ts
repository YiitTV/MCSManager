import { t } from "@/lang/i18n";
import { INSTANCE_STATUS, INSTANCE_STATUS_CODE } from "@/types/const";
import type { GroupMemberView } from "@/types/instanceGroup";

export function isMemberUnavailable(member: GroupMemberView): boolean {
  return member.available === false;
}

// Label of a member's status. Reuses the shared INSTANCE_STATUS labels.
export function memberStatusLabel(member: GroupMemberView): string {
  if (isMemberUnavailable(member)) return t("TXT_CODE_instance_group_ui.unavailable");
  if (typeof member.status !== "number") return t("TXT_CODE_instance_group_ui.unknown");
  const label = INSTANCE_STATUS[member.status as INSTANCE_STATUS_CODE];
  return label ? t(String(label)) : t("TXT_CODE_instance_group_ui.unknown");
}

// Ant Design tag colour for a status; same mapping as the instance list (InstanceLine.vue).
export function memberStatusColor(member: GroupMemberView): string {
  if (isMemberUnavailable(member)) return "";
  if (member.status === INSTANCE_STATUS_CODE.RUNNING) return "green";
  if (member.status === INSTANCE_STATUS_CODE.STARTING) return "pink";
  if (member.status === INSTANCE_STATUS_CODE.STOPPING) return "orange";
  return "";
}

// Machine reason codes sent by the panel for skipped and failed run steps
// (panel/src/app/service/instance_group_runner.ts).
const STEP_REASON_KEYS: Record<string, string> = {
  already_running: "TXT_CODE_instance_group_ui.reason_already_running",
  already_stopped: "TXT_CODE_instance_group_ui.reason_already_stopped",
  not_permitted: "TXT_CODE_instance_group_ui.reason_not_permitted",
  stream_failed: "TXT_CODE_instance_group_ui.reason_stream_failed",
  busy: "TXT_CODE_instance_group_ui.reason_busy",
  timeout: "TXT_CODE_instance_group_ui.reason_timeout",
  failure: "TXT_CODE_instance_group_ui.reason_failure",
  stopped: "TXT_CODE_instance_group_ui.reason_stopped",
  not_running: "TXT_CODE_instance_group_ui.reason_not_running",
  stream_closed: "TXT_CODE_instance_group_ui.reason_stream_closed",
  command_failed: "TXT_CODE_instance_group_ui.reason_command_failed",
  cancelled: "TXT_CODE_instance_group_ui.reason_cancelled"
};

export const STEP_REASON_CODES = Object.keys(STEP_REASON_KEYS);

// Translated text of a step reason; unknown codes get a generic label instead of raw text.
export function stepReasonLabel(reason: string | undefined): string {
  if (!reason) return "";
  const key = Object.prototype.hasOwnProperty.call(STEP_REASON_KEYS, reason)
    ? STEP_REASON_KEYS[reason]
    : "TXT_CODE_instance_group_ui.reason_unknown";
  return t(key);
}
