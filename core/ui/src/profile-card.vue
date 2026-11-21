<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'
import { Crown, Shield } from 'lucide-vue-next'
import UAvatar from './avatar.vue'

/**
 * 成员资料卡内容（纯展示，无二级交互）：头像 + 昵称/句柄/身份标识 + 工作邮箱 + 入群时间。
 * role：owner=群主（金 Crown），admin=管理员（青 Shield），member/缺省=普通成员不显示标识。
 * loginName 三态（#透传）：string=`@登录名`；null=明确的 OIDC 账号占位 `@oidc.no-username`；
 * undefined=来源未知/非 core 身份 → 整行不渲染（不把「未知」当「没有」）。
 * email/joinedAt 缺失时对应行整行不渲染。
 */
const props = withDefaults(defineProps<{
  displayName: string
  /** 真实登录名三态；与接口出参 loginName 同形。 */
  loginName?: string | null
  avatarUrl?: string
  /** 工作邮箱；缺失整行不渲染。 */
  email?: string
  role?: 'owner' | 'admin' | 'member'
  /** ISO 时间串；`xxxx年xx月xx日加入该群`。 */
  joinedAt?: string
}>(), { loginName: undefined, avatarUrl: '', email: undefined, role: 'member', joinedAt: undefined })

const roleMark = computed(() => {
  if (props.role === 'owner') return { icon: Crown, label: '群主', cls: 'u-profile-role-owner' }
  if (props.role === 'admin') return { icon: Shield, label: '管理员', cls: 'u-profile-role-admin' }
  return null
})

const handleText = computed(() => {
  if (props.loginName === undefined) return ''
  return props.loginName === null ? '@oidc.no-username' : `@${props.loginName}`
})

const handlePlaceholder = computed(() => props.loginName === null)

const joinedLabel = computed(() => {
  const date = new Date(props.joinedAt ?? '')
  if (!props.joinedAt || Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日加入该群`
})
</script>

<template>
  <div class="u-profile">
    <UAvatar :src="avatarUrl" :name="displayName" size="lg" />
    <div class="u-profile-body">
      <p class="u-profile-name">
        <span>{{ displayName }}</span>
        <span v-if="roleMark" class="u-profile-role" :class="roleMark.cls" :aria-label="roleMark.label" :title="roleMark.label">
          <component :is="roleMark.icon" :size="14" aria-hidden="true" />
        </span>
      </p>
      <p v-if="handleText" class="u-profile-handle" :class="{ 'u-profile-handle-placeholder': handlePlaceholder }">{{ handleText }}</p>
    </div>
    <p v-if="email" class="u-profile-email"><b>工作邮箱</b>{{ email }}</p>
    <p v-if="joinedLabel" class="u-profile-joined">{{ joinedLabel }}</p>
  </div>
</template>

<style scoped>
.u-profile { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--unself-space-2) var(--unself-space-3); align-items:center; min-width:280px; }
.u-profile-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
.u-profile-name { display:flex; align-items:center; gap:var(--unself-space-1); margin:0; min-width:0; text-align:left; }
.u-profile-name > span:first-child { font-size:var(--unself-font-size-base); font-weight:700; color:var(--unself-color-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.u-profile-role { display:inline-flex; align-items:center; flex:none; }
.u-profile-role-owner { color:var(--unself-color-warning); }
.u-profile-role-admin { color:var(--unself-color-info); }
.u-profile-handle { margin:0; font-size:var(--unself-font-size-sm); text-align:left; color:var(--unself-color-text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* OIDC 占位（@oidc.no-username）：比真实句柄再浅一档，示意「没有」而非「叫这个」 */
.u-profile-handle-placeholder { color:var(--unself-color-text-tertiary); }
.u-profile-email { grid-column:1 / -1; margin:0; font-size:var(--unself-font-size-xs); color:var(--unself-color-text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.u-profile-email b { font-weight:400; color:var(--unself-color-text-tertiary); margin-right:var(--unself-space-1); }
.u-profile-joined { grid-column:1 / -1; margin:0; font-size:var(--unself-font-size-xs); color:var(--unself-color-text-tertiary); }
</style>
