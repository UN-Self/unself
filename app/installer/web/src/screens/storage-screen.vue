// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ③½ 存储屏（#55 数据四级）：逐模块 accepts 单选（单项 = 作者声明说明卡，非假单选）+
 * shared 知情同意。单项模块按唯一 accepts 提交（服务端 accepts 校验同过）。
 */
import { computed, ref } from 'vue';
import { UButton, UChoiceCardGroup } from '@unself/ui';
import { postJson } from '../lib/api';
import type { WizardStorageOption } from '../lib/state-view';
import type { WizardStep } from '../lib/state-view';

const props = defineProps<{
  storageOptions: WizardStorageOption[];
  storageChoices: Record<string, string>;
  sharedConsent: boolean;
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const choices = ref<Record<string, string>>({ ...props.storageChoices });
const consent = ref(props.sharedConsent);
const problem = ref('');
const submitting = ref(false);

const LEVEL_NOTE: Record<string, string> = {
  core: '经 Core API 代理（默认，推荐）',
  shared: '共享库自建表（需知情同意）',
  dedicated: '独立库（占账户配额）',
  external: '自备外部库（配置页填连接串）',
};

/** 作者声明理由（#309 ③½）：accepts 单项时按落点给通用人话。 */
const ONLY_NOTE: Record<string, string> = {
  core: '此模块的数据量小且无自建表需求，作者声明只支持经 Core API 代理存取。',
  shared: '此模块的表设计依赖共享库（跨表关联），作者声明只支持共享库自建表。',
  dedicated: '此模块的表未按共享库护栏设计（表名/外键），作者声明只能用独立库。',
  external: '此模块需要连接你自备的外部数据库，作者声明只支持外部库。',
};

/** 可选模块（accepts 多项 → 真单选组）。 */
const selectable = computed(() => props.storageOptions.filter((o) => o.accepts.length > 1));

/** 单项声明模块（accepts 单项 → 说明卡）。 */
const declaredOnly = computed(() => props.storageOptions.filter((o) => o.accepts.length === 1));

function initialChoice(opt: WizardStorageOption): string {
  return choices.value[opt.id] ?? opt.preferred ?? 'core';
}

function optionsOf(opt: WizardStorageOption) {
  return opt.accepts.map((level) => ({
    value: level,
    title: `${level}（${LEVEL_NOTE[level] ?? level}）`,
  }));
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  problem.value = '';
  try {
    const payload: Record<string, string> = { ...choices.value };
    // 单项声明模块取唯一 accepts 提交
    for (const opt of declaredOnly.value) payload[opt.id] = opt.accepts[0]!;
    const r = await postJson<{ step: WizardStep }>('/api/step3b', {
      choices: payload,
      sharedConsent: consent.value,
    });
    if (r.ok) emit('advanced', r.data.step ?? 'ready');
    else problem.value = r.data.problem ?? '提交失败，请重试';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="screen" data-screen="storage">
    <h2>③½ 数据存放</h2>
    <template v-if="storageOptions.length === 0">
      <p class="sub">本次选中的模块都走默认落点（core，经 Core API 代理），无需选择。</p>
    </template>
    <template v-else>
      <p class="sub">每模块四选一；声明之外的选项已被模块排除。</p>
      <fieldset v-for="opt in selectable" :key="opt.id" class="fold" :data-mod="opt.id" :data-accepts="opt.accepts.join(',')">
        <legend>{{ opt.id }}</legend>
        <UChoiceCardGroup
          :model-value="initialChoice(opt)"
          mode="radio"
          :name="`sto-${opt.id}`"
          :label="`模块 ${opt.id} 的数据落点`"
          :options="optionsOf(opt)"
          @update:model-value="(v) => (choices[opt.id] = v ?? 'core')"
        />
      </fieldset>
      <div v-for="opt in declaredOnly" :key="opt.id" class="fold" :data-mod="opt.id" :data-accepts="opt.accepts.join(',')">
        <p class="only-note">
          <strong>{{ opt.id }}</strong> —— 作者声明：只支持
          <strong>{{ opt.accepts[0] }}</strong>（{{ LEVEL_NOTE[opt.accepts[0]!] ?? opt.accepts[0] }}）。{{ ONLY_NOTE[opt.accepts[0]!] ?? '' }}
        </p>
      </div>
      <label v-if="storageOptions.some((o) => o.accepts.includes('shared'))" class="radio consent">
        <input v-model="consent" type="checkbox" data-test="shared-consent">
        该模块将在共享数据库中自建表：它将获得共享数据库的完整访问权（与其他模块零隔离）；表名以模块 id
        为前缀，禁止跨模块外键（三护栏由装配器硬校验）。
      </label>
    </template>
    <p class="err">{{ problem }}</p>
    <div class="actions">
      <button type="button" class="btn-back" data-test="back" @click="emit('advanced', 'modules')">← 上一步（模块）</button>
      <UButton data-test="storage-submit" :loading="submitting" @click="submit">确认并继续</UButton>
    </div>
  </section>
</template>
