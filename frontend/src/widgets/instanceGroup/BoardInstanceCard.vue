<script setup lang="ts">
import { TYPE_MINECRAFT_VELOCITY } from "@/hooks/useInstance";
import type { BoardInstance } from "@/hooks/useInstanceBoardInventory";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import { INSTANCE_STATUS_CODE } from "@/types/const";
import Shortcut from "@/widgets/instance/Shortcut.vue";
import { CodeOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import MinecraftMaintenanceControl from "./MinecraftMaintenanceControl.vue";
import MinecraftPlayerPanel from "./MinecraftPlayerPanel.vue";

const props = defineProps<{
  card: LayoutCard;
  instance?: BoardInstance;
  isAdmin: boolean;
}>();

const instanceType = computed(() => props.instance?.detail.config?.type);
const isVelocity = computed(() => instanceType.value === TYPE_MINECRAFT_VELOCITY);
const isMinecraft = computed(() => {
  const type = instanceType.value;
  return (
    type === "minecraft/java" ||
    (type?.startsWith("minecraft/java/") &&
      !["minecraft/java/bungeecord", "minecraft/java/geyser", "minecraft/java/sponge"].includes(
        type
      ))
  );
});
const running = computed(() => props.instance?.detail.status === INSTANCE_STATUS_CODE.RUNNING);

const emit = defineEmits<{
  openInstance: [instance: BoardInstance];
  openConsole: [instance: BoardInstance];
  refresh: [instance: BoardInstance];
}>();
</script>

<template>
  <Shortcut
    v-if="instance"
    class="board-instance-card"
    :card="card"
    :target-daemon-id="instance.daemonId"
    :target-instance-info="instance.detail"
    :full-height="false"
    :hide-management-actions="!isAdmin"
    @click="emit('openInstance', instance)"
    @refresh-list="emit('refresh', instance)"
  >
    <template #extra-actions>
      <a-button size="small" data-test="btn-console" @click.stop="emit('openConsole', instance)">
        <template #icon><CodeOutlined /></template>
        {{ t("TXT_CODE_instance_group_ui.openConsole") }}
      </a-button>
      <MinecraftPlayerPanel v-if="isMinecraft && running" :target="instance" :running="running" />
      <MinecraftMaintenanceControl
        v-if="isAdmin && isVelocity"
        :target="instance"
        :running="running"
      />
    </template>
  </Shortcut>
  <div v-else class="member-unavailable" data-test="member-unavailable">
    {{ t("TXT_CODE_instance_group_ui.unavailable") }}
  </div>
</template>

<style scoped>
.board-instance-card {
  cursor: pointer;
}

.member-unavailable {
  border: 1px solid var(--card-border-color);
  padding: 12px;
  opacity: 0.6;
}
</style>
