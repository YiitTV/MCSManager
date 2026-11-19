import { setAllLayoutConfig } from "@/config/originLayoutConfig";
import { getLayoutConfig } from "./apis/layout";
import { t } from "@/lang/i18n";

/** Older stored layouts have no backups page; add the default card so the route always renders. */
export function ensureBackupsPageLayout(cfg: any[]) {
  if (cfg.some((v: any) => v.page === "/instances/backups")) return;
  cfg.push({
    page: "/instances/backups",
    items: [
      {
        id: "backups-card-default",
        meta: {},
        type: "InstanceBackups",
        title: t("TXT_CODE_backup_ui.pageTitle"),
        width: 12,
        height: "unset",
        disableDelete: true
      }
    ]
  });
}

export async function initLayoutConfig() {
  const { value } = await getLayoutConfig().execute();
  try {
    const cfg = JSON.parse(value!);
    if (cfg instanceof Array) {
      ensureBackupsPageLayout(cfg);
      setAllLayoutConfig(cfg);
      const settingsConfig = cfg.find((v: any) => v.page === "__settings__");
      document.title = settingsConfig?.theme?.pageTitle || t("TXT_CODE_47ae8ee6");
    }
  } catch (error: any) {
    console.error("init layout config error:", error);
  }
}
