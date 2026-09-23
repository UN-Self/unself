// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * ③★ 单模块配置页（#307 每模块一页，manifest.config 声明驱动）：
 * secret→掩码；enum→单选卡；boolean→勾选；number/url→类型输入；json→textarea+预检；
 * test:'http' 出「测试连接」（服务端代理验证）。保存 = step3c + finish（最后一页）。
 */
import { reactive, ref } from 'vue';
import { UButton, UChoiceCardGroup, UInput } from '@unself/ui';
import { postJson } from '../lib/api';
import type { WizardConfigField, WizardModuleConfig } from '../lib/state-view';
import type { WizardStep } from '../lib/state-view';

const props = defineProps<{
  config: WizardModuleConfig;
  saved: Record<string, string>;
  /** 是否最后一个配置页（决定保存后是否发 finish）。 */
  isLast: boolean;
}>();

const emit = defineEmits<{ advanced: [step: WizardStep] }>();

const values = reactive<Record<string, string>>({});
for (const f of props.config.fields) {
  values[f.key] = props.saved[f.key] ?? f.default ?? '';
}

const problem = ref('');
const saving = ref(false);
const testing = reactive<Record<string, { busy: boolean; message: string; ok: boolean }>>({});

function fieldRequired(f: WizardConfigField): boolean {
  return f.required === true;
}

/** json/url 预检（提交前；服务端状态机仍守门）。 */
function precheck(): string | null {
  for (const f of props.config.fields) {
    const raw = (values[f.key] ?? '').trim();
    if (f.type === 'json' && raw) {
      try {
        JSON.parse(raw);
      } catch (err) {
        return `「${f.label}」不是合法 JSON：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (f.type === 'url' && raw && !/^https?:\/\//.test(raw)) {
      return `「${f.label}」要以 http(s):// 开头`;
    }
  }
  return null;
}

async function testConnection(f: WizardConfigField): Promise<void> {
  const url = (values[f.key] ?? '').trim();
  const state = (testing[f.key] ??= { busy: false, message: '', ok: false });
  if (!/^https?:\/\//.test(url)) {
    state.message = '先填一个 http(s) 地址';
    state.ok = false;
    return;
  }
  state.busy = true;
  state.message = '测试中…';
  try {
    const r = await postJson<{ ok: boolean; message: string }>('/api/config-test', { url });
    state.message = r.data.message ?? '';
    state.ok = r.data.ok === true;
  } catch {
    state.message = '网络错误';
    state.ok = false;
  } finally {
    state.busy = false;
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  const pre = precheck();
  if (pre) {
    problem.value = pre;
    return;
  }
  saving.value = true;
  problem.value = '';
  try {
    const r1 = await postJson<{ step: WizardStep }>('/api/step3c', { modId: props.config.id, values: { ...values } });
    if (!r1.ok) {
      problem.value = r1.data.problem ?? '保存失败，请重试';
      return;
    }
    if (!props.isLast) {
      emit('advanced', 'module-config');
      return;
    }
    const r2 = await postJson<{ step: WizardStep }>('/api/step3c/finish', {});
    if (r2.ok) emit('advanced', r2.data.step ?? 'storage');
    else problem.value = r2.data.problem ?? '保存失败，请重试';
  } catch {
    problem.value = '网络错误：本地向导服务不可达';
  } finally {
    saving.value = false;
  }
}

</script>

<template>
  <section class="screen" :data-screen="'module-config'" :data-mod="config.id">
    <h2>③★ 配置模块：<span class="mod-id">{{ config.id }}</span></h2>
    <p class="sub">按模块 manifest 声明收值；secret 只进本次安装进程内存（不落盘、不回显）。</p>
    <div v-for="f in config.fields" :key="f.key" class="field" :data-type="f.type">
      <label class="field-label">
        {{ f.label }}<span v-if="fieldRequired(f)" class="req">*</span>
        <code class="field-key">{{ f.key }}</code>
      </label>

      <template v-if="f.type === 'secret'">
        <UInput v-model="values[f.key]" type="password" :name="f.key" autocomplete="new-password" placeholder="掩码输入；只存本次安装进程内存，不回显" />
      </template>

      <template v-else-if="f.type === 'enum'">
        <UChoiceCardGroup
          :model-value="values[f.key] || null"
          mode="radio"
          :name="f.key"
          :label="f.label"
          :options="(f.options ?? []).map((o) => ({ value: o, title: o }))"
          class="opt-row"
          @update:model-value="(v) => (values[f.key] = v ?? '')"
        />
      </template>

      <template v-else-if="f.type === 'boolean'">
        <label class="radio">
          <input v-model="values[f.key]" type="checkbox" :name="f.key" true-value="true" false-value="false">
          启用
        </label>
      </template>

      <template v-else-if="f.type === 'json'">
        <textarea v-model="values[f.key]" :name="f.key" rows="4" :placeholder="`JSON（如 {&quot;a&quot;:1}）`"></textarea>
      </template>

      <template v-else-if="f.type === 'number'">
        <UInput v-model="values[f.key]" :name="f.key" :inputmode="'numeric'" />
      </template>

      <template v-else-if="f.type === 'url'">
        <UInput v-model="values[f.key]" type="url" :name="f.key" placeholder="https://…" />
      </template>

      <template v-else>
        <UInput v-model="values[f.key]" :name="f.key" />
      </template>

      <template v-if="f.test">
        <button
          type="button"
          class="btn-back"
          :data-test-key="f.key"
          :disabled="f.test !== 'http' || testing[f.key]?.busy"
          :title="f.test !== 'http' ? '装配时验证' : undefined"
          @click="f.test === 'http' && testConnection(f)"
        >
          {{ f.test === 'http' ? '测试连接' : '装配时验证' }}
        </button>
        <span
          v-if="testing[f.key]?.message"
          class="test-out"
          :class="testing[f.key]?.ok ? 'ok' : 'err'"
          :data-out="`${config.id}-${f.key}`"
        >{{ testing[f.key]?.message }}</span>
      </template>
    </div>
    <p class="err">{{ problem }}</p>
    <div class="actions">
      <button type="button" class="btn-back" data-test="back" @click="emit('advanced', 'modules')">← 上一步</button>
      <UButton data-test="cfg-save" :loading="saving" @click="save">保存并继续</UButton>
    </div>
  </section>
</template>
