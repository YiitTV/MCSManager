// Types shared by the instance groups page. They mirror the panel API contract in
// openspec/changes/instance-groups/design.md (section 3, 4 and 5).

export type GroupAdvanceMode = "pattern" | "running" | "delay";

export interface GroupAdvance {
  mode: GroupAdvanceMode;
  pattern: string;
  delaySec: number;
  startTimeoutSec: number;
  stopTimeoutSec: number;
}

export interface GroupMemberRef {
  daemonId: string;
  instanceUuid: string;
}

export interface GroupMemberView extends GroupMemberRef {
  // false: the user may no longer operate this instance (no nickname, no status).
  available: boolean;
  // Resolved by the panel at read time. Missing for unavailable members.
  nickname?: string;
  // INSTANCE_STATUS_CODE, or "unknown" when the panel could not resolve it.
  status?: number | "unknown";
}

export interface InstanceGroupView {
  uuid: string;
  // Active or most recent run (kept by the panel for 10 minutes), null when none.
  run: GroupRun | null;
  name: string;
  members: GroupMemberView[];
  // "<daemonId>::<instanceUuid>" keys, a permutation of the members.
  stopOrder: string[];
  advance: GroupAdvance;
  createdAt: number;
  updatedAt: number;
}

export interface InstanceGroupInput {
  name: string;
  members: GroupMemberRef[];
  stopOrder: string[];
  advance: GroupAdvance;
}

export type GroupRunState = "running" | "succeeded" | "failed" | "cancelled";
export type GroupStepState = "pending" | "waiting" | "done" | "skipped" | "failed";

export interface GroupRunStep {
  key: string;
  state: GroupStepState;
  reason?: string;
}

export interface GroupRun {
  runId: string;
  groupId: string;
  ownerUuid?: string;
  action: "start" | "stop";
  state: GroupRunState;
  steps: GroupRunStep[];
  startedAt: number;
  finishedAt?: number;
}

// Limits mirrored from the panel (validated again server-side).
export const GROUP_LIMITS = {
  maxGroups: 20,
  maxMembers: 30,
  nameMax: 40,
  patternMax: 200,
  patternMaxWildcards: 5,
  delayMax: 3600,
  timeoutMin: 5,
  timeoutMax: 3600
} as const;

export const DEFAULT_GROUP_ADVANCE: GroupAdvance = {
  mode: "pattern",
  pattern: "Done (*)!",
  delaySec: 15,
  startTimeoutSec: 180,
  stopTimeoutSec: 180
};

export function memberKey(member: GroupMemberRef): string {
  return `${member.daemonId}::${member.instanceUuid}`;
}

export function isRunActive(run: GroupRun | null | undefined): boolean {
  return run?.state === "running";
}
