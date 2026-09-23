// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ④ 装配屏：确认行 + 资源名预览 + 撞车守卫勾选 + 活动摘要（默认折叠，
 * beUI agent-activity 语义：分组折叠 + 去重 + 失败组自动展开）+ 失败三要素卡。
 * 轮询 /api/state（800ms）驱动 done/failed 转移；防重复提交（部署中禁用 + 二次点击不重复 POST）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UActivity, UButton, UErrorCard, UResultCard, type ActivityGroup } from '@unself/ui';
import { getJson, postJson } from '../lib/api';
import { projectActivity, type WizardEventDto } from '../lib/activity-projection';
import type { WizardResourceName, WizardStep } from '../lib/state-view';

const props = defineProps<{
  domainChoice: 'workers' | 'custom' | null;
  domain: string;
  modules: string[];
  resourceNames: WizardResourceName[];
  step: WizardStep;
  error: { cause: string; owner: string; fix: string } | null;
  /** 已有事件（failed/done 后回到本屏时的历史）。 */
  events: WizardEventDto[];
  /** 部署入口（⑤）：baseUrl + setupUrl（failed 但已注册时也展示）。 */
  deploymentLink: string | null;
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const allowAdopt = ref(false);
const problem = ref('');
const starting = ref(false);
const activityOpen = ref(props.step === 'failed');

/** 活动数据：历史事件 + 轮询增量的合并去重全在 projectActivity（数据侧单一真源）。 */
const groups = ref<ActivityGroup[]>([]);
const seenTotals = computed(() => groups.value.reduce((acc, g) => acc + g.lines.length, 0));

function ingest(events: WizardEventDto[]): void {
  const next = projectActivity(events);
  // projectActivity 全量重算（按 i 去重）；失败组保持展开
  groups.value = next.map((g) => ({ ...g, state: g.state }));
  if (groups.value.some((g) => g.state === 'failed')) activityOpen.value = true;
}
ingest(props.events);

const deploying = computed(() => props.step === 'deploying');
const failed = computed(() => props.step === 'failed');
const summaryText = computed(() => {
  if (groups.value.length === 0) return '等待开始';
  return `${groups.value.length} 个步骤`;
});

let timer: ReturnType<typeof setInterval> | null = null;
async function poll(): Promise<void> {
  try {
    const s = await getJson<import('../lib/state-view').WizardStateDto>('/api/state');
    ingest(s.events);
    if (s.step === 'done' || s.step === 'failed') {
      stopPolling();
      emit('advanced', s.step);
    }
  } catch {
    /* 本地服务瞬时不可达：下一轮再试 */
  }
}
function stopPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
function startPolling(): void {
  if (timer) return;
  timer = setInterval(() => void poll(), 800);
}

watch(
  deploying,
  (now) => {
    if (now) startPolling();
    else stopPolling();
  },
  { immediate: true },
);
onBeforeUnmount(stopPolling);

async function start(): Promise<void> {
  if (starting.value || deploying.value) return; // 防重复提交：进行中二次点击不发请求
  starting.value = true;
  problem.value = '';
  try {
    const r = await postJson<{ step: WizardStep }>('/api/step4', { allowAdopt: allowAdopt.value });
    if (r.ok) emit('advanced', 'deploying');
    else problem.value = r.data.problem ?? '启动装配失败';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    starting.value = false;
  }
}

async function retry(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  try {
    const r = await postJson<{ step: WizardStep }>('/api/step4', { allowAdopt: allowAdopt.value });
    if (r.ok) emit('advanced', 'deploying');
    else problem.value = r.data.problem ?? '重跑失败';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    starting.value = false;
  }
}

const deploymentEventLink = computed(() => {
  for (const g of groups.value) {
    for (const line of g.lines) {
      const m = /一次性激活链接：\s*(https?:\/\/\S+)/.exec(line.text);
      if (m?.[1]) return m[1];
    }
  }
  return props.deploymentLink;
});
void seenTotals;
</script>

<template>
  <section class="screen" data-screen="deploy">
    <h2>④ 装配</h2>
    <p class="sub" data-test="confirm-line">
      域名：{{ domainChoice === 'custom' ? domain : 'workers.dev 免费域' }}；模块：{{ modules.join('、') }}
    </p>

    <details v-if="resourceNames.length > 0" class="fold res-fold" data-test="resource-names">
      <summary>本实例会占用的 Cloudflare 资源名（{{ resourceNames.length }} 项）</summary>
      <ul class="res-names">
        <li v-for="r in resourceNames" :key="r.name"><code>{{ r.name }}</code><span class="kind">{{ r.kind }}</span></li>
      </ul>
    </details>

    <UErrorCard
      v-if="failed && error"
      title="装配失败"
      :message="error.cause"
      :detail="`归属：${error.owner}；修复：${error.fix}`"
      retry-label="重跑（幂等，只补没完成的部分）"
      data-test="failed-card"
      @retry="retry"
    />

    <UResultCard
      v-if="failed && deploymentEventLink"
      label="入口已注册，可先继续"
      :link="deploymentEventLink"
      tone="warning"
      data-test="deployment-link-warning"
    >
      <a class="btn-big btn-link" :href="deploymentEventLink" target="_blank" rel="noreferrer noopener">打开激活页</a>
    </UResultCard>

    <label class="radio consent">
      <input v-model="allowAdopt" type="checkbox" data-test="allow-adopt">
      允许接管既有同名资源（撞车守卫放行，仅在确认这些资源确属本实例时勾选）
    </label>
    <p class="err">{{ problem }}</p>

    <div class="actions">
      <UButton
        data-test="deploy-start"
        size="lg"
        :loading="deploying"
        :disabled="deploying"
        @click="start"
      >
        {{ deploying ? '装配中…' : '开始装配（九步）' }}
      </UButton>
    </div>

    <UActivity
      v-model:open="activityOpen"
      :groups="groups"
      :summary="summaryText"
      data-test="activity"
    />
  </section>
</template>
