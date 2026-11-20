import { useDefineApi } from "@/stores/useDefineApi";
import type {
  BackupDestination,
  BackupDownloadTicket,
  BackupJobsResult,
  BackupPlan,
  BackupRecord,
  BackupTestResult
} from "@/types/backup";

// All endpoints of the instance-backups change live here (see openspec design "Panel HTTP API").

export type BackupInstanceParams = { daemonId: string; uuid: string };

export const listBackupDestinations = useDefineApi<Record<string, never>, BackupDestination[]>({
  url: "/api/backup/destinations",
  method: "GET"
});

export const createBackupDestination = useDefineApi<
  { data: Omit<BackupDestination, "id" | "createdAt" | "updatedAt"> },
  { id: string }
>({ url: "/api/backup/destinations", method: "POST" });

export const updateBackupDestination = useDefineApi<{ data: BackupDestination }, boolean>({
  url: "/api/backup/destinations",
  method: "PUT"
});

export const deleteBackupDestination = useDefineApi<{ data: { id: string } }, boolean>({
  url: "/api/backup/destinations",
  method: "DELETE"
});

export const testBackupDestination = useDefineApi<
  { data: { daemonId?: string; destination: Partial<BackupDestination> } },
  BackupTestResult
>({ url: "/api/backup/destinations/test", method: "POST" });

/** Returns the Google consent URL for an OAuth destination. */
export const getGDriveConnectUrl = useDefineApi<
  { params: { destinationId: string } },
  string | { url: string }
>({ url: "/api/backup/gdrive/connect", method: "GET" });

export const listBackupPlans = useDefineApi<{ params: BackupInstanceParams }, BackupPlan[]>({
  url: "/api/backup/plans",
  method: "GET"
});

export const createBackupPlan = useDefineApi<
  { data: Omit<BackupPlan, "id"> },
  { id: string } | BackupPlan
>({ url: "/api/backup/plans", method: "POST" });

export const updateBackupPlan = useDefineApi<{ data: BackupPlan }, boolean | BackupPlan>({
  url: "/api/backup/plans",
  method: "PUT"
});

export const deleteBackupPlan = useDefineApi<
  { data: { daemonId: string; uuid: string; planId: string } },
  boolean
>({ url: "/api/backup/plans", method: "DELETE" });

export const runBackup = useDefineApi<
  { data: { daemonId: string; uuid: string; planId: string } },
  { backupId: string }
>({ url: "/api/backup/run", method: "POST" });

export const listBackupRecords = useDefineApi<
  { params: BackupInstanceParams },
  BackupRecord[] | { records: BackupRecord[] }
>({ url: "/api/backup/records", method: "GET" });

export const cancelBackupJob = useDefineApi<
  { data: { daemonId: string; uuid: string; backupId: string } },
  boolean | { cancelled: boolean }
>({ url: "/api/backup/cancel", method: "POST" });

export const restoreBackup = useDefineApi<
  { data: { daemonId: string; uuid: string; recordId: string; source?: "gdrive" } },
  { jobId: string }
>({ url: "/api/backup/restore", method: "POST" });

export const requestBackupDownload = useDefineApi<
  { data: { daemonId: string; uuid: string; recordId: string } },
  BackupDownloadTicket
>({ url: "/api/backup/download", method: "POST" });

export const getBackupJobs = useDefineApi<{ params: BackupInstanceParams }, BackupJobsResult>({
  url: "/api/backup/jobs",
  method: "GET"
});
