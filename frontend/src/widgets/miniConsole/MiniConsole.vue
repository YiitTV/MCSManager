<script setup lang="ts">
import ConsoleShortcuts from "@/components/ConsoleShortcuts.vue";
import {
  MINI_CONSOLE_HEIGHT,
  MINI_CONSOLE_SCROLLBACK,
  MINI_CONSOLE_TITLE_HEIGHT,
  type MiniConsoleWindow
} from "@/hooks/useMiniConsoles";
import { encodeConsoleColor, useTerminal } from "@/hooks/useTerminal";
import { t } from "@/lang/i18n";
import { getInstanceOutputLog } from "@/services/apis/instance";
import { getValidatorErrorMsg, reportErrorMsg } from "@/tools/validator";
import { INSTANCE_STATUS_CODE } from "@/types/const";
import { BorderOutlined, CloseOutlined, MinusOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref } from "vue";

const props = defineProps<{
  win: MiniConsoleWindow;
}>();

const emit = defineEmits<{
  close: [];
  toggleMinimise: [];
  focus: [];
  move: [x: number, y: number];
}>();

// The hook owns the socket and the xterm instance. Both are disposed when this component
// unmounts, which is what closing a window does.
const {
  state,
  events,
  isConnect,
  isRunning,
  isStopped,
  execute,
  initTerminalWindow,
  sendCommand,
  writeHistoryLog
} = useTerminal({ scrollback: MINI_CONSOLE_SCROLLBACK, renderer: "canvas", compact: true });

const bodyRef = ref<HTMLElement>();
const command = ref("");
// Set when the stream channel is refused (not assigned / forbidden) or the socket fails.
const errorText = ref("");

const statusClass = computed(() => {
  switch (state.value?.status) {
    case INSTANCE_STATUS_CODE.RUNNING:
      return "dot-running";
    case INSTANCE_STATUS_CODE.STARTING:
    case INSTANCE_STATUS_CODE.STOPPING:
      return "dot-busy";
    default:
      return "dot-stopped";
  }
});

const inputDisabled = computed(() => !isConnect.value || isStopped.value);
const inputPlaceholder = computed(() =>
  isStopped.value ? t("TXT_CODE_mini_console.stopped") : t("TXT_CODE_mini_console.inputPlaceholder")
);

const send = () => {
  const text = command.value.trim();
  if (!text || inputDisabled.value) return;
  try {
    sendCommand(text);
    command.value = "";
  } catch (error) {
    reportErrorMsg(error);
  }
};

events.on("connect", () => {
  errorText.value = "";
});
events.on("error", (error: Error) => {
  errorText.value = getValidatorErrorMsg(error, t("TXT_CODE_mini_console.connectFailed"));
});

// Show recent output first, then live output (same approach as the full terminal page).
events.once("detail", async () => {
  try {
    const { value } = await getInstanceOutputLog().execute({
      params: { uuid: props.win.instanceUuid, daemonId: props.win.daemonId }
    });
    if (!value) return;
    await writeHistoryLog(
      state.value?.config?.terminalOption?.haveColor ? encodeConsoleColor(value) : value
    );
  } catch {
    // History is optional; live output still works.
  }
});

onMounted(async () => {
  try {
    await execute({ instanceId: props.win.instanceUuid, daemonId: props.win.daemonId });
    // `execute` resolves without a socket if the window was closed in the meantime.
    if (bodyRef.value) initTerminalWindow(bodyRef.value);
  } catch (error) {
    // No output stream is opened when the panel refuses the stream channel.
    errorText.value = getValidatorErrorMsg(error, t("TXT_CODE_mini_console.openFailed"));
  }
});

// Dragging uses plain pointer events; the store clamps the position to the viewport.
let drag: { startX: number; startY: number; originX: number; originY: number } | undefined;

const onDragStart = (e: PointerEvent) => {
  if ((e.target as HTMLElement).closest("button")) return;
  drag = { startX: e.clientX, startY: e.clientY, originX: props.win.x, originY: props.win.y };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
};
const onDragMove = (e: PointerEvent) => {
  if (!drag) return;
  emit("move", drag.originX + e.clientX - drag.startX, drag.originY + e.clientY - drag.startY);
};
const onDragEnd = (e: PointerEvent) => {
  if (!drag) return;
  drag = undefined;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
};
</script>

<template>
  <section
    class="mini-console"
    :class="{ 'is-minimised': win.minimised }"
    :style="{
      left: `${win.x}px`,
      top: `${win.y}px`,
      zIndex: win.z,
      '--mini-title-height': `${MINI_CONSOLE_TITLE_HEIGHT}px`,
      '--mini-height': `${MINI_CONSOLE_HEIGHT}px`
    }"
    data-test="mini-console"
    @pointerdown="emit('focus')"
  >
    <header
      class="mini-title"
      data-test="mini-title"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
      @dblclick="emit('toggleMinimise')"
    >
      <span class="mini-dot" :class="statusClass" data-test="mini-dot" />
      <span class="mini-name" :title="win.title">{{ win.title }}</span>
      <button
        type="button"
        class="mini-btn"
        data-test="mini-minimise"
        :title="
          win.minimised ? t('TXT_CODE_mini_console.restore') : t('TXT_CODE_mini_console.minimise')
        "
        @click="emit('toggleMinimise')"
      >
        <BorderOutlined v-if="win.minimised" />
        <MinusOutlined v-else />
      </button>
      <button
        type="button"
        class="mini-btn"
        data-test="mini-close"
        :title="t('TXT_CODE_mini_console.close')"
        @click="emit('close')"
      >
        <CloseOutlined />
      </button>
    </header>

    <div v-show="!win.minimised" class="mini-content" data-test="mini-content">
      <div class="mini-terminal">
        <div ref="bodyRef" class="mini-terminal-body"></div>
        <div v-if="errorText && !isConnect" class="mini-error" data-test="mini-error">
          <strong>{{ t("TXT_CODE_mini_console.errorTitle") }}</strong>
          <span>{{ errorText }}</span>
        </div>
        <div v-else-if="!isConnect" class="mini-connecting" data-test="mini-connecting">
          {{ t("TXT_CODE_mini_console.connecting") }}
        </div>
      </div>
      <ConsoleShortcuts
        :daemon-id="win.daemonId"
        :instance-id="win.instanceUuid"
        :disabled="!isConnect || !isRunning"
      />
      <a-input
        v-model:value="command"
        size="small"
        class="mini-input"
        data-test="mini-input"
        :disabled="inputDisabled"
        :placeholder="inputPlaceholder"
        @press-enter="send"
      />
    </div>
  </section>
</template>

<style lang="scss" scoped>
.mini-console {
  position: fixed;
  width: min(440px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  background: var(--background-color-white);
  border: 1px solid var(--color-primary);
  box-shadow: 0 8px 24px var(--card-shadow-extend-color);
  pointer-events: auto;
}

.mini-title {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--mini-title-height);
  padding: 0 4px 0 12px;
  background: var(--app-header-bg-extend);
  color: var(--app-header-text-color);
  cursor: move;
  user-select: none;
  touch-action: none;
}

.mini-dot {
  flex: 0 0 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-gray-6);
}
.dot-running {
  background: var(--color-success);
}
.dot-busy {
  background: var(--color-primary);
}

.mini-name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini-btn {
  flex: 0 0 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;

  &:hover {
    color: var(--color-primary);
  }
}

.mini-content {
  display: flex;
  flex-direction: column;
  height: calc(var(--mini-height) - var(--mini-title-height));
}

.mini-terminal {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: #1e1e1e;
  padding: 4px 0 4px 6px;
}

.mini-terminal-body {
  height: 100%;
  overflow: hidden;
}

.mini-connecting,
.mini-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
  color: #d9d9d9;
  background: rgba(30, 30, 30, 0.88);
  word-break: break-word;
}

.mini-error strong {
  color: var(--color-danger);
}

.mini-input {
  flex: 0 0 auto;
  border-radius: 0;
}
</style>
