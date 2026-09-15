<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowLeft, ExternalLink, KeyRound, MailX } from 'lucide-vue-next'
import { UButton, UCard, USkeleton } from '@unself/ui'

import { fetchMe } from './lib/session-api'

/**
 * 应用密码说明页（#168，SPEC §6.6 A1）：
 * Stalwart 不允许管理员代建应用密码（凭据绑认证主体），所以这里只给「为什么要 / 怎么生成 / 用在哪」
 * 步骤 + 跳邮件门户；门户里由本人自助创建。
 * 数据只取 /api/me（登录态 + 非敏感）：mailEnabled 决定本页是否有意义，
 * mailPortalUrl 是服务端解析好的跳转目标（portalUrl 优先 / domain 推导兜底 / 皆缺 = null）。
 * 未登录 → 登录页（带 next 回跳）；邮件轴关 → 中性提示，不展示步骤与跳转（不误导）。
 */

type Phase = 'loading' | 'ready' | 'mail-off'

const phase = ref<Phase>('loading')
const mailPortalUrl = ref<string | null>(null)

onMounted(async () => {
  const me = await fetchMe()
  if (!me.authenticated) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
    return
  }
  mailPortalUrl.value = me.mailPortalUrl
  phase.value = me.mailEnabled ? 'ready' : 'mail-off'
})
</script>

<template>
  <div class="guide-page">
    <header class="guide-topbar">
      <RouterLink class="guide-back" to="/">
        <ArrowLeft :size="16" aria-hidden="true" />
        工作台
      </RouterLink>
    </header>

    <main class="guide-main">
      <UCard class="guide-card">
        <div v-if="phase === 'loading'" class="guide-center" role="status">
          <USkeleton class="guide-skeleton" />
        </div>

        <!-- 邮件轴关（验收 3）：直接访问也只给中性提示，不展示步骤/跳转 -->
        <div v-else-if="phase === 'mail-off'" class="guide-center">
          <MailX class="guide-off-icon" :size="28" aria-hidden="true" />
          <h1 class="guide-title">本实例未开启邮件服务</h1>
          <p class="guide-desc">
            当前实例没有邮件能力，因此不需要应用密码。若你需要邮箱，请联系管理员。
          </p>
          <RouterLink class="guide-portal" to="/">返回工作台</RouterLink>
        </div>

        <div v-else class="guide-body">
          <div class="guide-head">
            <KeyRound class="guide-head-icon" :size="24" aria-hidden="true" />
            <h1 class="guide-title">应用密码</h1>
          </div>
          <p class="guide-desc">
            邮件客户端（手机/电脑上的邮件 App）不能用浏览器登录的账号直接收信，
            需要在邮件门户里为每台设备生成一个「应用密码」。
          </p>

          <section class="guide-section">
            <h2 class="guide-section-title">为什么要应用密码</h2>
            <ul class="guide-list">
              <li>网页端登录走实例单点登录，这套凭据只给浏览器用，邮件客户端拿不到。</li>
              <li>应用密码是专供邮件客户端的独立凭据：每台设备一个，可单独吊销，泄露不牵连主账号。</li>
            </ul>
          </section>

          <section class="guide-section">
            <h2 class="guide-section-title">怎么生成</h2>
            <ol class="guide-list">
              <li>打开邮件门户，用你的邮箱账号登录。</li>
              <li>进入「安全 → 应用密码」，新建一个（建议按设备命名，如「iPhone 邮件」）。</li>
              <li>复制生成的那串密码——它只显示一次，关掉页面就看不到了。</li>
            </ol>
          </section>

          <section class="guide-section">
            <h2 class="guide-section-title">用在哪</h2>
            <ol class="guide-list">
              <li>在邮件客户端里新增账号（如 iOS 邮件、Outlook、Thunderbird），账号类型选 IMAP/SMTP。</li>
              <li>用户名填完整邮箱地址，密码粘贴刚生成的应用密码。</li>
              <li>收信/发信服务器地址与端口，以门户里的说明为准。</li>
            </ol>
          </section>

          <div class="guide-actions">
            <a
              v-if="mailPortalUrl"
              class="guide-portal"
              :href="mailPortalUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              打开邮件门户
              <ExternalLink :size="16" aria-hidden="true" />
            </a>
            <template v-else>
              <UButton size="lg" disabled class="guide-portal-off" data-test="portal-disabled">
                打开邮件门户
              </UButton>
              <p class="guide-hint">门户地址尚未配置，请向管理员索取门户地址。</p>
            </template>
          </div>
        </div>
      </UCard>
    </main>
  </div>
</template>

<style scoped>
.guide-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--unself-color-surface);
}
.guide-topbar {
  display: flex;
  align-items: center;
  height: 48px;
  flex-shrink: 0;
  padding: 0 var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
}
.guide-back {
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-1);
  height: 32px;
  padding: 0 var(--unself-space-2);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
  text-decoration: none;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.guide-back:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.guide-back:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.guide-main {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: var(--unself-space-6) var(--unself-space-4) var(--unself-space-8);
}
.guide-card {
  width: 100%;
  max-width: 620px;
  height: fit-content;
}

/* 加载中 / 邮件轴关：居中态 */
.guide-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-6) 0;
  text-align: center;
}
.guide-skeleton {
  width: min(320px, 80%);
}
.guide-off-icon {
  color: var(--unself-color-text-tertiary);
}

/* 说明正文 */
.guide-body {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-4);
}
.guide-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.guide-head-icon {
  flex-shrink: 0;
  color: var(--unself-color-primary);
}
.guide-title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.guide-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  line-height: 1.6;
  color: var(--unself-color-text-secondary);
}
.guide-section {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.guide-section-title {
  margin: 0;
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}
.guide-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  margin: 0;
  padding-left: var(--unself-space-5);
  font-size: var(--unself-font-size-sm);
  line-height: 1.6;
  color: var(--unself-color-text-secondary);
}
.guide-actions {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
  margin-top: var(--unself-space-2);
}
.guide-hint {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}

/*
 * 门户跳转：外部链接需要真锚点（UButton 渲染 button，无 href），
 * 故按 tokens 手写与 UButton lg 同形的锚点样式（48px 高，375px 可点）。
 */
.guide-portal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--unself-space-2);
  width: 100%;
  min-height: 48px;
  padding: 0 var(--unself-space-6);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary);
  color: var(--unself-color-bg);
  font-size: var(--unself-font-size-lg);
  font-weight: 500;
  text-decoration: none;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.guide-portal:hover {
  background: var(--unself-color-primary-hover);
}
.guide-portal:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.guide-portal-off {
  width: 100%;
}

/* 375px 窄屏：收紧外边距，长 URL/长词不撑破布局 */
@media (--unself-bp-sm) {
  .guide-main {
    padding: var(--unself-space-4) var(--unself-space-3) var(--unself-space-6);
  }
  .guide-desc,
  .guide-list {
    overflow-wrap: anywhere;
  }
}
</style>
