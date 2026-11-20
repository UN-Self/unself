<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, toRef } from 'vue'
import { UErrorCard, USkeleton } from '@unself/ui'

import type { RegistryModule } from './lib/registry-api'
import { isDisabledFrameError, useModuleFrame } from './lib/use-module-frame'

/**
 * 模块 iframe 宿主（#83 壳拆分）：
 * 只管装载生命周期视图——握手骨架 / 异常卡 / iframe（key 重挂），
 * 行为状态机在 useModuleFrame；样式只用 tokens。
 */
const props = defineProps<{ module: RegistryModule | null }>()

const { frameState, frameError, frameSrc, frameKey, frameEl, retryFrame } = useModuleFrame(
  toRef(props, 'module'),
)

/** iframe 模板 ref（函数式绑定：noUnusedLocals 下模板字符串 ref 不计入使用）。 */
function onFrameEl(el: unknown) {
  frameEl.value = el as HTMLIFrameElement | null
}

/** 停用判定唯一真值：token 接口 403（#83，禁 message.includes 字符串嗅探）。 */
const errorTitle = computed(() =>
  isDisabledFrameError(frameError.value) ? '此模块已停用' : '模块加载失败',
)
</script>

<template>
  <div class="mh-frame-wrap">
    <!-- 加载中骨架（握手期间，15s 超时转到失败卡） -->
    <div v-if="frameState === 'handshaking'" class="mh-frame-skeleton" aria-busy="true">
      <USkeleton class="mh-frame-skeleton-lines" />
      <p class="mh-frame-skeleton-hint">正在连接模块…</p>
    </div>

    <!-- 模块异常卡（停用/失败/超时/配置无效，§6.5 成员只见人话+request id） -->
    <div v-if="frameState === 'failed'" class="mh-frame-error">
      <UErrorCard
        class="mh-error-card"
        data-test="module-error-card"
        :title="errorTitle"
        :message="frameError?.message"
        :request-id="frameError && 'requestId' in frameError ? frameError.requestId : undefined"
        :detail="frameError && 'detail' in frameError ? frameError.detail : undefined"
        retry-label="重新加载"
        @retry="retryFrame"
      />
    </div>

    <!--
      不带 sandbox：同域路径制下模块是壳的第一方页面，sandbox 必须显式放行同源才可运行，
      而「不带 allow-same-origin」的沙箱会让模块文档成为不透明源（origin 值为 "null"），
      后果有三——加载 SDK 的 ESM 脚本无 CORS 头即失败、桥收不到 ready、origin 校验恒不相等
      （#349 部署实测：任何模块握手 15s 必超时）。隔离边界由服务端承担：
      CSP frame-ancestors 收窄嵌套面、会话 cookie HttpOnly + SameSite=Lax（模块 JS 读不到值）、
      /api/admin/* 另需服务端防线（#349 后续项）。
    -->
    <iframe
      v-if="frameSrc"
      :ref="onFrameEl"
      :key="frameKey"
      :src="frameSrc"
      class="mh-frame"
      :title="`模块：${props.module?.id ?? ''}`"
      :class="{ 'mh-frame-hidden': frameState !== 'ready' }"
    />
  </div>
</template>

<style scoped>
.mh-frame-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}
.mh-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
/* 握手成功前隐藏，避免空白闪屏（已布置在骨架之下，占位不闪动） */
.mh-frame-hidden {
  visibility: hidden;
  position: absolute;
  inset: 0;
}
.mh-frame-skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: var(--unself-space-3);
  background: var(--unself-color-bg);
}
.mh-frame-skeleton-lines {
  width: min(320px, 80%);
}
.mh-frame-skeleton-hint {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
}
.mh-frame-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-6);
  background: var(--unself-color-bg);
}
.mh-error-card {
  max-width: 440px;
}
</style>
