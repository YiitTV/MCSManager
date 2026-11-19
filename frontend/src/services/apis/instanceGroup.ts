// All HTTP endpoints of the instance groups feature live here, so a contract change is a
// single-file edit. Every endpoint is served by the panel under /api/instance_group.
import { useDefineApi } from "@/stores/useDefineApi";
import type { GroupRun, InstanceGroupInput, InstanceGroupView } from "@/types/instanceGroup";

export const listInstanceGroups = useDefineApi<unknown, InstanceGroupView[]>({
  url: "/api/instance_group/list",
  method: "GET"
});

export const createInstanceGroup = useDefineApi<
  {
    data: InstanceGroupInput;
  },
  InstanceGroupView
>({
  url: "/api/instance_group/create",
  method: "POST"
});

export const updateInstanceGroup = useDefineApi<
  {
    params: { id: string };
    data: Partial<InstanceGroupInput>;
  },
  InstanceGroupView
>({
  url: "/api/instance_group/update",
  method: "PUT"
});

export const deleteInstanceGroup = useDefineApi<
  {
    params: { id: string };
  },
  boolean
>({
  url: "/api/instance_group/delete",
  method: "DELETE"
});

// 409 while a run is active for the group, 429 when 8 runs are active on the panel.
export const startInstanceGroup = useDefineApi<
  {
    params: { id: string };
  },
  { runId: string }
>({
  url: "/api/instance_group/start",
  method: "POST"
});

export const stopInstanceGroup = useDefineApi<
  {
    params: { id: string };
  },
  { runId: string }
>({
  url: "/api/instance_group/stop",
  method: "POST"
});

export const cancelInstanceGroupRun = useDefineApi<
  {
    params: { id: string };
  },
  { run: GroupRun | null }
>({
  url: "/api/instance_group/cancel",
  method: "POST"
});

// State of the active or latest run, wrapped as { run: null } when the group has none.
export const getInstanceGroupRun = useDefineApi<
  {
    params: { id: string };
  },
  { run: GroupRun | null }
>({
  url: "/api/instance_group/run",
  method: "GET"
});
