<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Mic, Paperclip, SendHorizontal, Smile, Square, X } from 'lucide-vue-next'

import { clearDraft, loadDraft, saveDraft } from '../lib/draft'
import { UButton, UCard, URichInput, type RichInputPart } from '@unself/ui'
import type { Message, UserSummary } from '../lib/types'
import { createVoiceRecorder, isVoiceSupported } from '../lib/voice-recorder'
import type { VoiceRecorder, VoiceRecording } from '../lib/voice-recorder'
import { formatVoiceDuration } from '../lib/waveform'
import type { ComposerDocument } from '../lib/composer-document'
import { COMMON_EMOJI } from '../lib/emoji'

/**
 * 消息输入区（#218 C 路）：文本（markdown 语法由渲染端处理）+ @选择器 + 文件
 * 预览 + 语音录制 + 草稿 + 回复条。上传/发送的网络行为归 store（主会话集成），
 * 本组件管理本地草稿，确认发送后才调用父级的提交接口。
 */
export interface ComposerProps {
  /** 禁用输入（如未连上房间）。 */
  disabled?: boolean
  /** 发送进行中（父级持有，防双击重发）。 */
  sending?: boolean
  /** 文件上传进行中（父级传回，防止重复提交）。 */
  uploading?: boolean
  /** 正在回复的消息（非空显示回复条）。 */
  replyTo?: Message | null
  /** 输入区占位文案。 */
  placeholder?: string
  /** @候选联系人（父级传房间成员/联系人）。 */
  contacts?: UserSummary[]
  /** 草稿与录制复位键（`kind:id`），切换房间时换草稿、停录制。 */
  contextKey: string
  /** 点击发送后执行；失败须 reject，以保留附件与说明文字。 */
  submitDocument?: (document: ComposerDocument, mentionUserIds: number[], signal: AbortSignal) => Promise<void>
}

const props = withDefaults(defineProps<ComposerProps>(), {
  disabled: false,
  sending: false,
  uploading: false,
  replyTo: null,
  placeholder: '输入消息…',
  contacts: () => [],
})

const emit = defineEmits<{
  /** 文本发送：内容 + 本次文本中被 @ 的联系人 id（去重、随文本增删）。 */
  send: [text: string, mentionUserIds: number[]]
  /** 语音发送：录制产物（file/durationMs/waveform）。 */
  'send-voice': [recording: VoiceRecording]
  /** 回复条取消。 */
  'cancel-reply': []
}>()

// ---------- 文本与草稿 ----------

const text = ref('')
const editor = ref<InstanceType<typeof URichInput> | null>(null)
const documentParts = ref<RichInputPart[]>([])
const draftFiles = new Map<string, File>()
const draftUrls = new Map<string, string>()
const hasAttachments = computed(() => documentParts.value.some(part => part.type === 'attachment'))
function releaseFiles(): void {
  for (const url of draftUrls.values()) URL.revokeObjectURL(url)
  draftFiles.clear()
  draftUrls.clear()
  documentParts.value = []
}
const emojiOpen = ref(false)

/** 提及状态：随文本编辑同步增删（本次文本中真实被 @ 的联系人集合）。 */
const mentionUserIds = ref<number[]>([])

/**
 * #230 提及词边界：行首/行尾算边界，正文中 `@` 前与提及名后需落在空白或标点。
 * 口径对齐 worker/src/data/mentions.js 的 isMentionBoundary（服务端按 content 含
 * username 复核提及），避免 `@core` 粘连 `@core:2`、`@bob` 粘连 `@bobby`。
 */
const MENTION_BOUNDARY = /[\s，。！？、：；,.!?()[\]{}<>"'“”‘’《》〈〉「」【】…—～`|/\\*+=&%$#^]/

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || MENTION_BOUNDARY.test(char)
}

/** value 中是否出现被边界包裹的 `@name`（逐位置比较，天然支持冒号与中文）。 */
function textMentionsName(value: string, name: string): boolean {
  const target = name.toLowerCase()
  if (!target) return false
  for (let start = value.indexOf('@'); start !== -1; start = value.indexOf('@', start + 1)) {
    if (start > 0 && !isMentionBoundary(value[start - 1])) continue
    const end = start + 1 + target.length
    if (end > value.length) continue
    if (value.slice(start + 1, end).toLowerCase() !== target) continue
    if (isMentionBoundary(value[end])) return true
  }
  return false
}

/**
 * #230 回填：core JIT 身份下 username=`core:<sub>`（含冒号），展示名为中文。
 * 旧的 `/@([a-zA-Z0-9_-]+)/` 只吃到 `core`，与 username 不等 → mentionUserIds 恒空。
 * 现按联系人的 username / displayName 直接匹配文本（#230 验收：两种输入都产出 id）。
 */
function syncMentionsFromText(value: string): void {
  const valid = new Set<number>()
  for (const contact of props.contacts) {
    const names = [contact.username, contact.displayName]
    if (names.some((name) => textMentionsName(value, name))) valid.add(contact.id)
  }
  mentionUserIds.value = [...valid]
}

const submittingFile = ref(false)
const fileError = ref('')
let fileSubmission: AbortController | null = null
const busy = computed(() => props.sending || props.uploading || submittingFile.value)
const sendable = computed(() => !props.disabled && !busy.value && (text.value.trim().length > 0 || hasAttachments.value))

function onDocumentChange(parts: RichInputPart[], value: string, caret: number): void {
  documentParts.value = parts
  text.value = value
  syncMentionsFromText(value.replaceAll('\uFFFC', '\n'))
  if (contextRoom.value) saveDraft(contextRoom.value.kind, contextRoom.value.id, value.replaceAll('\uFFFC', ''))
  maybeOpenMentionMenu(value, caret)
}

// ---------- 中文输入法：composition 期间 Enter 不发送 ----------

const composing = ref(false)

// ---------- @选择器 ----------

const mentionMenuOpen = ref(false)
const mentionQuery = ref('')
const mentionActiveIndex = ref(0)
const mentionTriggerPos = ref(-1)

// #230：username / displayName 双向匹配——core 身份下 username=`core:<sub>`（含冒号）、
// 展示名为中文，查询片段对任一字段前缀命中即出候选。
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
  // #230：query 取 `@` 之后任意非空白片段（放行冒号与非 ASCII；旧 ASCII 白名单会让 `@走` 关浮层）。
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
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
  const caret = editor.value?.selection() ?? text.value.length
  editor.value?.insertText(`@${contact.username} `, mentionTriggerPos.value >= 0 ? mentionTriggerPos.value : caret, caret)
  mentionMenuOpen.value = false
  mentionQuery.value = ''

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
  if (event.key === 'Enter' && !event.shiftKey && !composing.value && !event.isComposing) {
    event.preventDefault()
    sendText()
  }
}

// ---------- 发送 ----------

async function sendText(): Promise<void> {
  if (!sendable.value || composing.value) return
  if (mentionMenuOpen.value && mentionCandidates.value.length > 0) return
  const trimmed = text.value.trim()
  if (hasAttachments.value) {
    const document: ComposerDocument = { parts: documentParts.value.map(part => ({ ...part })), files: new Map(draftFiles) }
    const context = props.contextKey
    submittingFile.value = true
    fileSubmission = new AbortController()
    fileError.value = ''
    try {
      if (!props.submitDocument) throw new Error('附件发送暂不可用')
      await props.submitDocument(document, [...mentionUserIds.value], fileSubmission.signal)
      if (props.contextKey !== context) return
      clearSentText()
      return
    } catch (error) {
      if (props.contextKey === context) fileError.value = error instanceof Error ? error.message : '发送失败，请重试'
      return
    } finally {
      submittingFile.value = false
      fileSubmission = null
    }
  } else {
    emit('send', trimmed, [...mentionUserIds.value])
  }
  clearSentText()
}

function clearSentText(): void {
  text.value = ''
  editor.value?.setText('')
  releaseFiles()
  mentionUserIds.value = []
  if (contextRoom.value) clearDraft(contextRoom.value.kind, contextRoom.value.id)
  // #339①：发送期间输入区 disabled（busy）会按 HTML 规范强制失焦——busy 解除后把焦点还给输入区，
  // 连续聊天零点击。TipTap focus() 自带光标归位（末尾）。
  editor.value?.focus()
}

function insertEmoji(emoji: string): void {
  editor.value?.insertText(emoji)
  emojiOpen.value = false
}

// ---------- 本地附件：只有点击发送后才上传 ----------
const fileInput = ref<HTMLInputElement | null>(null)
function pickFile(): void { fileInput.value?.click() }
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}
function addFiles(files: File[]): void {
  if (busy.value || props.disabled) return
  const count = documentParts.value.filter(part => part.type === 'attachment').length
  if (count + files.length > 10) { fileError.value = '一条消息最多添加 10 个附件'; return }
  fileError.value = ''
  for (const file of files) {
    const id = crypto.randomUUID()
    const image = file.type.startsWith('image/')
    const src = image ? URL.createObjectURL(file) : ''
    draftFiles.set(id, file)
    if (src) draftUrls.set(id, src)
    editor.value?.insertAttachment({ id, src, name: file.name, image })
  }
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

// #339①：发送期间输入区 disabled（busy）会按 HTML 规范强制失焦——busy 解除后把焦点还给输入区，
// 连续聊天零点击。父层 sending 置位发生在 emit('send') 之后（子组件同步 return 前还看不到），
// 单在 sendText 里 refocus 会被随后的 disable 抢走——所以监听 busy 下降沿（覆盖所有 busy 转换）。
// TipTap focus() 自带光标归位（末尾）；jsdom 下 view.dom.focus 兑底。
watch(busy, (now, was) => {
  if (was && !now) editor.value?.focus()
})

watch(
  contextRoom,
  (room, previous) => {
  if (previous?.kind === room?.kind && previous?.id === room?.id) return
  fileSubmission?.abort()
  if (recording.value) cancelRecording()
  releaseFiles()
  fileError.value = ''
  emojiOpen.value = false
  if (room) {
    text.value = loadDraft(room.kind, room.id)
    syncMentionsFromText(text.value)
  } else {
    text.value = ''
    mentionUserIds.value = []
  }
  editor.value?.setText(text.value)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  releaseFiles()
  fileSubmission?.abort()
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

    <p v-if="fileError" role="alert" class="composer-error">{{ fileError }}</p>

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
      <div class="composer-emoji-wrap">
        <button
          type="button"
          class="composer-icon-btn"
          data-test="emoji-toggle"
          aria-label="插入表情"
          :aria-expanded="emojiOpen"
          :disabled="disabled || recording || busy"
          @click="emojiOpen = !emojiOpen"
        >
          <Smile :size="18" aria-hidden="true" />
        </button>
        <UCard v-if="emojiOpen" padding="none" class="composer-emoji-popover" data-test="emoji-picker" role="grid" aria-label="表情">
          <button
            v-for="emoji in COMMON_EMOJI"
            :key="emoji"
            type="button"
            class="composer-emoji-item"
            role="gridcell"
            :aria-label="`插入${emoji}`"
            @click="insertEmoji(emoji)"
          >{{ emoji }}</button>
        </UCard>
      </div>
      <button
        type="button"
        class="composer-icon-btn"
        data-test="attach-file"
        aria-label="附加文件"
        :disabled="disabled || recording || busy"
        @click="pickFile"
      >
        <Paperclip :size="18" aria-hidden="true" />
      </button>
      <input ref="fileInput" type="file" multiple class="composer-file-input" aria-hidden="true" tabindex="-1" @change="onFileChange" />

      <URichInput
        ref="editor"
        :initial-text="text"
        :placeholder="placeholder"
        :disabled="disabled || busy"
        @change="onDocumentChange"
        @files="addFiles"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />

      <button
        v-if="!recording && !hasAttachments && text.trim().length === 0"
        type="button"
        class="composer-icon-btn"
        data-test="record-start"
        aria-label="开始录音"
        :disabled="disabled || busy || recordUnsupported"
        :title="recordUnsupported ? '当前浏览器不支持语音录制' : undefined"
        @click="startRecording"
      >
        <Mic :size="18" aria-hidden="true" />
      </button>
      <UButton
        v-show="text.trim().length > 0 || hasAttachments"
        variant="primary"
        size="sm"
        type="button"
        class="composer-send-btn"
        data-test="send"
        aria-label="发送消息"
        :disabled="!sendable"
        @click="sendText"
      >
        <SendHorizontal :size="18" aria-hidden="true" />
      </UButton>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border-top: 1px solid var(--unself-color-border);
  padding: var(--unself-space-2) var(--unself-space-3) var(--unself-space-3);
  background: var(--unself-color-bg);
}
.composer-row {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: var(--unself-space-1);
  padding: 0;
}
.composer-emoji-wrap {
  position: relative;
}
.composer-emoji-popover {
  position: absolute;
  z-index: 2;
  bottom: calc(100% + var(--unself-space-3));
  left: 0;
  display: grid;
  grid-template-columns: repeat(8, minmax(2rem, 1fr));
  gap: var(--unself-space-1);
  width: min(20rem, calc(100vw - 2rem));
  max-height: 14rem;
  overflow-y: auto;
  padding: var(--unself-space-2);
  box-shadow: var(--unself-shadow-pop);
}
.composer-emoji-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--unself-touch-target);
  min-height: var(--unself-touch-target);
  border: 0;
  border-radius: var(--unself-radius-sm);
  background: transparent;
  font-size: 1.25rem;
  cursor: pointer;
}
.composer-emoji-item:hover,
.composer-emoji-item:focus-visible {
  background: var(--unself-color-surface-hover);
}
.composer-error { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); }
.composer-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  min-width: 40px;
  min-height: 40px;
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
  width: 40px;
  min-width: 40px;
  min-height: 40px;
  padding: 0;
  border: 0;
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
