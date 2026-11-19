import { v4 } from "uuid";
import {
  INSTANCE_STATUS,
  InstanceGroup,
  InstanceGroupMember,
  InstanceGroupRun,
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
  logOperation: (
    action: RunAction,
    info: { daemonId: string; instanceUuid: string; nickname?: string; operator: RunOperator }
  ) => void;
  now: () => number;
}

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

    // Replace a finished run that is still retained
    const previous = this.runs.get(group.uuid);
    if (previous?.retentionTimer) clearTimeout(previous.retentionTimer);

    const members = orderedMembers(group, action);
    const run: InstanceGroupRun = {
      runId: v4().replace(/-/g, ""),
      groupId: group.uuid,
      ownerUuid: group.ownerUuid,
      action,
      state: "running",
      steps: members.map((m) => ({ key: memberKey(m.daemonId, m.instanceUuid), state: "pending" })),
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
    active.done = this.execute(active, members).catch((err) => {
      logger.error(`Instance group run ${run.runId} crashed:`, err);
      if (run.state === "running") run.state = "failed";
    });
    active.done = active.done.finally(() => this.finish(active));
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
  }

  private async execute(active: ActiveRun, members: InstanceGroupMember[]) {
    const { run, controller } = active;
    for (let i = 0; i < members.length; i++) {
      if (controller.signal.aborted) {
        run.state = "cancelled";
        return;
      }
      const step = run.steps[i];
      step.state = "waiting";
      const outcome = await this.runStep(active, members[i]);
      step.state = outcome.state;
      if (outcome.reason) step.reason = outcome.reason;
      if (outcome.state === "failed") {
        run.state = outcome.reason === "cancelled" ? "cancelled" : "failed";
        return;
      }
    }
    run.state = "succeeded";
  }

  private async runStep(active: ActiveRun, member: InstanceGroupMember): Promise<StepOutcome> {
    const { run, controller } = active;
    const { daemonId, instanceUuid } = member;
    const { signal } = controller;
    const isStart = run.action === "start";

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

      return await this.waitForTarget(active, member, stream, sendCommand);
    } finally {
      stream?.close();
    }
  }

  // Subscribe to the stream, send the command (re-authorising first), and wait
  // for the success condition, a failure event, the timeout, or cancellation.
  private waitForTarget(
    active: ActiveRun,
    member: InstanceGroupMember,
    stream: RunnerStream,
    sendCommand: boolean
  ): Promise<StepOutcome> {
    const { run, group, controller, operator } = active;
    const { daemonId, instanceUuid } = member;
    const { signal } = controller;
    const isStart = run.action === "start";
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
              this.deps.logOperation(run.action, {
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
            logger.warn(`Instance group: ${run.action} command failed for ${instanceUuid}:`, err);
            finish({ state: "failed", reason: "command_failed" });
          }
        );
    });
  }
}

function orderedMembers(group: InstanceGroup, action: RunAction): InstanceGroupMember[] {
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
