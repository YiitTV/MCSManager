import { useDefineApi } from "@/stores/useDefineApi";

type Target = { params: { daemonId: string; uuid: string } };

export interface PlayerRoster {
  players: string[] | null;
  online: number | null;
  max: number | null;
  canManage: boolean;
}

export interface PlayerOperation {
  action: string;
  player: string;
  text?: string;
}

export type MaintenanceOperation =
  | { action: "toggle"; enabled: boolean }
  | { action: "add" | "remove"; player: string };

export type MaintenanceState = (
  | { status: "missing" | "unavailable" }
  | { status: "ready"; enabled: boolean; players: string[] | null }
) & { running: boolean; confirmed?: boolean };

export const getPlayerRoster = useDefineApi<Target, PlayerRoster>({
  url: "/api/minecraft/players",
  method: "GET"
});

export const submitPlayerAction = useDefineApi<
  Target & { data: PlayerOperation },
  { accepted: true }
>({
  url: "/api/minecraft/player_action",
  method: "POST"
});

export const getMaintenanceState = useDefineApi<Target, MaintenanceState>({
  url: "/api/minecraft/maintenance",
  method: "GET"
});

export const submitMaintenanceAction = useDefineApi<
  Target & { data: MaintenanceOperation },
  MaintenanceState
>({
  url: "/api/minecraft/maintenance",
  method: "POST"
});
