<script setup lang="ts">
import {
  CONSOLE_SHORTCUT_SUGGESTIONS,
  MAX_CONSOLE_SHORTCUTS,
  useConsoleShortcuts
} from "@/hooks/useConsoleShortcuts";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";

const props = defineProps<{ daemonId: string; instanceId: string; disabled?: boolean }>();
const { isAdmin } = useAppStateStore();
const {
  shortcuts,
  draft,
  editing,
  loading,
  saving,
  running,
  canSave,
  openEditor,
  addShortcut,
  save,
  run
} = useConsoleShortcuts(() => ({ daemonId: props.daemonId, uuid: props.instanceId }));
</script>

<template>
  <div v-if="shortcuts.length || isAdmin" class="shortcut-bar">
    <a-button
      v-for="shortcut in shortcuts"
      :key="shortcut.id"
      size="small"
      :title="shortcut.command"
      :disabled="disabled || (running != null && running !== shortcut.id)"
      :loading="running === shortcut.id"
      @click="run(shortcut.id)"
    >
      {{ shortcut.name }}
    </a-button>
    <a-button v-if="isAdmin" size="small" :loading="loading" @click="openEditor">
      {{ t("TXT_CODE_console_shortcuts.edit") }}
    </a-button>
  </div>
  <a-modal
    v-if="isAdmin"
    v-model:open="editing"
    :title="t('TXT_CODE_console_shortcuts.edit')"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: !canSave }"
    :ok-text="t('TXT_CODE_instance_group_ui.save')"
    :cancel-text="t('TXT_CODE_instance_group_ui.cancelEdit')"
    @ok="save"
  >
    <a-space wrap>
      <a-button
        v-for="suggestion in CONSOLE_SHORTCUT_SUGGESTIONS"
        :key="suggestion.name"
        size="small"
        :disabled="saving || draft.length >= MAX_CONSOLE_SHORTCUTS"
        @click="addShortcut(suggestion)"
      >
        {{ suggestion.name }}
      </a-button>
      <a-button
        size="small"
        :disabled="saving || draft.length >= MAX_CONSOLE_SHORTCUTS"
        @click="addShortcut()"
      >
        {{ t("TXT_CODE_console_shortcuts.add") }}
      </a-button>
    </a-space>
    <div class="shortcut-editor">
      <div v-for="(shortcut, index) in draft" :key="index" class="shortcut-row">
        <a-input
          v-model:value="shortcut.name"
          :placeholder="t('TXT_CODE_console_shortcuts.name')"
          :aria-label="t('TXT_CODE_console_shortcuts.name')"
          :maxlength="40"
          :disabled="saving"
        />
        <a-input
          v-model:value="shortcut.command"
          :placeholder="t('TXT_CODE_console_shortcuts.command')"
          :aria-label="t('TXT_CODE_console_shortcuts.command')"
          :maxlength="200"
          :disabled="saving"
        />
        <a-button danger :disabled="saving" @click="draft.splice(index, 1)">
          {{ t("TXT_CODE_console_shortcuts.remove") }}
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.shortcut-bar {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 4px;
}
.shortcut-bar > * {
  flex: 0 0 auto;
}
.shortcut-editor {
  max-height: 50vh;
  overflow-y: auto;
}
.shortcut-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
  gap: 6px;
  margin-top: 8px;
}
</style>
