<script setup lang="ts">
import { useMiniConsoles } from "@/hooks/useMiniConsoles";
import { onBeforeUnmount, onMounted } from "vue";
import MiniConsole from "./MiniConsole.vue";

const { windows, close, closeAll, focus, toggleMinimise, moveTo, clampAll } = useMiniConsoles();

onMounted(() => window.addEventListener("resize", clampAll));

onBeforeUnmount(() => {
  window.removeEventListener("resize", clampAll);
  // Leaving the page closes every console, which disposes terminals and disconnects sockets.
  closeAll();
});
</script>

<template>
  <div class="mini-console-host" data-test="mini-console-host">
    <MiniConsole
      v-for="win in windows"
      :key="win.id"
      :win="win"
      @close="close(win.id)"
      @toggle-minimise="toggleMinimise(win.id)"
      @focus="focus(win.id)"
      @move="(x, y) => moveTo(win.id, x, y)"
    />
  </div>
</template>

<style lang="scss" scoped>
.mini-console-host {
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
}
</style>
