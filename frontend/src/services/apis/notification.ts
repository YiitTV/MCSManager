import { useDefineApi } from "@/stores/useDefineApi";

// Contract: openspec/changes/discord-notifications/design.md sections 5-8 (admin only).

/** Placeholder the backend returns instead of stored secrets and expects back unchanged. */
export const NOTIFICATION_SECRET_PLACEHOLDER = "__MCSM_SECRET_DATA__";

export type NotificationSinkType = "bot_http" | "discord_webhook";

/** Event catalogue is defined by the server; the UI renders one toggle per key present. */
export type NotificationEventType = string;

export interface NotificationLastDelivery {
  at: number;
  type: string;
  ok: boolean;
  error?: string;
  httpStatus?: number;
}

export interface NotificationStatus {
  queued: number;
  sent: number;
  failed: number;
  dropped: number;
  last?: NotificationLastDelivery;
}

export interface NotificationConfig {
  enabled: boolean;
  sinkType: NotificationSinkType;
  url: string;
  secret: string;
  allowPrivateAddress: boolean;
  panelName: string;
  events: Record<NotificationEventType, boolean>;
  /** "<daemonId>::<instanceUuid>", at most 200 */
  excludedInstances: string[];
}

export interface NotificationConfigResponse extends NotificationConfig {
  status: NotificationStatus;
}

export interface NotificationTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export const getNotificationConfig = useDefineApi<unknown, NotificationConfigResponse>({
  url: "/api/notification/config",
  method: "GET"
});

export const putNotificationConfig = useDefineApi<
  { data: Partial<NotificationConfig> },
  NotificationConfigResponse
>({
  url: "/api/notification/config",
  method: "PUT"
});

export const rotateNotificationSecret = useDefineApi<unknown, { secret: string }>({
  url: "/api/notification/secret/rotate",
  method: "POST"
});

export const testNotification = useDefineApi<unknown, NotificationTestResult>({
  url: "/api/notification/test",
  method: "POST"
});
