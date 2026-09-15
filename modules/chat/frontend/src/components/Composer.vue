<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Mic, Paperclip, SendHorizontal, Square, X } from 'lucide-vue-next'

import { clearDraft, loadDraft, saveDraft } from '../lib/draft'
import type { Message, UserSummary } from '../lib/types'
import { createVoiceRecorder, isVoiceSupported } from '../lib/voice-recorder'
import type { VoiceRecorder, VoiceRecording } from '../lib/voice-recorder'
import { formatVoiceDuration } from '../lib/waveform'

/**
 * 消息输入区（#218 C 路）：文本（markdown 语法由渲染端处理）+ @选择器 + 文件
 * 预览 + 语音录制 + 草稿 + 回复条。上传/发送的网络行为归 store（主会话集成），
 * 本组件只产出语义事件。
 */
export interface ComposerProps {
  /** 禁用输入（如未连上房间）。 */
  disabled?: boolean
  /** 发送进行中（父级持有，防双击重发）。 */
  sending?: boolean
  /** 文件上传进行中（父级传回，驱动进度条）。 */
  uploading?: boolean
  /** 文件上传进度 0-100（父级传回）。 */
  uploadProgress?: number
  /** 正在回复的消息（非空显示回复条）。 */
  replyTo?: Message | null
  /** 输入区占位文案。 */
  placeholder?: string
  /** @候选联系人（父级传房间成员/联系人）。 */
  contacts?: UserSummary[]
  /** 草稿与录制复位键（`kind:id`），切换房间时换草稿、停录制。 */
  contextKey: string
}

const props = withDefaults(defineProps<ComposerProps>(), {
  disabled: false,
  sending: false,
  uploading: false,
  uploadProgress: 0,
  replyTo: null,
  placeholder: '输入消息…',
  contacts: () => [],
})

const emit = defineEmits<{
  /** 文本发送：内容 + 本次文本中被 @ 的联系人 id（去重、随文本增删）。 */
  send: [text: string, mentionUserIds: number[]]
  /** 语音发送：录制产物（file/durationMs/waveform）。 */
  'send-voice': [recording: VoiceRecording]
  /** 文件发送：选中的文件（上传与消息发送由 store 编排）。 */
  'send-file': [file: File]
  /** 回复条取消。 */
  'cancel-reply': []
}>()

// ---------- 文本与草稿 ----------

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

/** 提及状态：随文本编辑同步增删（本次文本中真实被 @ 的联系人集合）。 */
const mentionUserIds = ref<number[]>([])

function syncMentionsFromText(value: string): void {
  const matches = [...value.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => m[1] ?? '')
  const valid = new Set<number>()
  for (const contact of props.contacts) {
    if (matches.includes(contact.username)) valid.add(contact.id)
  }
  mentionUserIds.value = [...valid]
}

const sendable = computed(() => !props.disabled && !props.sending && text.value.trim().length > 0)

function onInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value
  text.value = value
  syncMentionsFromText(value)
  updateHeight()
  if (contextRoom.value) saveDraft(contextRoom.value.kind, contextRoom.value.id, value)
  const caret = textarea.value?.selectionStart ?? value.length
  maybeOpenMentionMenu(value, caret)
}

// 自适应高度：rows=1 起步，最高 6 行（约 132px），超出滚动。
const MAX_TEXTAREA_HEIGHT_PX = 132
function updateHeight(): void {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
}

// ---------- 中文输入法：composition 期间 Enter 不发送 ----------

const composing = ref(false)

// ---------- @选择器 ----------

const mentionMenuOpen = ref(false)
const mentionQuery = ref('')
const mentionActiveIndex = ref(0)
const mentionTriggerPos = ref(-1)

const mentionCandidates = computed(() => {
  const query = mentionQuery.value.toLowerCase()
  return props.contacts.filter((contact) => {
    if (query === '') return true
    return (
      contact.username.toLowerCase().startsWith(query) ||
      contact.displayName.toLowerCase().startsWith(query)
    )
  })
})

function maybeOpenMentionMenu(value: string, caret: number): void {
  const before = value.slice(0, caret)
  const match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(before)
  if (match) {
    mentionTriggerPos.value = caret - (match[1]?.length ?? 0) - 1
    mentionQuery.value = match[1] ?? ''
    mentionActiveIndex.value = 0
    mentionMenuOpen.value = true
  } else {
    mentionMenuOpen.value = false
    mentionTriggerPos.value = -1
    mentionQuery.value = ''
  }
}

function applyMention(contact: UserSummary): void {
  const el = textarea.value
  const caret = el?.selectionStart ?? text.value.length
  const head = text.value.slice(0, mentionTriggerPos.value >= 0 ? mentionTriggerPos.value : caret)
  const tail = text.value.slice(caret)
  const inserted = `@${contact.username} `
  text.value = head + inserted + tail
  const nextCaret = head.length + inserted.length
  mentionMenuOpen.value = false
  mentionQuery.value = ''
  syncMentionsFromText(text.value)
  void nextTick(() => {
    el?.focus()
    el?.setSelectionRange(nextCaret, nextCaret)
    updateHeight()
  })
}

/**
 * 统一键盘处理：@浮层打开时 ↑↓/Enter/Esc 归浮层；否则 Enter 发送、
 * Shift+Enter 换行；composition 期间一律不发送。
 */
function onKeydown(event: KeyboardEvent): void {
  if (mentionMenuOpen.value && mentionCandidates.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % mentionCandidates.value.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      mentionActiveIndex.value =
        (mentionActiveIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const contact = mentionCandidates.value[mentionActiveIndex.value]
      if (contact) applyMention(contact)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      mentionMenuOpen.value = false
    }
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !composing.value) {
    event.preventDefault()
    sendText()
  }
}

// ---------- 发送 ----------

function sendText(): void {
  if (!sendable.value || composing.value) return
  if (mentionMenuOpen.value && mentionCandidates.value.length > 0) return
  const trimmed = text.value.trim()
  emit('send', trimmed, [...mentionUserIds.value])
  text.value = ''
  mentionUserIds.value = []
  if (contextRoom.value) clearDraft(contextRoom.value.kind, contextRoom.value.id)
  void nextTick(updateHeight)
}

// ---------- 文件 ----------

const fileInput = ref<HTMLInputElement | null>(null)
const pendingFile = ref<File | null>(null)

function pickFile(): void {
  fileInput.value?.click()
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选择同一文件
  if (!file) return
  pendingFile.value = file
  emit('send-file', file)
}

function clearPendingFile(): void {
  pendingFile.value = null
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// ---------- 语音录制 ----------

const recorder = ref<VoiceRecorder | null>(null)
const recording = ref(false)
/** 挂载时探测一次（运行时失败由 start 的 catch 兑现为提示）。 */
const recordUnsupported = ref(!isVoiceSupported())
const recordElapsedMs = ref(0)
let recordTick: ReturnType<typeof setInterval> | null = null
let recordStartedAt = 0

function startRecording(): void {
  if (recording.value || props.disabled) return
  const instance = createVoiceRecorder()
  recorder.value = instance
  instance
    .start()
    .then(() => {
      recording.value = true
      recordStartedAt = Date.now()
      recordTick = setInterval(() => {
        recordElapsedMs.value = Date.now() - recordStartedAt
      }, 200)
    })
    .catch(() => {
      // 运行时失败（权限拒绝等）：不进入录制态即可；重按 Mic 可重试
    })
}

async function stopRecording(): Promise<void> {
  const instance = recorder.value
  if (!instance || !recording.value) return
  const result = await instance.stop()
  teardownRecording()
  emit('send-voice', result)
}

function cancelRecording(): void {
  recorder.value?.cancel()
  teardownRecording()
}

function teardownRecording(): void {
  if (recordTick !== null) {
    clearInterval(recordTick)
    recordTick = null
  }
  recording.value = false
  recordElapsedMs.value = 0
  recorder.value = null
}

const recordLabel = computed(() => formatVoiceDuration(recordElapsedMs.value))

// ---------- contextKey：草稿切换 + 录制复位 ----------

const contextRoom = computed<{ kind: string; id: number } | null>(() => {
  const dot = props.contextKey.indexOf('.')
  if (dot <= 0) return null
  const kind = props.contextKey.slice(0, dot)
  const id = Number(props.contextKey.slice(dot + 1))
  return Number.isNaN(id) ? null : { kind, id }
})

watch(
  contextRoom,
  (room, previous) => {
  if (previous?.kind === room?.kind && previous?.id === room?.id) return
  if (recording.value) cancelRecording()
  pendingFile.value = null
  if (room) {
    text.value = loadDraft(room.kind, room.id)
    syncMentionsFromText(text.value)
  } else {
    text.value = ''
    mentionUserIds.value = []
  }
  void nextTick(updateHeight)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (recording.value) cancelRecording()
})

// ---------- 回复条 ----------

const replyPreview = computed(() => {
  const reply = props.replyTo
  if (!reply) return ''
  const content = reply.content
  return content.length > 60 ? `${content.slice(0, 60)}…` : content
})
</script>

<template>
  <div class="composer" data-test="composer">
    <!-- 回复条 -->
    <div v-if="replyTo" class="composer-reply" data-test="reply-bar">
      <span class="composer-reply-text" data-test="reply-preview">{{ replyPreview }}</span>
      <button
        type="button"
        class="composer-icon-btn"
        data-test="cancel-reply"
        aria-label="取消回复"
        @click="emit('cancel-reply')"
      >
        <X :size="16" aria-hidden="true" />
      </button>
    </div>

    <!-- 文件预览条 -->
    <div v-if="pendingFile" class="composer-file" data-test="pending-file">
      <span class="composer-file-name">{{ pendingFile.name }}</span>
      <span class="composer-file-size">{{ formatFileSize(pendingFile.size) }}</span>
      <div v-if="uploading" class="composer-progress" role="progressbar" :aria-valuenow="uploadProgress" aria-valuemin="0" aria-valuemax="100">
        <div class="composer-progress-bar" :style="{ width: `${Math.min(100, Math.max(0, uploadProgress))}%` }" />
      </div>
      <button type="button" class="composer-icon-btn" data-test="clear-file" aria-label="移除文件" @click="clearPendingFile">
        <X :size="16" aria-hidden="true" />
      </button>
    </div>

    <!-- @选择浮层 -->
    <div v-if="mentionMenuOpen && mentionCandidates.length > 0" class="composer-mentions" data-test="mention-menu" role="listbox" aria-label="提及候选人">
      <button
        v-for="(contact, index) in mentionCandidates"
        :key="contact.id"
        type="button"
        class="composer-mention-item"
        :class="{ 'composer-mention-item-active': index === mentionActiveIndex }"
        role="option"
        :aria-selected="index === mentionActiveIndex"
        :data-test="`mention-option-${contact.username}`"
        @mousedown.prevent="applyMention(contact)"
        @mousemove="mentionActiveIndex = index"
      >
        <span class="composer-mention-name">{{ contact.displayName }}</span>
        <span class="composer-mention-username">@{{ contact.username }}</span>
      </button>
    </div>

    <!-- 录制条 -->
    <div v-if="recording" class="composer-recording" data-test="recording-bar" role="status" :aria-label="`正在录音 ${recordLabel}`">
      <span class="composer-recording-dot" aria-hidden="true" />
      <span class="composer-recording-time" data-test="recording-time">{{ recordLabel }}</span>
      <button type="button" class="composer-icon-btn" data-test="record-stop" aria-label="停止并发送" @click="stopRecording">
        <Square :size="16" aria-hidden="true" />
      </button>
      <button type="button" class="composer-icon-btn" data-test="record-cancel" aria-label="取消录音" @click="cancelRecording">
        <X :size="16" aria-hidden="true" />
      </button>
    </div>

    <!-- 主输入行 -->
    <div class="composer-row">
      <button
        type="button"
        class="composer-icon-btn"
        data-test="attach-file"
        aria-label="附加文件"
        :disabled="disabled || recording"
        @click="pickFile"
      >
        <Paperclip :size="18" aria-hidden="true" />
      </button>
      <input ref="fileInput" type="file" class="composer-file-input" aria-hidden="true" tabindex="-1" @change="onFileChange" />

      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        class="composer-textarea"
        data-test="composer-input"
        :placeholder="placeholder"
        :disabled="disabled || sending"
        :aria-label="'消息输入'"
        @input="onInput"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />

      <button
        v-if="!recording"
        type="button"
        class="composer-icon-btn"
        data-test="record-start"
        aria-label="开始录音"
        :disabled="disabled || recordUnsupported"
        :title="recordUnsupported ? '当前浏览器不支持语音录制' : undefined"
        @click="startRecording"
      >
        <Mic :size="18" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="composer-send-btn"
        data-test="send"
        aria-label="发送消息"
        :disabled="!sendable"
        @click="sendText"
      >
        <SendHorizontal :size="18" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border-top: 1px solid var(--unself-color-border);
  background: var(--unself-color-bg);
}
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2) var(--unself-space-3);
}
.composer-textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-base);
  font-family: inherit;
  line-height: 1.5;
  padding: var(--unself-space-2) var(--unself-space-3);
  overflow-y: auto;
  transition: border-color var(--unself-duration-fast) var(--unself-ease-out);
}
.composer-textarea:focus {
  outline: var(--unself-focus-ring);
  outline-offset: 1px;
}
.composer-textarea:disabled {
  background: var(--unself-color-surface);
  cursor: not-allowed;
}
.composer-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--unself-touch-target);
  min-height: var(--unself-touch-target);
  border: none;
  border-radius: var(--unself-radius-full);
  background: transparent;
  color: var(--unself-color-text-secondary);
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.composer-icon-btn:hover:not(:disabled) {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.composer-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.composer-icon-btn:focus-visible,
.composer-send-btn:focus-visible,
.composer-mention-item:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 1px;
}
.composer-send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--unself-touch-target);
  min-height: var(--unself-touch-target);
  border: none;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-primary);
  color: var(--unself-color-bg);
  cursor: pointer;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-out);
}
.composer-send-btn:hover:not(:disabled) {
  background: var(--unself-color-primary-hover);
}
.composer-send-btn:active:not(:disabled) {
  transform: scale(0.95);
}
.composer-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.composer-file-input {
  display: none;
}
.composer-reply {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
}
.composer-reply-text {
  flex: 1;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-file {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
}
.composer-file-name {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-file-size {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  flex-shrink: 0;
}
.composer-progress {
  flex: 1;
  height: 4px;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-surface-active);
  overflow: hidden;
}
.composer-progress-bar {
  height: 100%;
  background: var(--unself-color-primary);
  border-radius: var(--unself-radius-full);
  transition: width var(--unself-duration-normal) var(--unself-ease-out);
}
.composer-mentions {
  position: absolute;
  bottom: 100%;
  left: var(--unself-space-3);
  right: var(--unself-space-3);
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  box-shadow: var(--unself-shadow-pop);
}
.composer-mention-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  width: 100%;
  padding: var(--unself-space-2) var(--unself-space-3);
  border: none;
  background: transparent;
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-sm);
  text-align: left;
  cursor: pointer;
}
.composer-mention-item-active {
  background: var(--unself-color-surface);
}
.composer-mention-name {
  font-weight: 500;
}
.composer-mention-username {
  color: var(--unself-color-text-tertiary);
}
.composer-recording {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-danger-soft);
}
.composer-recording-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-danger);
}
.composer-recording-time {
  font-variant-numeric: tabular-nums;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-danger);
}
</style>
