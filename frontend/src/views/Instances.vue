<script setup lang="ts">
import { LayoutCardHeight } from "@/config/originLayoutConfig";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { LayoutCard } from "@/types";
import InstanceList from "@/widgets/InstanceList.vue";
import MiniConsoleHost from "@/widgets/miniConsole/MiniConsoleHost.vue";
import { useRoute } from "vue-router";
import LayoutContainer from "./LayoutContainer.vue";

const { isAdmin } = useAppStateStore();
const route = useRoute();
const assignedInstancesCard: LayoutCard = {
  id: "assigned-instances",
  title: t("TXT_CODE_e21473bc"),
  type: "InstanceList",
  meta: {},
  width: 12,
  height: LayoutCardHeight.AUTO
};
</script>

<template>
  <LayoutContainer v-if="isAdmin || route.path !== '/instances'" />
  <main v-else class="main-layout-container">
    <InstanceList :card="assignedInstancesCard" />
  </main>
  <Teleport v-if="route.path === '/instances'" to="body">
    <MiniConsoleHost />
  </Teleport>
</template>
