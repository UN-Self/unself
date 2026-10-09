<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ArrowLeft, ArrowUpRight, KeyRound, LayoutDashboard, UserRound } from 'lucide-vue-next'
import { UCard, USkeleton } from '@unself/ui'
import ProfileSettings from './ProfileSettings.vue'
import { fetchMe, type SessionUser } from './lib/session-api'

const router = useRouter()
const user = ref<SessionUser | null>(null)
const avatarEnabled = ref(false)
const mailEnabled = ref(false)
onMounted(async () => {
  const me = await fetchMe()
  if (!me.authenticated) { await router.replace('/login?next=%2Fsettings'); return }
  user.value = me.user
  avatarEnabled.value = me.avatarUploadEnabled === true
  mailEnabled.value = me.mailEnabled
})
function updateProfile(patch: { name?: string; avatarUrl?: string }) {
  if (user.value) user.value = { ...user.value, ...patch }
}
</script>
<template>
  <main class="settings-page">
    <div class="settings-content">
      <header class="settings-header">
        <RouterLink to="/" class="settings-back" aria-label="返回应用"><ArrowLeft :size="20" aria-hidden="true" /></RouterLink>
        <div><h1>个人设置</h1><p>管理你的资料和个人工作台。</p></div>
      </header>
      <USkeleton v-if="!user" class="settings-loading" />
      <template v-else>
        <UCard>
          <section aria-labelledby="profile-title" class="settings-section">
            <div class="settings-section-title"><UserRound :size="20" aria-hidden="true" /><h2 id="profile-title">个人资料</h2></div>
            <ProfileSettings :user="user" :avatar-enabled="avatarEnabled" @changed="updateProfile" />
          </section>
        </UCard>
        <UCard>
          <section aria-labelledby="workspace-title" class="settings-section">
            <div class="settings-section-title"><LayoutDashboard :size="20" aria-hidden="true" /><h2 id="workspace-title">工作台卡片</h2></div>
            <div class="settings-empty"><p>暂时没有可添加的卡片</p><p>模块提供卡片后，你可以在这里选择显示哪些内容。未添加卡片时，导航中不显示工作台。</p></div>
          </section>
        </UCard>
        <UCard v-if="mailEnabled">
          <section aria-labelledby="security-title" class="settings-section">
            <div class="settings-section-title"><KeyRound :size="20" aria-hidden="true" /><h2 id="security-title">账户与安全</h2></div>
            <RouterLink to="/app-password" class="settings-account-link"><span>邮件应用密码</span><ArrowUpRight :size="18" aria-hidden="true" /></RouterLink>
          </section>
        </UCard>
      </template>
    </div>
  </main>
</template>
<style scoped>
/* 使用 core/ui 卡片和表单基元；分组遵循 shadcn Settings 的标题/说明/字段结构。 */
.settings-page { min-height: 100dvh; background: var(--unself-color-surface); padding: var(--unself-space-8) var(--unself-space-4); }
.settings-content { max-width: 720px; margin: 0 auto; display: grid; gap: var(--unself-space-5); }
.settings-header { display: flex; align-items: flex-start; gap: var(--unself-space-3); margin-bottom: var(--unself-space-3); }
.settings-header h1 { font-size: var(--unself-font-size-2xl); font-weight: 600; }
.settings-header p { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); margin-top: var(--unself-space-2); }
.settings-back { display: inline-flex; align-items: center; justify-content: center; width: calc(var(--unself-space-5) * 2); height: calc(var(--unself-space-5) * 2); flex: none; border-radius: var(--unself-radius-md); color: var(--unself-color-text); }
.settings-back:hover { background: var(--unself-color-surface-hover); }
.settings-back:focus-visible, .settings-account-link:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.settings-section { display: grid; gap: var(--unself-space-5); }
.settings-section-title { display: flex; align-items: center; gap: var(--unself-space-2); color: var(--unself-color-text); }
.settings-section-title h2 { font-size: var(--unself-font-size-base); font-weight: 600; }
.settings-empty { display: grid; gap: var(--unself-space-2); padding: var(--unself-space-4); background: var(--unself-color-surface); border-radius: var(--unself-radius-md); font-size: var(--unself-font-size-sm); line-height: 1.6; }
.settings-empty p + p { color: var(--unself-color-text-secondary); }
.settings-account-link { display: flex; align-items: center; justify-content: space-between; gap: var(--unself-space-3); color: var(--unself-color-primary); font-size: var(--unself-font-size-sm); }
.settings-loading { min-height: 320px; }
@media (max-width: 480px) { .settings-page { padding-top: var(--unself-space-5); } }
</style>
