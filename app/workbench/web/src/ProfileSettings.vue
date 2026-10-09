<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { Camera, Trash2 } from 'lucide-vue-next'
import { UAvatar, UButton, UInput } from '@unself/ui'
import { updateMyName, uploadMyAvatar, removeMyAvatar, type SessionUser } from './lib/session-api'

const props = defineProps<{ user: SessionUser; avatarEnabled: boolean }>()
const emit = defineEmits<{ changed: [patch: { name?: string; avatarUrl?: string }] }>()
const name = ref(props.user.name)
const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const error = ref('')
const status = ref('')
watch(() => props.user.name, value => { name.value = value })

async function run(action: () => Promise<void>, success: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  status.value = ''
  try { await action(); status.value = success }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function saveName() {
  await run(async () => {
    emit('changed', { name: await updateMyName(name.value) })
  }, '昵称已保存')
}
async function chooseAvatar(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await run(async () => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 2 * 1024 * 1024) throw new Error('头像不能超过 2 MB')
    emit('changed', { avatarUrl: await uploadMyAvatar(file) })
  }, '头像已保存')
}
async function clearAvatar() {
  await run(async () => { emit('changed', { avatarUrl: await removeMyAvatar() }) }, '头像已移除')
}
</script>
<template>
  <div class="profile-settings">
    <div class="profile-avatar-row">
      <UAvatar :name="user.name" :src="user.avatarUrl" size="lg" />
      <div class="profile-avatar-actions">
        <div class="profile-buttons">
          <UButton variant="outline" :disabled="busy || !avatarEnabled" @click="fileInput?.click()">
            <Camera :size="16" aria-hidden="true" />更换头像
          </UButton>
          <UButton v-if="user.avatarUrl" variant="ghost" :disabled="busy" @click="clearAvatar">
            <Trash2 :size="16" aria-hidden="true" />移除
          </UButton>
        </div>
        <p class="profile-hint">{{ avatarEnabled ? 'PNG、JPEG 或 WebP，最大 2 MB。选择后立即保存。' : '当前实例尚未配置头像存储。' }}</p>
        <input ref="fileInput" class="profile-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择头像图片" :disabled="busy || !avatarEnabled" tabindex="-1" @change="chooseAvatar">
      </div>
    </div>
    <form class="profile-name-form" @submit.prevent="saveName">
      <UInput v-model="name" label="昵称" name="display-name" autocomplete="nickname" :disabled="busy" required :reserve-error-line="false" />
      <p class="profile-hint">其他成员将在聊天和成员列表中看到这个名字。</p>
      <UButton type="submit" :disabled="busy || !name.trim() || name.trim().length > 80 || name.trim() === user.name">保存昵称</UButton>
    </form>
    <p v-if="error" role="alert" class="profile-error">{{ error }}</p>
    <p v-if="status" role="status" class="profile-success">{{ status }}</p>
  </div>
</template>
<style scoped>
.profile-settings { display: grid; gap: var(--unself-space-6); }
.profile-avatar-row { display: flex; align-items: center; gap: var(--unself-space-4); }
.profile-avatar-actions { display: grid; gap: var(--unself-space-2); min-width: 0; }
.profile-buttons { display: flex; flex-wrap: wrap; gap: var(--unself-space-2); }
.profile-file { display: none; }
.profile-name-form { display: grid; justify-items: start; gap: var(--unself-space-3); }
.profile-name-form > :first-child { width: 100%; }
.profile-hint { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); line-height: 1.6; }
.profile-error { color: var(--unself-color-danger); font-size: var(--unself-font-size-sm); }
.profile-success { color: var(--unself-color-success); font-size: var(--unself-font-size-sm); }
</style>
