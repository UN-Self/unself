// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ② 域名屏：workers.dev 默认卡 ∥ 自有域卡。
 * 自有域按①凭证来源分流（walkthrough 定稿）：token = 「子域前缀 + zone 下拉」组合（预取清单，
 * 失败回退手填）；OAuth/null = 直接手填完整域名。多级子域 Total TLS 提示实时更新。
 * 提交后 reload 语义改为「拉取最新状态」事件（由根组件统一 goTo(step)），不在屏内跳路由。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { UButton, UChoiceCardGroup, UInput, UMotionSelect, type SelectOption } from '@unself/ui';
import { getJson, postJson } from '../lib/api';
import { domainProblem } from './domain-rules';
import type { WizardEnvHint, WizardStep } from '../lib/state-view';

const props = defineProps<{
  envHint: WizardEnvHint;
  credentialSource: 'oauth' | 'token' | null;
  domainChoice: 'workers' | 'custom' | null;
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const choice = ref<'workers' | 'custom'>(props.domainChoice === 'custom' ? 'custom' : 'workers');
const subPrefix = ref('');
const zone = ref<string | null>(null);
const fullDomain = ref('');
const problem = ref('');
const submitting = ref(false);

const tokenMode = computed(() => props.credentialSource === 'token');

const choiceOptions = computed(() => [
  {
    value: 'workers',
    title: 'workers.dev 免费域名',
    description: '零输入、零配置（推荐起步）。',
  },
  {
    value: 'custom',
    title: '自有域名',
    description: tokenMode.value ? '选你的 zone（自动发现），只填子域前缀。' : '直接输入完整域名（如 team.example.com）。',
  },
]);

/** zone 发现（② 屏载入即预取；失败/未接线 → 手填回退）。 */
const zoneState = ref<'idle' | 'loading' | 'ready' | 'manual'>('idle');
const zoneOptions = ref<SelectOption[]>([]);
const zoneNotice = ref('');

async function fetchZones(): Promise<void> {
  zoneState.value = 'loading';
  try {
    const r = await getJson<{ ok: boolean; zones: Array<{ id: string; name: string }>; message?: string }>('/api/zones');
    if (r.ok && r.zones.length > 0) {
      zoneOptions.value = r.zones.map((z) => ({ value: z.name, label: z.name }));
      zoneState.value = 'ready';
    } else {
      zoneNotice.value = r.ok ? '' : r.message ?? '';
      zoneState.value = 'manual';
    }
  } catch {
    zoneNotice.value = '网络错误：zone 列表拿不到。';
    zoneState.value = 'manual';
  }
}

/** 多级子域（Total TLS）提示：比所选 zone 深两层以上；OAuth 手填按段数 > 3 估（同旧脚本语义）。 */
const totalTlsWarn = computed(() => {
  const domain = currentDomain();
  if (!domain) return false;
  const base = zone.value ?? '';
  const depth = domain.split('.').filter(Boolean).length;
  return depth > (base ? base.split('.').length + 1 : 3);
});

function currentDomain(): string {
  if (choice.value !== 'custom') return '';
  if (tokenMode.value && zoneState.value === 'ready') {
    const prefix = subPrefix.value.trim();
    return prefix && zone.value ? `${prefix}.${zone.value}` : '';
  }
  return fullDomain.value.trim();
}

watch(choice, (next) => {
  if (next === 'custom') {
    if (tokenMode.value && zoneState.value === 'idle') void fetchZones();
    else if (!tokenMode.value) fullDomain.value = '';
  }
});

onMounted(() => {
  // token 路径② 屏载入即预取（用户点「自有域名」时多半已到，秒出下拉不转圈）
  if (tokenMode.value) void fetchZones();
});

async function submit(): Promise<void> {
  if (submitting.value) return;
  const domain = currentDomain();
  if (choice.value === 'custom') {
    // 前端预检同服务端 domainProblem（人话即时反馈；服务端仍守门）
    const problemText = domainProblem(domain);
    if (problemText) {
      problem.value = problemText;
      return;
    }
  }
  submitting.value = true;
  problem.value = '';
  try {
    const r = await postJson<{ step: WizardStep }>('/api/step2', { choice: choice.value, domain });
    if (r.ok) emit('advanced', r.data.step ?? 'modules');
    else problem.value = r.data.problem ?? '提交失败，请重试';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    submitting.value = false;
  }
}

const backTarget: WizardStep = 'auth';
const emit_ = emit;
void backTarget;
void emit_;
</script>

<template>
  <section class="screen" data-screen="domain">
    <h2>② 团队入口域名</h2>
    <p class="sub">部署后团队的登录与使用都从这个地址进；之后可加自有域。</p>
    <UChoiceCardGroup
      v-model="choice"
      mode="radio"
      name="dchoice"
      label="域名选择"
      :options="choiceOptions"
      class="zone-list"
    />
    <div v-if="choice === 'custom' && tokenMode" data-test="custom-area">
      <div v-if="zoneState === 'loading'" class="zone-list">
        <p class="hint">正在读取账户 zone…</p>
      </div>
      <div v-if="zoneState === 'ready'" class="zone-list" data-test="zone-pick">
        <p class="hint">选择你的 zone：</p>
        <div class="domain-combo">
          <UInput
            v-model="subPrefix"
            type="text"
            data-test="sub-prefix"
            placeholder="team"
            autocomplete="off"
            aria-label="子域前缀"
          />
          <span class="dot" aria-hidden="true">.</span>
          <UMotionSelect
            v-model="zone"
            :options="zoneOptions"
            label="域名"
            placeholder="选择域名"
          />
        </div>
        <p v-if="zoneNotice" class="warn">{{ zoneNotice }}</p>
      </div>
      <div v-if="zoneState === 'manual'" class="zone-list" data-test="zone-fallback">
        <p class="warn">
          zone 列表拿不到（token 缺 Zone·Read 或网络问题）{{ zoneNotice ? `：${zoneNotice}` : '' }}：请直接输入完整域名（如
          team.example.com）。
        </p>
        <UInput
          v-model="fullDomain"
          type="text"
          data-test="full-domain"
          label="完整域名"
          placeholder="team.example.com"
          autocomplete="off"
        />
      </div>
    </div>
    <div v-if="choice === 'custom' && !tokenMode" data-test="custom-area">
      <UInput
        v-model="fullDomain"
        type="text"
        data-test="full-domain"
        label="完整域名"
        placeholder="team.example.com"
        autocomplete="off"
      />
      <p class="hint">
        OAuth 不会自动建 DNS 记录：装配后按指引在 Cloudflare 控制台加一条 A 记录即可（或回①改用 API Token 全自动）。
      </p>
    </div>
    <p v-if="choice === 'custom' && totalTlsWarn" class="warn" data-test="total-tls-warn">
      多级子域（如 a.b.example.com）：Universal SSL 只盖一层，装配时会开 Total TLS{{ tokenMode ? '。' : '（OAuth 不覆盖，需 API Token）。' }}
    </p>
    <p class="err">{{ problem }}</p>
    <div class="actions">
      <button type="button" class="btn-back" data-test="back" @click="emit('advanced', 'auth')">← 上一步（凭证）</button>
      <UButton data-test="domain-submit" :loading="submitting" @click="submit">下一步</UButton>
    </div>
  </section>
</template>
