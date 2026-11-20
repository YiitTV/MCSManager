<script setup lang="ts">
import { useMinecraftMaintenance } from "@/hooks/useMinecraftMaintenance";
import { validMinecraftName } from "@/hooks/useMinecraftPlayers";
import { t } from "@/lang/i18n";
import type { GroupMemberRef } from "@/types/instanceGroup";

const props = defineProps<{ target: GroupMemberRef; running: boolean }>();
const { open, player, state, loading, saving, error, refresh, showAllowlist, submit } =
  useMinecraftMaintenance(
    () => props.target,
    () => props.running
  );

const setEnabled = (enabled: unknown) => {
  if (typeof enabled === "boolean") void submit({ action: "toggle", enabled });
};
</script>

<template>
  <div class="maintenance-control" @click.stop>
    <label v-if="state?.status === 'ready'" class="maintenance-toggle">
      <a-switch
        size="small"
        :checked="state.enabled"
        :loading="saving"
        :disabled="!state.running || loading"
        :aria-label="t('TXT_CODE_minecraft_ops.maintenance')"
        @change="setEnabled"
      />
      {{ t("TXT_CODE_minecraft_ops.maintenance") }}
    </label>
    <a-button v-if="state?.status === 'ready'" size="small" @click="showAllowlist">
      {{ t("TXT_CODE_minecraft_ops.allowedPlayers") }}
    </a-button>
    <span v-if="state?.status === 'missing'">{{ t("TXT_CODE_minecraft_ops.pluginMissing") }}</span>
    <a-button
      v-if="state?.status === 'unavailable' || error === 'unavailable'"
      size="small"
      :loading="loading"
      @click="refresh"
    >
      {{ t("TXT_CODE_minecraft_ops.maintenanceUnavailable") }}
    </a-button>
    <span v-if="!open && error === 'unconfirmed'" role="status">
      {{ t("TXT_CODE_minecraft_ops.unconfirmed") }}
    </span>
  </div>

  <a-modal v-model:open="open" :title="t('TXT_CODE_minecraft_ops.allowedPlayers')" :footer="null">
    <div @click.stop>
      <a-spin :spinning="loading">
        <template v-if="state?.status === 'ready' && state.players">
          <ul v-if="state.players.length" class="maintenance-players">
            <li v-for="name in state.players" :key="name">
              <span>{{ name }}</span>
              <a-button
                size="small"
                :disabled="!state.running || saving || loading"
                @click="submit({ action: 'remove', player: name })"
              >
                {{ t("TXT_CODE_minecraft_ops.remove") }}
              </a-button>
            </li>
          </ul>
          <p v-else>{{ t("TXT_CODE_minecraft_ops.noAllowedPlayers") }}</p>
          <a-form layout="vertical" @finish="submit({ action: 'add', player })">
            <a-form-item :label="t('TXT_CODE_minecraft_ops.playerName')">
              <a-input
                v-model:value="player"
                :maxlength="16"
                :disabled="saving || !state.running"
              />
            </a-form-item>
            <a-button
              type="primary"
              html-type="submit"
              :disabled="!validMinecraftName(player) || !state.running || saving || loading"
            >
              {{ t("TXT_CODE_minecraft_ops.add") }}
            </a-button>
          </a-form>
        </template>
        <p v-else-if="!loading">{{ t("TXT_CODE_minecraft_ops.namesUnavailable") }}</p>
      </a-spin>
      <a-alert
        v-if="error"
        class="maintenance-error"
        :message="t(`TXT_CODE_minecraft_ops.${error}`)"
        type="warning"
        show-icon
      />
    </div>
  </a-modal>
</template>

<style scoped>
.maintenance-control,
.maintenance-toggle {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.maintenance-players {
  max-height: 12rem;
  overflow: auto;
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}

.maintenance-players li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px;
}

.maintenance-error {
  margin-top: 12px;
}
</style>
