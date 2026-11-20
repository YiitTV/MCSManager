import { isMonitoringId } from "mcsmanager-common";
import { $t } from "../i18n";
import { instanceMonitoring } from "../service/instance_monitoring";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

const endpoint = "instance/monitoring";

routerApp.on(endpoint, (ctx, data) => {
  const { instanceUuid, compact } = data ?? {};
  if (!isMonitoringId(instanceUuid) || typeof compact !== "boolean") {
    protocol.error(ctx, endpoint, { err: $t("TXT_CODE_instance_monitoring.invalidRequest") });
    return;
  }
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  if (!instance || InstanceSubsystem.isGlobalInstance(instance)) {
    protocol.error(ctx, endpoint, { err: $t("TXT_CODE_3bfb9e04") });
    return;
  }
  protocol.msg(ctx, endpoint, instanceMonitoring.read(instance, compact));
});
