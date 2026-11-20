<script setup lang="ts">
import { PLAYER_ACTIONS, useMinecraftPlayers } from "@/hooks/useMinecraftPlayers";
import { t } from "@/lang/i18n";
import type { GroupMemberRef } from "@/types/instanceGroup";
import { UserOutlined } from "@ant-design/icons-vue";

const props = defineProps<{ target: GroupMemberRef; running: boolean }>();
const {
  open,
  roster,
  loading,
  error,
  player,
  action,
  text,
  sending,
  asksForText,
  canSubmit,
  result,
  selectPlayer,
  submit
} = useMinecraftPlayers(
  () => props.target,
  () => props.running
);
</script>

<template>
  <a-button v-if="running" size="small" @click.stop="open = true">
    <template #icon><UserOutlined /></template>
    {{ t("TXT_CODE_minecraft_ops.players") }}
  </a-button>
  <a-modal v-model:open="open" :title="t('TXT_CODE_minecraft_ops.players')" :footer="null">
    <div class="player-panel" @click.stop>
      <a-alert
        v-if="!running || error"
        :message="t('TXT_CODE_minecraft_ops.unavailable')"
        type="warning"
      />
      <template v-else>
        <div>
          {{ t("TXT_CODE_minecraft_ops.online") }}
          <strong v-if="roster?.online != null">{{ roster.online }} / {{ roster.max }}</strong>
          <span v-else>{{ t("TXT_CODE_minecraft_ops.countUnavailable") }}</span>
        </div>
        <a-spin :spinning="loading">
          <div class="roster">
            <a-space v-if="roster?.players?.length" wrap>
              <template v-for="name in roster.players" :key="name">
                <a-button v-if="roster.canManage" size="small" @click="selectPlayer(name)">
                  {{ name }}
                </a-button>
                <a-tag v-else>{{ name }}</a-tag>
              </template>
            </a-space>
            <span v-else-if="roster?.players">{{ t("TXT_CODE_minecraft_ops.noPlayers") }}</span>
            <span v-else-if="!loading">{{ t("TXT_CODE_minecraft_ops.namesUnavailable") }}</span>
          </div>
        </a-spin>
        <a-alert
          v-if="roster && !roster.canManage"
          :message="t('TXT_CODE_minecraft_ops.proxyRoster')"
        />
        <a-form v-if="roster?.canManage" layout="vertical" @finish="submit">
          <a-form-item :label="t('TXT_CODE_minecraft_ops.playerName')">
            <a-input v-model:value="player" :maxlength="16" :disabled="sending" />
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_minecraft_ops.action')">
            <a-select v-model:value="action" :disabled="sending">
              <a-select-option v-for="option in PLAYER_ACTIONS" :key="option" :value="option">
                {{ t(`TXT_CODE_minecraft_ops.${option}`) }}
              </a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item
            v-if="asksForText"
            :label="
              t(
                action === 'tell'
                  ? 'TXT_CODE_minecraft_ops.privateMessage'
                  : 'TXT_CODE_minecraft_ops.reason'
              )
            "
          >
            <a-input v-model:value="text" :maxlength="160" :disabled="sending" />
          </a-form-item>
          <a-button type="primary" html-type="submit" :loading="sending" :disabled="!canSubmit">
            {{ t("TXT_CODE_minecraft_ops.send") }}
          </a-button>
        </a-form>
      </template>
      <a-alert
        v-if="result"
        :message="
          t(
            result === 'submitted'
              ? 'TXT_CODE_minecraft_ops.submitted'
              : 'TXT_CODE_minecraft_ops.actionFailed'
          )
        "
        :type="result === 'submitted' ? 'success' : 'error'"
        show-icon
      />
    </div>
  </a-modal>
</template>

<style scoped>
.player-panel {
  display: grid;
  gap: 12px;
}

.roster {
  max-height: 12rem;
  overflow: auto;
  padding: 4px;
}
</style>
