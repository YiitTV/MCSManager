import { v4 } from "uuid";
import {
  INSTANCE_STATUS,
  InstanceGroup,
  InstanceGroupMember,
  InstanceGroupRun,
  LifecycleAction,
  MAX_ACTIVE_RUNS,
  RUN_RETENTION_MS,
  RunAction,
  RunStep,
  memberKey
} from "../entity/instance_group";
import { $t } from "../i18n";
import { DaemonEventStream, openDaemonEventStream } from "./daemon_event_stream";
import { PatternLineMatcher } from "./instance_group_matcher";
import instanceGroupService, { InstanceGroupError } from "./instance_group_service";
import { logger } from "./log";
import { emitNotification } from "./notification_service";
import { operationLogger } from "./operation_logger";
import RemoteRequest, { RemoteRequestTimeoutError } from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

// Orchestrates ordered group start / stop in the panel.
//
// - One active run per group (checked synchronously before any await) and at
//   most MAX_ACTIVE_RUNS runs panel-wide.
// - For each step: authorise the owner, open ONE short-lived daemon stream
//   (before the command, so no event is missed), send the existing daemon
//   instance/open or instance/stop, and wait on stream events with ONE timer.
//   No polling. Everything is released in `finally`.
// - Runs live in memory only; finished runs are dropped after RUN_RETENTION_MS.
//
// Step `reason` values are machine codes (not translated text):
//   already_running, already_stopped            (skipped)
//   not_permitted, stream_failed, busy, timeout, failure, stopped,
//   not_running, stream_closed, command_failed, cancelled   (failed)

export interface RunOperator {
  ip: string;
  name?: string;
  source?: "api";
}

// The part of DaemonEventStream the runner uses (fakes implement it in tests).
export type RunnerStream = Pick<DaemonEventStream, "status" | "on" | "requestStatus" | "close">;

export interface InstanceGroupRunnerDeps {
  authorize: (ownerUuid: string, daemonId: string, instanceUuid: string) => boolean;
  openStream: (
    daemonId: string,
    instanceUuid: string,
    signal: AbortSignal
  ) => Promise<RunnerStream>;
  // Send the existing daemon instance/open or instance/stop; resolves with the
  // instance nickname when known. A request timeout (the daemon may legitimately
  // take long) is not an error: the stream events decide the outcome.
  sendCommand: (
    daemonId: string,
    event: "instance/open" | "instance/stop",
    instanceUuid: string
  ) => Promise<{ nickname?: string } | void>;
  getRestartTargets: (
    daemonId: string,
    instanceUuids: string[]
  ) => Promise<Map<string, RestartTarget>>;
  sendRestartCommand: (member: InstanceGroupMember, type: string, command: string) => Promise<void>;
  logOperation: (
    action: LifecycleAction,
    info: { daemonId: string; instanceUuid: string; nickname?: string; operator: RunOperator }
  ) => void;
  now: () => number;
}

type RestartTarget = { type: string; status: number };

type LifecycleStep = { member: InstanceGroupMember; action: LifecycleAction };

type StepOutcome = { state: "done" | "skipped" | "failed"; reason?: string };

interface ActiveRun {
  run: InstanceGroupRun;
  group: InstanceGroup;
  operator: RunOperator;
  controller: AbortController;
  retentionTimer?: NodeJS.Timeout;
  done: Promise<void>;
}

export class InstanceGroupRunner {
  private readonly runs = new Map<string, ActiveRun>();
  private activeCount = 0;

  constructor(private readonly deps: InstanceGroupRunnerDeps) {}

  isActive(groupId: string): boolean {
    return this.runs.get(groupId)?.run.state === "running";
  }

  get activeRuns() {
    return this.activeCount;
  }

  /** Active or most recent (retained) run of a group owned by `ownerUuid`, else null. */
  getRun(ownerUuid: string, groupId: string): InstanceGroupRun | null {
    const active = this.runs.get(groupId);
    if (!active || active.run.ownerUuid !== ownerUuid) return null;
    return snapshot(active.run);
  }

  /**
   * Begin an ordered start or stop. All checks run synchronously, before any
   * await, so two simultaneous requests cannot both pass. The members come from
   * the stored `group` only.
   */
  start(group: InstanceGroup, action: RunAction, operator: RunOperator): InstanceGroupRun {
    if (this.isActive(group.uuid))
      throw new InstanceGroupError(409, $t("TXT_CODE_instance_group.runActive"));
    if (this.activeCount >= MAX_ACTIVE_RUNS)
      throw new InstanceGroupError(
        429,
        $t("TXT_CODE_instance_group.tooManyRuns", { max: MAX_ACTIVE_RUNS })
      );

    if (action === "warned-restart") {
      if (group.members.length === 0)
        throw new InstanceGroupError(400, $t("TXT_CODE_instance_group.emptyRestart"));
      for (const { daemonId, instanceUuid } of group.members) {
        if (!this.deps.authorize(group.ownerUuid, daemonId, instanceUuid))
          throw new InstanceGroupError(403, $t("TXT_CODE_instance_group.forbiddenMember"));
      }
    }

    // Replace a finished run that is still retained
    const previous = this.runs.get(group.uuid);
    if (previous?.retentionTimer) clearTimeout(previous.retentionTimer);

    const plan: LifecycleStep[] =
      action === "warned-restart"
        ? [...lifecycleSteps(group, "stop"), ...lifecycleSteps(group, "start")]
        : lifecycleSteps(group, action);
    const run: InstanceGroupRun = {
      runId: v4().replace(/-/g, ""),
      groupId: group.uuid,
      ownerUuid: group.ownerUuid,
      action,
      state: "running",
      steps: plan.map(({ member, action: stepAction }) => ({
        key: memberKey(member.daemonId, member.instanceUuid),
        state: "pending",
        ...(action === "warned-restart" ? { action: stepAction } : {})
      })),
      startedAt: this.deps.now()
    };
    const active: ActiveRun = {
      run,
      group,
      operator,
      controller: new AbortController(),
      done: Promise.resolve()
    };
    this.runs.set(group.uuid, active);
    this.activeCount++;
    active.done = this.execute(active, plan).catch((err) => {
      logger.error(`Instance group run ${run.runId} crashed:`, err);
      if (run.state === "running") run.state = "failed";
    });
    active.done = active.done.finally(() => this.finish(active));
    this.notify(active, "group.run_started", { memberCount: group.members.length });
    return snapshot(run);
  }

  /** Cancel the active run of a group; resolves with its final state. */
  async cancel(ownerUuid: string, groupId: string): Promise<InstanceGroupRun> {
    const active = this.runs.get(groupId);
    if (!active || active.run.ownerUuid !== ownerUuid)
      throw new InstanceGroupError(404, $t("TXT_CODE_instance_group.notFound"));
    if (active.run.state !== "running")
      throw new InstanceGroupError(409, $t("TXT_CODE_instance_group.noActiveRun"));
    active.controller.abort();
    await active.done;
    return snapshot(active.run);
  }

  /** Abort every active run and drop retained runs (shutdown / tests). */
  async dispose() {
    const all = [...this.runs.values()];
    for (const active of all) active.controller.abort();
    await Promise.all(all.map((a) => a.done));
    for (const active of all) if (active.retentionTimer) clearTimeout(active.retentionTimer);
    this.runs.clear();
  }

  // ---- internals ----

  private finish(active: ActiveRun) {
    const { run } = active;
    run.finishedAt = this.deps.now();
    this.activeCount--;
    // Retain the finished run for a while, then forget it (one timer per run)
    active.retentionTimer = setTimeout(() => {
      if (this.runs.get(run.groupId) === active) this.runs.delete(run.groupId);
    }, RUN_RETENTION_MS);
    active.retentionTimer.unref?.();

    const base = {
      memberCount: active.group.members.length,
      durationSec: Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))
    };
    if (run.state === "failed") {
      const failed = run.steps.find((s) => s.state === "failed");
      this.notify(active, "group.run_failed", {
        ...base,
        ...(failed ? { failedStep: { key: failed.key, reason: failed.reason ?? "failure" } } : {})
      });
    } else {
      this.notify(active, "group.run_finished", {
        ...base,
        result: run.state === "cancelled" ? "cancelled" : "succeeded"
      });
    }
  }

  // Synchronous and fully guarded: a notification problem can never affect a run.
  private notify(
    active: ActiveRun,
    type: "group.run_started" | "group.run_finished" | "group.run_failed",
    details: Record<string, unknown>
  ) {
    try {
      const { run, group } = active;
      emitNotification({
        type,
        group: { uuid: group.uuid, name: group.name, action: run.action, runId: run.runId },
        details
      });
    } catch (err) {
      try {
        logger.warn("Instance group: notification failed:", err);
      } catch {}
    }
  }

  private async execute(active: ActiveRun, plan: LifecycleStep[]) {
    const { run, controller } = active;
    if (run.action === "warned-restart") {
      const prepared = await this.prepareRestart(active);
      if (!prepared) return;
    }
    for (const [index, { member, action }] of plan.entries()) {
      if (controller.signal.aborted) {
        run.state = "cancelled";
        return;
      }
      const step = run.steps[index];
      step.state = "waiting";
      const outcome = await this.runStep(active, member, action);
      step.state = outcome.state;
      if (outcome.reason) step.reason = outcome.reason;
      if (outcome.state === "failed") {
        run.state = outcome.reason === "cancelled" ? "cancelled" : "failed";
        return;
      }
    }
    run.state = controller.signal.aborted ? "cancelled" : "succeeded";
  }

  private async prepareRestart(active: ActiveRun): Promise<boolean> {
    const { run, group, controller } = active;
    const { signal } = controller;
    const { offsetsSec, message } = group.restartWarning;
    const deadline = run.startedAt + offsetsSec[0] * 1000;
    run.countdownEndsAt = deadline;
    try {
      for (const seconds of offsetsSec) {
        await waitUntil(deadline - seconds * 1000 - this.deps.now(), signal);
        signal.throwIfAborted();
        await this.dispatchRestartCommands(
          active,
          `say ${message.replace(/\{seconds\}/g, String(seconds))}`
        );
      }
      await waitUntil(deadline - this.deps.now(), signal);
      signal.throwIfAborted();
      delete run.countdownEndsAt;
      await this.dispatchRestartCommands(active, "save-all");
      signal.throwIfAborted();
      return true;
    } catch (err) {
      if (signal.aborted) {
        run.state = "cancelled";
      } else {
        run.state = "failed";
        logger.warn(`Instance group: restart preparation failed for ${run.groupId}:`, err);
      }
      return false;
    } finally {
      delete run.countdownEndsAt;
    }
  }

  private async dispatchRestartCommands(active: ActiveRun, command: string) {
    const { run, group, controller } = active;
    const { signal } = controller;
    const byDaemon = new Map<string, string[]>();
    const authorized = (daemonId: string, instanceUuid: string) =>
      this.deps.authorize(run.ownerUuid, daemonId, instanceUuid);
    const failure = (daemonId: string, instanceUuid: string, reason: string) => {
      const key = memberKey(daemonId, instanceUuid);
      const step = run.steps.find((step) => step.key === key);
      if (step) Object.assign(step, { state: "failed", reason });
      return new Error(reason);
    };

    for (const { daemonId, instanceUuid } of group.members) {
      if (!authorized(daemonId, instanceUuid))
        throw failure(daemonId, instanceUuid, "not_permitted");
      const uuids = byDaemon.get(daemonId) ?? [];
      uuids.push(instanceUuid);
      byDaemon.set(daemonId, uuids);
    }

    // Keep waiting for outstanding requests on failure so no work outlives this run.
    const batches = await Promise.all(
      [...byDaemon].map(async ([daemonId, uuids]) => {
        try {
          const targets = await this.deps.getRestartTargets(daemonId, uuids);
          return { daemonId, uuids, targets };
        } catch (error) {
          return { daemonId, uuids, error };
        }
      })
    );
    signal.throwIfAborted();
    const targets: (InstanceGroupMember & { target: RestartTarget })[] = [];
    for (const { daemonId, uuids, targets: statuses, error } of batches) {
      if (!statuses) {
        for (const uuid of uuids) failure(daemonId, uuid, "command_failed");
        throw error;
      }
      for (const instanceUuid of uuids) {
        if (!authorized(daemonId, instanceUuid))
          throw failure(daemonId, instanceUuid, "not_permitted");
        const target = statuses.get(instanceUuid);
        if (!target) throw failure(daemonId, instanceUuid, "command_failed");
        targets.push({ daemonId, instanceUuid, target });
      }
    }
    const failures = await Promise.all(
      targets.map(async ({ daemonId, instanceUuid, target }) => {
        if (
          target.status !== INSTANCE_STATUS.RUNNING ||
          (target.type !== "minecraft/java/paper" && target.type !== "minecraft/java/purpur")
        )
          return;
        try {
          await this.deps.sendRestartCommand({ daemonId, instanceUuid }, target.type, command);
        } catch {
          if (!signal.aborted) return failure(daemonId, instanceUuid, "command_failed");
        }
      })
    );
    const error = failures.find(Boolean);
    if (error) throw error;
  }

  private async runStep(
    active: ActiveRun,
    member: InstanceGroupMember,
    action: LifecycleAction
  ): Promise<StepOutcome> {
    const { run, controller } = active;
    const { daemonId, instanceUuid } = member;
    const { signal } = controller;
    const isStart = action === "start";

    // Authorisation before the event subscription ...
    if (!this.deps.authorize(run.ownerUuid, daemonId, instanceUuid))
      return { state: "failed", reason: "not_permitted" };

    let stream: RunnerStream | undefined;
    try {
      try {
        stream = await this.deps.openStream(daemonId, instanceUuid, signal);
      } catch (err) {
        if (signal.aborted) return { state: "failed", reason: "cancelled" };
        logger.warn(`Instance group: cannot open daemon stream for ${instanceUuid}:`, err);
        return { state: "failed", reason: "stream_failed" };
      }
      if (signal.aborted) return { state: "failed", reason: "cancelled" };

      const status = stream.status;
      let sendCommand = true;
      if (isStart) {
        if (status === INSTANCE_STATUS.RUNNING)
          return { state: "skipped", reason: "already_running" };
        if (status === INSTANCE_STATUS.STOPPING || status === INSTANCE_STATUS.BUSY)
          return { state: "failed", reason: "busy" };
        // Already starting (e.g. by someone else): just wait for it, do not send again
        if (status === INSTANCE_STATUS.STARTING) sendCommand = false;
      } else {
        if (status === INSTANCE_STATUS.STOP) return { state: "skipped", reason: "already_stopped" };
        if (status === INSTANCE_STATUS.BUSY) return { state: "failed", reason: "busy" };
        if (status === INSTANCE_STATUS.STOPPING) sendCommand = false;
      }

      return await this.waitForTarget(active, member, action, stream, sendCommand);
    } finally {
      stream?.close();
    }
  }

  // Subscribe to the stream, send the command (re-authorising first), and wait
  // for the success condition, a failure event, the timeout, or cancellation.
  private waitForTarget(
    active: ActiveRun,
    member: InstanceGroupMember,
    action: LifecycleAction,
    stream: RunnerStream,
    sendCommand: boolean
  ): Promise<StepOutcome> {
    const { run, group, controller, operator } = active;
    const { daemonId, instanceUuid } = member;
    const { signal } = controller;
    const isStart = action === "start";
    const advance = group.advance;

    return new Promise<StepOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanups: Array<() => void> = [];

      const finish = (outcome: StepOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
        resolve(outcome);
      };

      const onAbort = () => finish({ state: "failed", reason: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) return onAbort();

      cleanups.push(
        stream.on("closed", () => finish({ state: "failed", reason: "stream_closed" }))
      );
      cleanups.push(stream.on("failure", () => finish({ state: "failed", reason: "failure" })));

      if (isStart) {
        // The instance exiting while we wait for it to come up is a failure
        cleanups.push(stream.on("stopped", () => finish({ state: "failed", reason: "stopped" })));
        if (advance.mode === "pattern") {
          const matcher = new PatternLineMatcher(advance.pattern);
          cleanups.push(
            stream.on("stdout", (text) => {
              if (matcher.feed(text)) finish({ state: "done" });
            })
          );
        } else if (advance.mode === "running") {
          cleanups.push(stream.on("opened", () => finish({ state: "done" })));
        }
      } else {
        cleanups.push(stream.on("stopped", () => finish({ state: "done" })));
      }

      // ONE timer per step. delay mode: the delay itself (validated <= timeout);
      // otherwise the step timeout.
      if (isStart && advance.mode === "delay") {
        timer = setTimeout(() => {
          timer = undefined;
          stream.requestStatus(5000).then(
            (status) =>
              finish(
                status === INSTANCE_STATUS.RUNNING
                  ? { state: "done" }
                  : { state: "failed", reason: "not_running" }
              ),
            () => finish({ state: "failed", reason: "not_running" })
          );
        }, advance.delaySec * 1000);
      } else {
        const timeoutSec = isStart ? advance.startTimeoutSec : advance.stopTimeoutSec;
        timer = setTimeout(() => finish({ state: "failed", reason: "timeout" }), timeoutSec * 1000);
      }

      if (!sendCommand) return;

      // ... and again immediately before the command is sent (assignments may
      // have changed while the stream was being opened).
      if (!this.deps.authorize(run.ownerUuid, daemonId, instanceUuid))
        return finish({ state: "failed", reason: "not_permitted" });

      this.deps
        .sendCommand(daemonId, isStart ? "instance/open" : "instance/stop", instanceUuid)
        .then(
          (result) => {
            try {
              this.deps.logOperation(action, {
                daemonId,
                instanceUuid,
                nickname: result?.nickname,
                operator
              });
            } catch (err) {
              logger.warn("Instance group: failed to write operation log:", err);
            }
          },
          (err) => {
            logger.warn(`Instance group: ${action} command failed for ${instanceUuid}:`, err);
            finish({ state: "failed", reason: "command_failed" });
          }
        );
    });
  }
}

function waitUntil(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function lifecycleSteps(group: InstanceGroup, action: LifecycleAction): LifecycleStep[] {
  return orderedMembers(group, action).map((member) => ({ member, action }));
}

function orderedMembers(group: InstanceGroup, action: LifecycleAction): InstanceGroupMember[] {
  if (action === "start") return group.members.map((m) => ({ ...m }));
  const byKey = new Map(group.members.map((m) => [memberKey(m.daemonId, m.instanceUuid), m]));
  const ordered: InstanceGroupMember[] = [];
  for (const key of group.stopOrder) {
    const member = byKey.get(key);
    if (member) ordered.push({ ...member });
  }
  return ordered;
}

function snapshot(run: InstanceGroupRun): InstanceGroupRun {
  return { ...run, steps: run.steps.map((s): RunStep => ({ ...s })) };
}

// ---- production wiring ----

const instanceGroupRunner = new InstanceGroupRunner({
  authorize: (owner, daemonId, instanceUuid) =>
    instanceGroupService.authorizeMember(owner, daemonId, instanceUuid),
  openStream: (daemonId, instanceUuid, signal) =>
    openDaemonEventStream(daemonId, instanceUuid, { signal }),
  sendCommand: async (daemonId, event, instanceUuid) => {
    try {
      const result = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        event,
        { instanceUuids: [instanceUuid] }
      );
      return { nickname: result?.instances?.[0]?.nickname };
    } catch (err) {
      if (err instanceof RemoteRequestTimeoutError) return {};
      throw err;
    }
  },
  getRestartTargets: async (daemonId, instanceUuids) => {
    const result = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
      "instance/status_batch",
      { instanceUuids, includeType: true },
      3000
    );
    const targets = new Map<string, RestartTarget>();
    if (!Array.isArray(result?.instances)) return targets;
    for (const item of result.instances) {
      if (typeof item?.type === "string" && typeof item.status === "number") {
        targets.set(item.instanceUuid, { type: item.type, status: item.status });
      }
    }
    return targets;
  },
  sendRestartCommand: async ({ daemonId, instanceUuid }, expectedType, command) => {
    await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
      "instance/command",
      { instanceUuid, command, requireRunning: true, expectedType },
      3000
    );
  },
  logOperation: (action, { daemonId, instanceUuid, nickname, operator }) => {
    operationLogger.log(action === "start" ? "instance_start" : "instance_stop", {
      daemon_id: daemonId,
      instance_id: instanceUuid,
      operator_ip: operator.ip,
      operator_name: operator.name,
      operator_source: operator.source,
      instance_name: nickname
    });
  },
  now: () => Date.now()
});

// Groups with an active run cannot have members changed or be deleted
instanceGroupService.setActiveRunChecker((groupId) => instanceGroupRunner.isActive(groupId));

export default instanceGroupRunner;
