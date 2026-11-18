<script setup lang="ts">
import type { LayoutCard } from "@/types";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import LoginCard from "@/widgets/LoginCard.vue";
import { useScreen } from "../hooks/useScreen";
import LayoutContainer from "./LayoutContainer.vue";

defineProps<{
  card: LayoutCard;
}>();

const { isPhone } = useScreen();
const { hasBgImage } = useAppConfigStore();

const skeletonConfigs = [
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 6, rows: 4 },
  { span: 24, rows: 9 },
  { span: 8, rows: 6 },
  { span: 16, rows: 6 },
  { span: 8, rows: 6 },
  { span: 16, rows: 6 }
];
</script>

<template>
  <div v-if="!isPhone">
    <div class="main-layout-container">
      <a-row :gutter="[24, 24]">
        <a-col v-for="(config, index) in skeletonConfigs" :key="index" :span="config.span">
          <CardPanel>
            <template #body>
              <a-skeleton :paragraph="{ rows: config.rows }" />
            </template>
          </CardPanel>
        </a-col>
      </a-row>
    </div>
    <div :class="{ 'login-page-container': true, 'minefield-pattern': !hasBgImage }">
      <div class="login-page-body">
        <LayoutContainer></LayoutContainer>
      </div>
    </div>
  </div>
  <div v-else>
    <LoginCard></LoginCard>
  </div>
</template>

<style></style>

<style lang="scss">
@keyframes scaleAnimation {
  0% {
    transform: scale(1);
  }
  20% {
    transform: scale(0.9);
    opacity: 1;
  }
  100% {
    transform: scale(1.6);
    opacity: 0;
  }
}

// Faint minefield pattern (mine dot + X mark); skipped when a custom background image is set.
.login-page-container.minefield-pattern {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Cg fill='none' stroke='%23ff9500' stroke-width='2' opacity='.08'%3E%3Cpath d='M34 34l12 12M46 34L34 46'/%3E%3C/g%3E%3Ccircle cx='0' cy='0' r='3' fill='%233b4466' opacity='.15'/%3E%3Ccircle cx='80' cy='0' r='3' fill='%233b4466' opacity='.15'/%3E%3Ccircle cx='0' cy='80' r='3' fill='%233b4466' opacity='.15'/%3E%3Ccircle cx='80' cy='80' r='3' fill='%233b4466' opacity='.15'/%3E%3C/svg%3E");
  background-size: 80px 80px;
}

.login-page-container {
  position: fixed;
  left: 0px;
  right: 0px;
  bottom: 0px;
  top: 0px;

  background-color: #29292957;
  backdrop-filter: saturate(120%) blur(10px);
  transition: all 0.8s;
  overflow-y: auto;
  overflow-x: hidden;

  .login-page-body {
    padding: 12px;
    padding-top: 84px;
    max-width: 1260px !important;
    margin: 0 auto;
    height: 100%;
    position: relative;
    .main-flex-center {
      margin-top: 0 !important;
      position: absolute;
      left: 0px;
      right: 0px;
      bottom: 0px;
      top: 0px;
      display: flex;
      justify-content: center;
      align-items: center;
      text-align: left !important;
    }
  }
}
</style>
