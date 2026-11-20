import {
  cancelBackupJob,
  getBackupJobs,
  listBackupPlans,
  listBackupRecords,
  requestBackupDownload,
  restoreBackup,
  runBackup
} from "@/services/apis/backup";
import { mapDaemonAddress, parseForwardAddress, type RemoteMappingEntry } from "@/tools/protocol";
import {
  BACKUP_NOW_RATE_LIMIT_MS,
  type BackupDownloadTicket,
  type BackupJobStatus,
  type BackupPlan,
  type BackupRecord,
  type BackupRestoreResult
} from "@/types/backup";
import { computed, onBeforeUnmount, ref } from "vue";

export const BACKUP_POLL_INTERVAL_MS = 3000;

export function buildBackupDownloadUrl(ticket: BackupDownloadTicket): string {
  if (ticket.url) return ticket.url;
  let rawAddr = ticket.addr;
  if (ticket.remoteMappings) {
    const mapped = mapDaemonAddress(ticket.remoteMappings as RemoteMappingEntry[]);
    if (mapped) rawAddr = mapped.addr + mapped.prefix;
  }
  const addr = parseForwardAddress(rawAddr, "http");
  return `${addr}/download/${ticket.password}/${encodeURIComponent(ticket.fileName)}`;
}

/** Backups of one instance: records, plans, jobs (polled only while a job is active). */
export function useBackups(daemonId: string, uuid: string, now: () => number = Date.now) {
  const records = ref<BackupRecord[]>([]);
  const plans = ref<BackupPlan[]>([]);
  const running = ref<BackupJobStatus>();
  const queued = ref<BackupJobStatus[]>([]);
  const loading = ref(false);
  const latestRestore = ref<BackupRestoreResult>();
  const restoreSubmitting = ref(false);
  /** Per plan id: epoch ms until which "Backup now" is rate limited. */
  const cooldownUntil = ref<Record<string, number>>({});
  const nowTick = ref(now());

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const jobsController = new AbortController();
  let jobsRequest: Promise<void> | undefined;

  const jobActive = computed(
    () => restoreSubmitting.value || !!running.value || queued.value.length > 0
  );
  const restoreActive = computed(
    () =>
      restoreSubmitting.value ||
      running.value?.kind === "restore" ||
      queued.value.some((job) => job.kind === "restore")
  );
  const params = { daemonId, uuid };

  const loadRecords = async () => {
    const { execute } = listBackupRecords();
    const res = await execute({ params });
    const value = res.value;
    records.value = (Array.isArray(value) ? value : value?.records ?? []).slice();
    records.value.sort((a, b) => b.createdAt - a.createdAt);
  };

  const loadPlans = async () => {
    const { execute } = listBackupPlans();
    const res = await execute({ params });
    plans.value = res.value ?? [];
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const loadJobs = async () => {
    const { execute } = getBackupJobs();
    const res = await execute({
      params,
      forceRequest: true,
      signal: jobsController.signal,
      timeout: 30_000
    });
    if (disposed) return;
    const wasActive = jobActive.value;
    latestRestore.value = res.value?.latestRestore;
    running.value = res.value?.running;
    queued.value = res.value?.queued ?? [];
    if (jobActive.value) {
      startPolling();
    } else {
      stopPolling();
      // A job just finished: its record is now in the list.
      if (wasActive) await loadRecords();
    }
  };

  function refreshJobs() {
    jobsRequest ??= loadJobs().finally(() => {
      jobsRequest = undefined;
    });
    return jobsRequest;
  }

  function startPolling() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(() => {
      refreshJobs().catch((e) => {
        if (!disposed) console.error("backup jobs poll failed:", e);
      });
    }, BACKUP_POLL_INTERVAL_MS);
  }

  const refreshAll = async () => {
    loading.value = true;
    try {
      await Promise.all([loadRecords(), loadPlans(), refreshJobs()]);
    } finally {
      loading.value = false;
    }
  };

  const startTick = () => {
    if (tickTimer || disposed) return;
    tickTimer = setInterval(() => {
      nowTick.value = now();
      const hasCooldown = Object.values(cooldownUntil.value).some((t) => t > nowTick.value);
      if (!hasCooldown && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = undefined;
      }
    }, 1000);
  };

  const cooldownSeconds = (planId: string) => {
    const until = cooldownUntil.value[planId] ?? 0;
    return Math.max(0, Math.ceil((until - nowTick.value) / 1000));
  };

  const runNow = async (planId: string, rateLimited: boolean) => {
    const { execute } = runBackup();
    await execute({ data: { ...params, planId } });
    if (rateLimited) {
      nowTick.value = now();
      cooldownUntil.value = {
        ...cooldownUntil.value,
        [planId]: nowTick.value + BACKUP_NOW_RATE_LIMIT_MS
      };
      startTick();
    }
    await refreshJobs();
  };

  const cancel = async (backupId: string) => {
    const { execute } = cancelBackupJob();
    await execute({ data: { ...params, backupId } });
    await refreshJobs();
  };

  const restore = async (recordId: string, source?: "gdrive") => {
    const { execute } = restoreBackup();
    restoreSubmitting.value = true;
    try {
      await execute({ data: { ...params, recordId, ...(source ? { source } : {}) } });
    } finally {
      restoreSubmitting.value = false;
    }
    // A status request already in flight may have seen the queue before submission.
    await jobsRequest?.catch(() => undefined);
    startPolling();
    await refreshJobs().catch((e) => console.error("restore status request failed:", e));
  };

  /** Returns the single-use download URL of the local copy. */
  const getDownloadUrl = async (recordId: string) => {
    const { execute } = requestBackupDownload();
    const res = await execute({ data: { ...params, recordId } });
    if (!res.value) throw new Error("No download ticket");
    return buildBackupDownloadUrl(res.value);
  };

  const dispose = () => {
    disposed = true;
    jobsController.abort();
    stopPolling();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = undefined;
  };
  onBeforeUnmount(dispose);

  return {
    records,
    plans,
    running,
    queued,
    loading,
    jobActive,
    restoreActive,
    latestRestore,
    cooldownSeconds,
    loadRecords,
    loadPlans,
    refreshJobs,
    refreshAll,
    runNow,
    cancel,
    restore,
    getDownloadUrl,
    dispose
  };
}
