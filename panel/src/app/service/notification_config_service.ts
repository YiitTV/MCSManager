import Storage from "../common/storage/sys_storage";
import { cloneConfig, NotificationConfig } from "../entity/notification_config";

const CATEGORY = "NotificationConfig";
const ID = "config";

let current: NotificationConfig = new NotificationConfig();

// Load the persisted record (called once at panel start). A missing record means disabled.
export async function loadNotificationConfig() {
  const loaded = (await Storage.getStorage().load(
    CATEGORY,
    NotificationConfig,
    ID
  )) as NotificationConfig | null;
  current = loaded ?? new NotificationConfig();
  return current;
}

// Synchronous accessor used on the hot path; never null.
export function getNotificationConfig(): NotificationConfig {
  return current;
}

export async function saveNotificationConfig(config: NotificationConfig) {
  await Storage.getStorage().store(CATEGORY, ID, config);
  current = cloneConfig(config);
}

// Test hook: replace the in-memory config without touching storage.
export function setNotificationConfigForTest(config: NotificationConfig) {
  current = cloneConfig(config);
}
