// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ① 凭证屏：envToken/OAuth 提示 + API Token 折叠页（深链接 + 掩码输入）。
 * 唯一按钮在底部 actions：空值 = OAuth/env 直跑；输入后文案切「使用 token 下一步」。
 */
import { computed, ref } from 'vue';
import { UButton, UInput } from '@unself/ui';
import { postJson } from '../lib/api';
import type { WizardEnvHint, WizardStep } from '../lib/state-view';

const props = defineProps<{
  envHint: WizardEnvHint;
  /** 服务端 token 深链接（buildTokenDeepLink 输出，经 /api/state 下发）。 */
  tokenDeepLink: string;
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const token = ref('');
const problem = ref('');
const submitting = ref(false);

/** 输入非空 → 按钮文案切换（保留 #309① 走查定稿语义）。 */
const submitLabel = computed(() => (token.value.trim() ? '使用 token 下一步' : '下一步'));

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  problem.value = '';
  try {
    const r = await postJson<{ step: WizardStep }>('/api/step1', { token: token.value });
    if (r.ok) emit('advanced', r.data.step ?? 'domain');
    else problem.value = r.data.problem ?? '提交失败，请重试';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    submitting.value = false;
  }
}

const showMaskHint = computed(() => props.envHint.ci || !props.envHint.oauthUsable || props.envHint.needsTotalTls);
const foldOpen = ref(showMaskHint.value);

const foldTitle = computed(() =>
  props.envHint.needsTotalTls
    ? '多级子域需要 Total TLS：OAuth 不覆盖，需 API Token'
    : '使用 API Token',
);

const guidance = computed(() => {
  if (props.envHint.ci) return 'CI/无浏览器环境：创建 API Token 粘贴到下方（已设 CLOUDFLARE_API_TOKEN 则本步可跳过）。';
  if (!props.envHint.oauthUsable) return '没有可借用的 wrangler OAuth：创建 API Token 粘贴到下方。';
  return '也可以点开下方 API Token 入口创建并粘贴。';
});
</script>

<template>
  <section class="screen" data-screen="auth">
    <h2>① Cloudflare 凭证</h2>
    <p v-if="envHint.hasEnvToken" class="ok">已检测到环境变量 CLOUDFLARE_API_TOKEN——下一步时自动使用，无需粘贴。</p>
    <p v-else class="sub">{{ guidance }}</p>
    <div v-if="envHint.oauthUsable && !envHint.ci" class="oauth-card">
      <p class="ok-line">✓ 已检测到本机 Cloudflare 授权</p>
      <p class="sub">
        检测到本机 wrangler OAuth：什么都不用填，直接点下面「下一步」即可（官方支持「for use with other tools and
        scripts」）。想改用 API Token 就展开下方折叠页粘贴，按钮会变成「使用 token 下一步」。
      </p>
    </div>
    <form @submit.prevent="submit">
      <details class="fold" :open="foldOpen" @toggle="foldOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ foldTitle }}</summary>
        <p>
          <a :href="tokenDeepLink" target="_blank" rel="noreferrer noopener">
            打开 Cloudflare 创建 API Token（权限已预选，登入后点两次即得）
          </a>
        </p>
        <p class="hint">
          预选权限：Account（Workers Scripts/D1/R2/KV Storage Edit）+ Zone（Workers Routes/DNS/SSL
          Edit）；创建后整段复制粘贴到下面密码框（掩码输入，不落盘）。改过旧 token 权限的，CF 会重新发串，旧串作废，粘新串。
        </p>
        <UInput
          v-model="token"
          type="password"
          name="token"
          autocomplete="off"
          placeholder="粘贴 API Token"
          :error="problem || false"
          reserve-error-line
        />
      </details>
      <p class="err">{{ problem }}</p>
      <div class="actions">
        <UButton type="submit" :loading="submitting" data-test="auth-submit">{{ submitLabel }}</UButton>
      </div>
    </form>
  </section>
</template>
