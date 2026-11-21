<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { UserPlus, X } from 'lucide-vue-next'
import { UButton, UHoverCard, UMessageAvatar, UProfileCard } from '@unself/ui'
import type { ChannelMember, UserSummary } from '../lib/types'

const props = defineProps<{
  name: string
  members: ChannelMember[]
  contacts: UserSummary[]
  canManage: boolean
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ close: []; invite: [userIds: number[]] }>()
const selected = ref<number[]>([])
const query = ref('')
const available = computed(() => props.contacts.filter((user) =>
  !props.members.some((member) => member.id === user.id) &&
  `${user.displayName} ${user.username}`.toLowerCase().includes(query.value.trim().toLowerCase()),
))

function toggle(id: number): void {
  selected.value = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]
}

function invite(): void {
  if (selected.value.length === 0) return
  emit('invite', [...selected.value])
  selected.value = []
}
</script>

<template>
  <div class="group-backdrop" @click.self="emit('close')">
    <section class="group-panel" role="dialog" aria-modal="true" aria-labelledby="group-details-title">
      <header class="group-head">
        <div><h2 id="group-details-title">{{ name }}</h2><p>{{ members.length }} 位成员</p></div>
        <button type="button" class="group-close" aria-label="关闭群组信息" @click="emit('close')"><X :size="18" /></button>
      </header>
      <div class="group-list">
        <!-- :portal="false"：本面板是 aria-modal 对话框，卡片传送出去会被读屏忽略，就地渲染 -->
        <UHoverCard v-for="member in members" :key="member.id" :portal="false">
          <template #trigger>
            <!-- 整行触发（点击钉住为主路径，悬停保留预览）：行升级为 button 语义，Tab 可遍历 -->
            <button type="button" class="group-person group-person-card" :aria-label="`查看 ${member.displayName} 的资料`" :aria-describedby="`group-member-card-${member.id}`">
              <UMessageAvatar :src="member.avatarUrl" :name="member.displayName" />
              <span>{{ member.displayName }}</span>
              <small v-if="member.role === 'owner'">群主</small>
            </button>
          </template>
          <UProfileCard
            :id="`group-member-card-${member.id}`"
            :display-name="member.displayName"
            :login-name="member.loginName"
            :avatar-url="member.avatarUrl"
            :email="member.email"
            :role="member.role === 'owner' ? 'owner' : 'member'"
            :joined-at="member.joinedAt"
          />
        </UHoverCard>
      </div>
      <div v-if="canManage" class="group-invite">
        <h3><UserPlus :size="16" /> 邀请成员</h3>
        <input v-model="query" aria-label="搜索可邀请成员" placeholder="搜索联系人" />
        <div class="group-list">
          <button v-for="contact in available" :key="contact.id" type="button" class="group-person group-choice" :aria-pressed="selected.includes(contact.id)" @click="toggle(contact.id)">
            <UMessageAvatar :src="contact.avatarUrl" :name="contact.displayName" />
            <span>{{ contact.displayName }}</span>
            <span class="group-check">{{ selected.includes(contact.id) ? '✓' : '' }}</span>
          </button>
        </div>
        <p v-if="error" role="alert" class="group-error">{{ error }}</p>
        <UButton type="button" size="sm" :disabled="busy || selected.length === 0" @click="invite">邀请 {{ selected.length || '' }}</UButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.group-backdrop { position:absolute; inset:0; z-index:6; display:flex; justify-content:flex-end; background:color-mix(in srgb, var(--unself-color-text) 18%, transparent); }
.group-panel { width:min(380px, 100%); height:100%; box-sizing:border-box; overflow:auto; padding:var(--unself-space-5); border-left:1px solid var(--unself-color-border); background:var(--unself-color-bg); box-shadow:var(--unself-shadow-pop); }
.group-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--unself-space-3); border-bottom:1px solid var(--unself-color-border); padding-bottom:var(--unself-space-4); }
.group-head h2 { margin:0; font-size:var(--unself-font-size-lg); }
.group-head p { margin:var(--unself-space-1) 0 0; color:var(--unself-color-text-tertiary); font-size:var(--unself-font-size-sm); }
.group-close { display:grid; place-items:center; width:36px; height:36px; border:0; border-radius:var(--unself-radius-md); background:transparent; color:var(--unself-color-text-secondary); cursor:pointer; }
.group-list { display:grid; gap:var(--unself-space-1); margin:var(--unself-space-4) 0; }
.group-person { display:flex; align-items:center; gap:var(--unself-space-2); min-height:40px; color:var(--unself-color-text); }
/* 成员行整行触发资料卡：button 复位（继承 .group-person 布局），加 hover/focus 反馈 */
.group-person-card { width:100%; padding:var(--unself-space-1); border:0; border-radius:var(--unself-radius-md); background:transparent; text-align:left; font:inherit; cursor:pointer; }
.group-person-card:hover { background:var(--unself-color-surface-hover); }
.group-person-card:focus-visible { outline:var(--unself-focus-ring); outline-offset:-2px; }
.group-person small, .group-check { margin-left:auto; color:var(--unself-color-text-tertiary); }
.group-avatar { display:grid; place-items:center; width:32px; height:32px; border-radius:var(--unself-radius-full); background:var(--unself-color-primary-soft); color:var(--unself-color-primary); font-weight:600; }
.group-invite { border-top:1px solid var(--unself-color-border); padding-top:var(--unself-space-4); }
.group-invite h3 { display:flex; align-items:center; gap:var(--unself-space-2); margin:0 0 var(--unself-space-3); font-size:var(--unself-font-size-base); }
.group-invite input { width:100%; box-sizing:border-box; min-height:40px; padding:0 var(--unself-space-3); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-md); background:var(--unself-color-bg); color:var(--unself-color-text); font:inherit; }
.group-choice { width:100%; padding:var(--unself-space-1); border:0; border-radius:var(--unself-radius-md); background:transparent; text-align:left; font:inherit; cursor:pointer; }
.group-choice:hover, .group-choice[aria-pressed="true"] { background:var(--unself-color-surface-active); }
.group-check { color:var(--unself-color-primary); }
.group-error { color:var(--unself-color-danger); font-size:var(--unself-font-size-sm); }
</style>
