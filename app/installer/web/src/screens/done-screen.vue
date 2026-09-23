// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ⑤ 完成屏（peak-end）：绿勾描画（UDrawCheck）+ 独立激活入口 + 复制同位换位 + 部署摘要。
 * sealed（已封箱）→ 直指工作台登录；激活链接只出现这一次（一次性 setup token）。
 */
import { computed, ref } from 'vue';
import { UButton, UDrawCheck, UResultCard } from '@unself/ui';
import type { WizardResult } from '../lib/state-view';

const props = defineProps<{
  result: WizardResult | null;
  instancePath: string;
  modules: string[];
}>();

const copied = ref(false);

const sealed = computed(() => !props.result?.setupUrl);
const baseUrl = computed(() => props.result?.baseUrl ?? '');
/** 版本身份三项（#287）：服务端算好放 result，完成屏只负责展示（旧快照/无结果时空数组）。 */
const identity = computed(() => props.result?.identity ?? []);
const workspaceLink = computed(() => `${baseUrl.value.replace(/\/+$/, '')}/login`);
const activationLink = computed(() =>
  props.result?.setupUrl ? `${baseUrl.value}${props.result.setupUrl}` : baseUrl.value,
);

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(activationLink.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <section class="screen" data-screen="done">
    <div class="done-wrap">
      <UDrawCheck :size="64" />
      <h2>装配完成</h2>
      <UResultCard label="部署入口已就绪" :link="activationLink" data-test="activation-link">
        <template v-if="!sealed">
          <p class="sub">激活链接只出现这一次（一次性 setup token）。</p>
          <a class="btn-primary btn-big btn-link" :href="activationLink" target="_blank" rel="noreferrer noopener" data-test="open-activation">
            打开激活页
          </a>
          <a class="btn-secondary btn-big btn-link" :href="workspaceLink" target="_blank" rel="noreferrer noopener" data-test="open-workbench">
            打开工作台
          </a>
          <UButton
            variant="outline"
            data-test="copy-link"
            :class="{ copied }"
            :disabled="copied"
            @click="copyLink"
          >
            {{ copied ? '已复制 ✓' : '复制链接' }}
          </UButton>
        </template>
        <template v-else>
          <p class="sub">本实例已有管理员（已封箱）：直接去工作台登录。</p>
          <a class="btn-primary btn-big btn-link" :href="workspaceLink" target="_blank" rel="noreferrer noopener" data-test="open-login">
            打开工作台登录
          </a>
        </template>
      </UResultCard>
      <ul class="summary">
        <li><span class="k">实例目录</span><code>{{ instancePath }}</code></li>
        <li><span class="k">访问地址</span><code>{{ baseUrl }}</code></li>
        <li><span class="k">模块</span>{{ modules.join('、') }}</li>
      </ul>
      <!--
        版本身份三项（#287，决策 #80）：与 `unself --version` / `unself deploy` 同源。
        落在完成屏（而非只写部署日志）：日志会被本屏取代，报障要能在收尾屏整段复制。
        逐行 <code> 保留换行前的可复制形态（与终端输出一致）。
      -->
      <ul class="summary" data-test="build-identity">
        <li v-for="(line, i) in identity" :key="i"><code>{{ line }}</code></li>
      </ul>
      <p class="hint">任何时候重跑 <code>unself wizard</code> 都收敛同一终态（幂等）。</p>
    </div>
  </section>
</template>

