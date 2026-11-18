// Instance groups: per-user ordered collections of instances that can be
// started and stopped in a defined order. See openspec/changes/instance-groups.

export const INSTANCE_GROUP_CATEGORY = "InstanceGroup";

export const MAX_GROUPS_PER_USER = 20;
export const MAX_MEMBERS_PER_GROUP = 30;
export const MAX_GROUP_NAME_LENGTH = 40;
export const MAX_ID_LENGTH = 128;

// Ready pattern limits (literal text plus "*" wildcards, never a regex).
export const MAX_PATTERN_LENGTH = 200;
export const MAX_PATTERN_WILDCARDS = 5;
export const MAX_LINE_LENGTH = 4096;
export const MAX_CARRY_BUFFER = 8 * 1024;

export const MIN_TIMEOUT_SEC = 5;
export const MAX_TIMEOUT_SEC = 3600;
export const MAX_DELAY_SEC = 3600;

export const DEFAULT_PATTERN = "Done (*)!";
export const DEFAULT_DELAY_SEC = 15;
export const DEFAULT_TIMEOUT_SEC = 180;

// Orchestration limits
export const MAX_ACTIVE_RUNS = 8;
export const RUN_RETENTION_MS = 10 * 60 * 1000;
export const STREAM_CONNECT_TIMEOUT_MS = 10_000;

export type AdvanceMode = "pattern" | "running" | "delay";
export const ADVANCE_MODES: readonly AdvanceMode[] = ["pattern", "running", "delay"];

export interface InstanceGroupMember {
  daemonId: string;
  instanceUuid: string;
}

export interface InstanceGroupAdvance {
  mode: AdvanceMode;
  pattern: string;
  delaySec: number;
  startTimeoutSec: number;
  stopTimeoutSec: number;
}

// Persisted record (one JSON file per group under data/InstanceGroup/).
// No display data (names, status) is stored; it is resolved at read time.
export class InstanceGroup {
  uuid = "";
  ownerUuid = "";
  name = "";
  members: InstanceGroupMember[] = [];
  // "<daemonId>::<instanceUuid>" keys, a permutation of members
  stopOrder: string[] = [];
  advance: InstanceGroupAdvance = defaultAdvance();
  createdAt = 0;
  updatedAt = 0;
}

export function defaultAdvance(): InstanceGroupAdvance {
  return {
    mode: "pattern",
    pattern: DEFAULT_PATTERN,
    delaySec: DEFAULT_DELAY_SEC,
    startTimeoutSec: DEFAULT_TIMEOUT_SEC,
    stopTimeoutSec: DEFAULT_TIMEOUT_SEC
  };
}

export function memberKey(daemonId: string, instanceUuid: string) {
  return `${daemonId}::${instanceUuid}`;
}

// Daemon instance status values (daemon/src/entity/instance/instance.ts)
export const INSTANCE_STATUS = {
  BUSY: -1,
  STOP: 0,
  STOPPING: 1,
  STARTING: 2,
  RUNNING: 3
} as const;

// Run state (in memory only)
export type RunAction = "start" | "stop";
export type RunState = "running" | "succeeded" | "failed" | "cancelled";
export type StepState = "pending" | "waiting" | "done" | "skipped" | "failed";

export interface RunStep {
  key: string;
  state: StepState;
  reason?: string;
}

export interface InstanceGroupRun {
  runId: string;
  groupId: string;
  ownerUuid: string;
  action: RunAction;
  state: RunState;
  steps: RunStep[];
  startedAt: number;
  finishedAt?: number;
}
