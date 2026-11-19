import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import {
  ADVANCE_MODES,
  INSTANCE_GROUP_CATEGORY,
  InstanceGroup,
  InstanceGroupAdvance,
  InstanceGroupMember,
  MAX_DELAY_SEC,
  MAX_GROUPS_PER_USER,
  MAX_GROUP_NAME_LENGTH,
  MAX_ID_LENGTH,
  MAX_MEMBERS_PER_GROUP,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  defaultAdvance,
  memberKey
} from "../entity/instance_group";
import { $t } from "../i18n";
import { logger } from "./log";
import { validatePattern } from "./instance_group_matcher";
import { isHaveInstanceByUuid } from "./permission_service";
import userSystem from "./user_service";

// Error carrying the HTTP status the router should answer with.
export class InstanceGroupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string
  ) {
    super(message);
  }
}

export interface InstanceGroupInput {
  name?: unknown;
  members?: unknown;
  stopOrder?: unknown;
  advance?: unknown;
}

export interface InstanceGroupStore {
  store(category: string, uuid: string, object: any): Promise<void>;
  load(category: string, classz: any, uuid: string): Promise<any>;
  list(category: string): Promise<Array<string>>;
  delete(category: string, uuid: string): Promise<void>;
}

export interface InstanceGroupDeps {
  storage: () => InstanceGroupStore;
  userExists: (userUuid: string) => boolean;
  // Whether the user is an administrator or has the instance assigned
  canOperate: (userUuid: string, daemonId: string, instanceUuid: string) => boolean;
  now: () => number;
}

const ID_REGEX = /^[A-Za-z0-9_-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(key: string, params?: Record<string, unknown>) {
  return new InstanceGroupError(400, $t(`TXT_CODE_instance_group.${key}`, params));
}

export function validateName(value: unknown): string {
  if (typeof value !== "string")
    throw validationError("invalidName", { max: MAX_GROUP_NAME_LENGTH });
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_GROUP_NAME_LENGTH || CONTROL_CHARS.test(name))
    throw validationError("invalidName", { max: MAX_GROUP_NAME_LENGTH });
  return name;
}

// Structure-only validation: types, lengths, uniqueness and the member limit.
// Only the two identifier fields are read; any other (display) data is ignored.
export function validateMembers(value: unknown): InstanceGroupMember[] {
  if (!Array.isArray(value)) throw validationError("invalidMembers");
  if (value.length > MAX_MEMBERS_PER_GROUP)
    throw validationError("tooManyMembers", { max: MAX_MEMBERS_PER_GROUP });
  const seen = new Set<string>();
  const members: InstanceGroupMember[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) throw validationError("invalidMembers");
    const { daemonId, instanceUuid } = item;
    for (const id of [daemonId, instanceUuid]) {
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > MAX_ID_LENGTH ||
        !ID_REGEX.test(id)
      )
        throw validationError("invalidMembers");
    }
    const key = memberKey(daemonId as string, instanceUuid as string);
    if (seen.has(key)) throw validationError("duplicateMember");
    seen.add(key);
    members.push({ daemonId: daemonId as string, instanceUuid: instanceUuid as string });
  }
  return members;
}

export function validateStopOrder(value: unknown, members: InstanceGroupMember[]): string[] {
  if (!Array.isArray(value) || value.length !== members.length)
    throw validationError("invalidOrder");
  const expected = new Set(members.map((m) => memberKey(m.daemonId, m.instanceUuid)));
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string" || !expected.has(key) || seen.has(key))
      throw validationError("invalidOrder");
    seen.add(key);
  }
  return value as string[];
}

function validateInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw validationError("invalidAdvance");
  return value;
}

// Merge a (partial) advance config over `base` and validate the result.
export function validateAdvance(value: unknown, base: InstanceGroupAdvance): InstanceGroupAdvance {
  const result: InstanceGroupAdvance = { ...base };
  if (value !== undefined) {
    if (!isPlainObject(value)) throw validationError("invalidAdvance");
    if (value.mode !== undefined) {
      if (!ADVANCE_MODES.includes(value.mode as any)) throw validationError("invalidAdvance");
      result.mode = value.mode as InstanceGroupAdvance["mode"];
    }
    if (value.pattern !== undefined) {
      if (validatePattern(value.pattern) !== null) throw validationError("invalidPattern");
      result.pattern = value.pattern as string;
    }
    if (value.delaySec !== undefined)
      result.delaySec = validateInteger(value.delaySec, 0, MAX_DELAY_SEC);
    if (value.startTimeoutSec !== undefined)
      result.startTimeoutSec = validateInteger(
        value.startTimeoutSec,
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC
      );
    if (value.stopTimeoutSec !== undefined)
      result.stopTimeoutSec = validateInteger(
        value.stopTimeoutSec,
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC
      );
  }
  if (validatePattern(result.pattern) !== null) throw validationError("invalidPattern");
  if (result.mode === "delay" && result.delaySec > result.startTimeoutSec)
    throw validationError("delayExceedsTimeout");
  return result;
}

// Sanitise a record read from storage so a hand-edited or corrupted file can
// never carry out-of-range values into the runner. Returns null when unusable.
function normalizeStored(raw: any): InstanceGroup | null {
  try {
    if (!raw || typeof raw.uuid !== "string" || !ID_REGEX.test(raw.uuid)) return null;
    if (typeof raw.ownerUuid !== "string" || !raw.ownerUuid) return null;
    const group = new InstanceGroup();
    group.uuid = raw.uuid;
    group.ownerUuid = raw.ownerUuid;
    group.name = validateName(raw.name);
    group.members = validateMembers(raw.members);
    try {
      group.stopOrder = validateStopOrder(raw.stopOrder, group.members);
    } catch {
      group.stopOrder = group.members.map((m) => memberKey(m.daemonId, m.instanceUuid));
    }
    try {
      group.advance = validateAdvance(raw.advance, defaultAdvance());
    } catch {
      group.advance = defaultAdvance();
    }
    group.createdAt = Number(raw.createdAt) || 0;
    group.updatedAt = Number(raw.updatedAt) || 0;
    return group;
  } catch {
    return null;
  }
}

function cloneGroup(group: InstanceGroup): InstanceGroup {
  return {
    ...group,
    members: group.members.map((m) => ({ ...m })),
    stopOrder: [...group.stopOrder],
    advance: { ...group.advance }
  };
}

export class InstanceGroupService {
  private readonly groups = new Map<string, InstanceGroup>();
  private readonly chains = new Map<string, Promise<unknown>>();
  // Set by the runner: whether a group currently has an active run.
  private activeRunChecker: (groupId: string) => boolean = () => false;

  constructor(private readonly deps: InstanceGroupDeps) {}

  setActiveRunChecker(checker: (groupId: string) => boolean) {
    this.activeRunChecker = checker;
  }

  // Load all groups into memory; drop groups whose owner no longer exists.
  async initialize() {
    const storage = this.deps.storage();
    for (const uuid of await storage.list(INSTANCE_GROUP_CATEGORY)) {
      try {
        const raw = await storage.load(INSTANCE_GROUP_CATEGORY, InstanceGroup, uuid);
        const group = normalizeStored(raw);
        if (!group || group.uuid !== uuid) {
          logger.warn(`Instance group ${uuid} is invalid and was ignored.`);
          continue;
        }
        if (!this.deps.userExists(group.ownerUuid)) {
          await storage.delete(INSTANCE_GROUP_CATEGORY, uuid);
          logger.info(`Instance group ${uuid} dropped: owner no longer exists.`);
          continue;
        }
        this.groups.set(uuid, group);
      } catch (err) {
        logger.warn(`Failed to load instance group ${uuid}:`, err);
      }
    }
    logger.info(`Instance groups loaded: ${this.groups.size}`);
  }

  // ---- reads (always owner-filtered; foreign groups behave as not found) ----

  listByOwner(ownerUuid: string): InstanceGroup[] {
    const result: InstanceGroup[] = [];
    for (const group of this.groups.values()) {
      if (group.ownerUuid === ownerUuid) result.push(cloneGroup(group));
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  find(ownerUuid: string, groupId: string): InstanceGroup | null {
    if (!ownerUuid || typeof groupId !== "string") return null;
    const group = this.groups.get(groupId);
    if (!group || group.ownerUuid !== ownerUuid) return null;
    return cloneGroup(group);
  }

  get(ownerUuid: string, groupId: string): InstanceGroup {
    const group = this.find(ownerUuid, groupId);
    if (!group) throw new InstanceGroupError(404, $t("TXT_CODE_instance_group.notFound"));
    return group;
  }

  // ---- member authorisation ----

  // The owner must still exist AND be an administrator or have the instance assigned.
  authorizeMember(ownerUuid: string, daemonId: string, instanceUuid: string): boolean {
    if (!ownerUuid || !this.deps.userExists(ownerUuid)) return false;
    return this.deps.canOperate(ownerUuid, daemonId, instanceUuid);
  }

  private assertMembersAllowed(ownerUuid: string, members: InstanceGroupMember[]) {
    for (const member of members) {
      if (!this.authorizeMember(ownerUuid, member.daemonId, member.instanceUuid))
        throw new InstanceGroupError(403, $t("TXT_CODE_instance_group.forbiddenMember"));
    }
  }

  // ---- writes ----

  async create(ownerUuid: string, input: InstanceGroupInput): Promise<InstanceGroup> {
    if (!ownerUuid || !this.deps.userExists(ownerUuid))
      throw new InstanceGroupError(403, $t("TXT_CODE_permission.forbidden"));
    const name = validateName(input.name);
    const members = validateMembers(input.members ?? []);
    const stopOrder =
      input.stopOrder === undefined
        ? members.map((m) => memberKey(m.daemonId, m.instanceUuid))
        : validateStopOrder(input.stopOrder, members);
    const advance = validateAdvance(input.advance, defaultAdvance());
    this.assertMembersAllowed(ownerUuid, members);

    // Count check and insert happen with no await in between, so concurrent
    // creates cannot exceed the limit.
    let owned = 0;
    for (const g of this.groups.values()) if (g.ownerUuid === ownerUuid) owned++;
    if (owned >= MAX_GROUPS_PER_USER)
      throw validationError("tooManyGroups", { max: MAX_GROUPS_PER_USER });

    const now = this.deps.now();
    const group = new InstanceGroup();
    group.uuid = v4().replace(/-/g, "");
    group.ownerUuid = ownerUuid;
    group.name = name;
    group.members = members;
    group.stopOrder = stopOrder;
    group.advance = advance;
    group.createdAt = now;
    group.updatedAt = now;

    this.groups.set(group.uuid, group);
    try {
      await this.deps.storage().store(INSTANCE_GROUP_CATEGORY, group.uuid, group);
    } catch (err) {
      this.groups.delete(group.uuid);
      throw err;
    }
    return cloneGroup(group);
  }

  async update(
    ownerUuid: string,
    groupId: string,
    input: InstanceGroupInput
  ): Promise<InstanceGroup> {
    this.get(ownerUuid, groupId);
    return this.serialize(groupId, async () => {
      const current = this.groups.get(groupId);
      if (!current || current.ownerUuid !== ownerUuid)
        throw new InstanceGroupError(404, $t("TXT_CODE_instance_group.notFound"));
      const next = cloneGroup(current);

      if (input.name !== undefined) next.name = validateName(input.name);

      if (input.members !== undefined) {
        const members = validateMembers(input.members);
        this.assertMembersAllowed(ownerUuid, members);
        const keys = members.map((m) => memberKey(m.daemonId, m.instanceUuid));
        const keySet = new Set(keys);
        // Removed members leave the stop order; new members are appended to it.
        const kept = current.stopOrder.filter((key) => keySet.has(key));
        const keptSet = new Set(kept);
        next.members = members;
        next.stopOrder = [...kept, ...keys.filter((key) => !keptSet.has(key))];
      }
      if (input.stopOrder !== undefined)
        next.stopOrder = validateStopOrder(input.stopOrder, next.members);
      if (input.advance !== undefined)
        next.advance = validateAdvance(input.advance, current.advance);

      const membersChanged =
        input.members !== undefined &&
        JSON.stringify(current.members) !== JSON.stringify(next.members);
      if (membersChanged && this.activeRunChecker(groupId))
        throw new InstanceGroupError(409, $t("TXT_CODE_instance_group.runActive"));

      next.updatedAt = this.deps.now();
      await this.deps.storage().store(INSTANCE_GROUP_CATEGORY, groupId, next);
      this.groups.set(groupId, next);
      return cloneGroup(next);
    });
  }

  async remove(ownerUuid: string, groupId: string): Promise<void> {
    this.get(ownerUuid, groupId);
    await this.serialize(groupId, async () => {
      const current = this.groups.get(groupId);
      if (!current || current.ownerUuid !== ownerUuid)
        throw new InstanceGroupError(404, $t("TXT_CODE_instance_group.notFound"));
      if (this.activeRunChecker(groupId))
        throw new InstanceGroupError(409, $t("TXT_CODE_instance_group.runActive"));
      await this.deps.storage().delete(INSTANCE_GROUP_CATEGORY, groupId);
      this.groups.delete(groupId);
    });
  }

  // Called when a user is deleted.
  async removeByOwner(ownerUuid: string): Promise<void> {
    for (const group of [...this.groups.values()]) {
      if (group.ownerUuid !== ownerUuid) continue;
      try {
        await this.serialize(group.uuid, async () => {
          await this.deps.storage().delete(INSTANCE_GROUP_CATEGORY, group.uuid);
          this.groups.delete(group.uuid);
        });
      } catch (err) {
        logger.warn(`Failed to delete instance group ${group.uuid}:`, err);
      }
    }
  }

  // Per-group promise chain: writes to the same group apply strictly in order.
  private serialize<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(groupId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.chains.set(groupId, tail);
    // Drop the chain entry once idle so the map does not grow
    tail.then(() => {
      if (this.chains.get(groupId) === tail) this.chains.delete(groupId);
    });
    return run;
  }
}

// ---- list view -------------------------------------------------------------

export interface MemberStatus {
  nickname?: string;
  status: number | "unknown";
}

export type MemberStatusResolver = (
  daemonId: string,
  instanceUuids: string[]
) => Promise<Map<string, MemberStatus>>;

export interface InstanceGroupMemberView {
  daemonId: string;
  instanceUuid: string;
  // false: the owner may no longer operate this instance (no name, no status)
  available: boolean;
  nickname?: string;
  status?: number | "unknown";
}

export interface InstanceGroupView {
  uuid: string;
  name: string;
  members: InstanceGroupMemberView[];
  stopOrder: string[];
  advance: InstanceGroupAdvance;
  createdAt: number;
  updatedAt: number;
}

// Build the response view of one or more groups. Unauthorised members are
// returned as unavailable without name or status and are never sent to a daemon.
export async function buildGroupViews(
  service: InstanceGroupService,
  ownerUuid: string,
  groups: InstanceGroup[],
  resolve: MemberStatusResolver
): Promise<InstanceGroupView[]> {
  // Collect authorised members, grouped by daemon, without duplicates
  const byDaemon = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const m of group.members) {
      if (!service.authorizeMember(ownerUuid, m.daemonId, m.instanceUuid)) continue;
      if (!byDaemon.has(m.daemonId)) byDaemon.set(m.daemonId, new Set());
      byDaemon.get(m.daemonId)!.add(m.instanceUuid);
    }
  }
  const statuses = new Map<string, MemberStatus>();
  await Promise.all(
    [...byDaemon.entries()].map(async ([daemonId, uuids]) => {
      let result: Map<string, MemberStatus> | undefined;
      try {
        result = await resolve(daemonId, [...uuids]);
      } catch {
        result = undefined;
      }
      for (const uuid of uuids) {
        statuses.set(memberKey(daemonId, uuid), result?.get(uuid) ?? { status: "unknown" });
      }
    })
  );

  return groups.map((group) => ({
    uuid: group.uuid,
    name: group.name,
    members: group.members.map((m) => {
      const key = memberKey(m.daemonId, m.instanceUuid);
      const info = statuses.get(key);
      if (!info) return { daemonId: m.daemonId, instanceUuid: m.instanceUuid, available: false };
      return {
        daemonId: m.daemonId,
        instanceUuid: m.instanceUuid,
        available: true,
        nickname: info.nickname,
        status: info.status
      };
    }),
    stopOrder: group.stopOrder,
    advance: group.advance,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt
  }));
}

// Production singleton
const instanceGroupService = new InstanceGroupService({
  storage: () => Storage.getStorage(),
  userExists: (uuid) => userSystem.hasInstance(uuid),
  canOperate: (userUuid, daemonId, instanceUuid) =>
    isHaveInstanceByUuid(userUuid, daemonId, instanceUuid),
  now: () => Date.now()
});

export default instanceGroupService;
