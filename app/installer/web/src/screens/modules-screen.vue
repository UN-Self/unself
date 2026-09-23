// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ③ 模块屏：官方模块勾选卡 +「添加模块」高级折叠（安装串解析预览）。
 */
import { computed, ref } from 'vue';
import { UButton, UChoiceCardGroup, UInput } from '@unself/ui';
import { getJson, postJson } from '../lib/api';
import type { WizardStateDto } from '../lib/state-view';
import type { WizardModuleAddDto, WizardStep } from '../lib/state-view';

const props = defineProps<{
  modules: string[];
  moduleAdds: WizardModuleAddDto[];
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const selected = ref<string[]>([...props.modules]);
const problem = ref('');
const submitting = ref(false);

const officialOptions = computed(() => [
  {
    value: 'hello',
    title: 'hello',
    description: 'hello world 演示模块（SDK 存储计数器）——验证安装的最小闭环。',
  },
  {
    value: 'chat',
    title: 'chat',
    description: 'EdgeChat 频道聊天（dedicated 独立库；专属 D1/KV/DO）。',
  },
]);

const addedOptions = computed(() =>
  props.moduleAdds.map((m) => ({
    value: m.id,
    title: `${m.id}（来源模块）`,
    description: `${m.source} · v${m.version}`,
  })),
);

const allOptions = computed(() => [...officialOptions.value, ...addedOptions.value]);

/** 添加模块（高级折叠）：解析 → 预览进卡片；解析失败报人话。 */
const addOpen = ref(false);
const addSource = ref('');
const addProblem = ref('');
const adding = ref(false);

async function addModule(): Promise<void> {
  if (adding.value) return;
  adding.value = true;
  addProblem.value = '';
  try {
    const r = await postJson<{ step: WizardStep; id?: string }>('/api/step3/add', { source: addSource.value.trim() });
    if (r.ok) {
      addSource.value = '';
      // 添加成功 → 拉取最新清单并入本屏状态（服务端已 addModule；只补本屏视图）
      const fresh = await getJson<WizardStateDto>('/api/state');
      selected.value = [...fresh.modules];
      window.dispatchEvent(new CustomEvent('wizard:module-added'));
    } else {
      addProblem.value = r.data.problem ?? '添加失败，请重试';
    }
  } catch {
    addProblem.value = '网络错误：本地向导服务不可达';
  } finally {
    adding.value = false;
  }
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  problem.value = '';
  try {
    const r = await postJson<{ step: WizardStep }>('/api/step3', { modules: selected.value });
    if (r.ok) emit('advanced', r.data.step ?? 'storage');
    else problem.value = r.data.problem ?? '提交失败，请重试';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="screen" data-screen="modules">
    <h2>③ 启用模块</h2>
    <p class="sub">勾选要装的模块；官方模块已随安装器预装（部署零网络）。</p>
    <UChoiceCardGroup
      v-model:model-values="selected"
      mode="checkbox"
      label="模块选择"
      :options="allOptions"
      data-test="module-cards"
    />
    <div v-if="moduleAdds.length > 0" class="adds-title">
      <h3 class="adds-title">将要安装的模块</h3>
      <ul class="mod-adds">
        <li v-for="m in moduleAdds" :key="m.id" class="card mod-add" :data-mod="m.id">
          <strong>{{ m.id }}</strong> v{{ m.version }}
          <ul>
            <li>来源：<code>{{ m.source }}</code>（{{ m.kind }}）</li>
            <li>SRI：<code>{{ m.integrity ? m.integrity.slice(0, 24) + '…' : '（本地目录形态，无下载字节）' }}</code></li>
            <li>声明权限：{{ m.permissions.length > 0 ? m.permissions.join('、') : '（不声明任何需授权能力）' }}</li>
            <li>数据落点：accepts={{ m.storageAccepts.join('/') }}{{ m.storagePreferred ? `，preferred=${m.storagePreferred}` : '' }}</li>
          </ul>
        </li>
      </ul>
    </div>
    <details class="fold" :open="addOpen" @toggle="addOpen = ($event.target as HTMLDetailsElement).open">
      <summary>高级：添加模块（安装串）</summary>
      <form @submit.prevent="addModule">
        <UInput
          v-model="addSource"
          type="text"
          name="source"
          label="安装串"
          placeholder="npm:@acme/unself-todo@1.2.0 / github:acme/pkg#v1.0.0 / https://…/x.tgz / file:./modules/x"
        />
        <p class="err">{{ addProblem }}</p>
        <UButton type="submit" :loading="adding" data-test="module-add">添加模块</UButton>
      </form>
    </details>
    <p class="err">{{ problem }}</p>
    <div class="actions">
      <button type="button" class="btn-back" data-test="back" @click="emit('advanced', 'domain')">← 上一步（域名）</button>
      <UButton data-test="modules-submit" :loading="submitting" @click="submit">下一步</UButton>
    </div>
  </section>
</template>
