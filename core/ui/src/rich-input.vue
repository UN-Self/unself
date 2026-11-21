<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Node } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import { UndoRedo } from '@tiptap/extensions'
import type { RichInputPart } from './rich-input-types'

const props = withDefaults(defineProps<{ disabled?: boolean; placeholder?: string; initialText?: string; initialParts?: RichInputPart[] }>(), { disabled: false, placeholder: '输入消息…', initialParts: () => [] })
const emit = defineEmits<{ change: [parts: RichInputPart[], text: string, caret: number]; keydown: [event: KeyboardEvent]; files: [files: File[]] }>()
// A flat inline schema makes text offsets, hard breaks and attachment atoms share one cursor space.
// Tiptap/ProseMirror owns selection, IME, drag moves and undo; no HTML is persisted or accepted as media.
const Media = Node.create({
  name: 'attachment', inline: true, group: 'inline', atom: true, draggable: true,
  addAttributes: () => ({ id: { default: '' }, src: { default: '' }, name: { default: '' }, image: { default: false } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', { class: 'u-rich-attachment', 'data-attachment-id': node.attrs.id, contenteditable: 'false', title: node.attrs.name },
    node.attrs.image ? ['img', { src: node.attrs.src, alt: node.attrs.name, draggable: 'false' }] : ['span', {}, node.attrs.name]],
})
// Mention 原子（与 attachment 同一套 inline atom 模式）：编辑器里显示 @displayName 的
// 不可编辑 chip；纯文本序列化输出 @username，token 与显示分离（#347）。
const Mention = Node.create({
  name: 'mention', inline: true, group: 'inline', atom: true,
  addAttributes: () => ({ id: { default: 0 }, username: { default: '' }, displayName: { default: '' } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', { class: 'u-rich-mention', 'data-mention-id': node.attrs.id, 'data-mention-username': node.attrs.username, contenteditable: 'false' }, `@${node.attrs.displayName}`],
})
/** part → 文档内容（初始与 setParts 共用）：text→textNodes、mention→chip、attachment 不参与重建。 */
function partsToContent(parts: RichInputPart[]) {
  return parts.flatMap((part) =>
    part.type === 'mention'
      ? [{ type: 'mention', attrs: { id: part.id, username: part.username, displayName: part.displayName } }]
      : part.type === 'text' ? textNodes(part.text) : [],
  )
}
const editor = useEditor({
  extensions: [Document.extend({ content: 'inline*' }), Text, HardBreak, UndoRedo, Media, Mention],
  // 结构化初始内容优先（#347 草稿恢复：mention chip 挂载即成形，不等事后 setParts）。
  content: { type: 'doc', content: props.initialParts.length ? partsToContent(props.initialParts) : textNodes(props.initialText ?? '') },
  editable: !props.disabled,
  editorProps: {
    attributes: { role: 'textbox', 'aria-label': '消息输入', 'aria-multiline': 'true', 'data-test': 'composer-input', class: 'u-rich-editable' },
    handleKeyDown: (_view, event) => { emit('keydown', event); return event.defaultPrevented },
    handlePaste: (_view, event) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length) { event.preventDefault(); emit('files', files); return true }
      // Paste only plain text. Never accept external image URLs or active HTML.
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text) { insertText(text); return true }
      return true
    },
    handleDrop: (_view, event, _slice, moved) => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!moved && files.length) { event.preventDefault(); emit('files', files); return true }
      return false
    },
  },
  onUpdate: () => notify(),
})
/**
 * 序列化与两套坐标：mention chip 在文档里占 1 个节点，纯文本形态却是 `@username` 多字符
 * （attachment 占 1 序列化 1，坐标恰好重合）。对外（change 的 caret、insertText/insertMention
 * 的 from/to、selection()）一律用序列化文本下标，文档位置只在组件内部换算——否则 caret
 * 偏小会把 `@core:xxx` 切断，@ 浮层在选中后重新弹出、Enter 被截走发不出消息（#347）。
 */
function serializedLength(node: { type: { name: string }; attrs: Record<string, unknown>; text?: string | null }): number {
  return node.type.name === 'mention'
    ? `@${node.attrs.username}`.length
    : node.type.name === 'hardBreak' || node.type.name === 'attachment' ? 1 : node.text?.length ?? 0
}
function serialize() {
  const value: RichInputPart[] = []
  const segments: { textStart: number; docFrom: number; docTo: number }[] = []
  let text = ''
  // Document 是 content:'inline*'，inline 直接挂在 doc 下：文档位置从 0 起（无段落层 +1）。
  let docPos = 0
  editor.value?.state.doc.forEach((node) => {
    const docFrom = docPos
    docPos += node.nodeSize
    const serialized = node.type.name === 'mention' ? `@${node.attrs.username}` : node.type.name === 'attachment' ? '\uFFFC' : node.type.name === 'hardBreak' ? '\n' : node.text ?? ''
    if (node.type.name === 'mention') value.push({ type: 'mention', id: Number(node.attrs.id), username: node.attrs.username, displayName: node.attrs.displayName })
    else if (node.type.name === 'attachment') value.push({ type: 'attachment', id: node.attrs.id })
    else {
      const last = value.at(-1)
      if (last?.type === 'text') last.text += serialized
      else value.push({ type: 'text', text: serialized })
    }
    segments.push({ textStart: text.length, docFrom, docTo: docPos })
    text += serialized
  })
  return { value, text, segments }
}
/** 文档位置 → 序列化下标（caret 用），选区在文档末尾之外时收敛到全文末尾。 */
function caretOf(segments: { textStart: number; docFrom: number; docTo: number }[], textLength: number, from: number): number {
  for (const segment of segments) {
    if (from < segment.docFrom) return segment.textStart
    if (from < segment.docTo) return segment.textStart + (from - segment.docFrom)
  }
  return textLength
}
/** 序列化下标 → 文档位置（insertText/insertMention 的 from/to 换算用），越界收敛到文档末尾。 */
function textToDoc(textPos: number): number {
  const e = editor.value
  if (!e) return 0
  let consumed = 0
  let docPos = 0
  let endDocPos = 0
  let result = -1
  e.state.doc.forEach((node) => {
    const docFrom = docPos
    docPos += node.nodeSize
    const length = serializedLength(node)
    if (result === -1 && textPos <= consumed + length) result = docFrom + (textPos - consumed)
    consumed += length
    endDocPos = docPos
  })
  return result === -1 ? endDocPos : result
}
function notify() {
  const { value, text, segments } = serialize()
  // mention 的纯文本形态是 @username：发送内容、服务端复核、草稿都沿用这个 token。
  emit('change', value, text, caretOf(segments, text.length, editor.value?.state.selection.from ?? 0))
}
function textNodes(text: string) {
  return text.split('\n').flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])])
}
function insertText(text: string, from?: number, to?: number) {
  const e = editor.value
  if (!e || props.disabled) return
  const selection = e.state.selection
  // from/to 是序列化文本下标（对外坐标），先换算成文档位置再下刀。
  e.chain().focus().insertContentAt(
    { from: from === undefined ? selection.from : textToDoc(from), to: to === undefined ? selection.to : textToDoc(to) },
    textNodes(text),
  ).run()
}
function insertAttachment(attrs: { id: string; src: string; name: string; image: boolean }) {
  if (!props.disabled) editor.value?.chain().focus().insertContent({ type: 'attachment', attrs }).run()
}
/** 插入提及 chip（后补一个空格保边界，否则后续输入字符会粘掉 token 的词尾边界）。from/to 同 insertText，是序列化文本下标。 */
function insertMention(mention: { id: number; username: string; displayName: string }, from?: number, to?: number) {
  if (props.disabled || !mention.username) return
  const selection = editor.value?.state.selection
  editor.value?.chain().focus().insertContentAt(
    { from: from === undefined ? selection?.from ?? 0 : textToDoc(from), to: to === undefined ? selection?.to ?? 0 : textToDoc(to) },
    [{ type: 'mention', attrs: mention }, { type: 'text', text: ' ' }],
  ).run()
}
function setText(text: string) {
  const e = editor.value
  if (!e) return
  e.commands.setContent({ type: 'doc', content: textNodes(text) }, { emitUpdate: false })
  // Sending or editing conversations starts a new draft; Undo must not resurrect old private media.
  e.unregisterPlugin('history')
  e.registerPlugin(history())
}
/** 按 part 重建文档（#347 草稿恢复）：text→textNodes、mention→chip。emitUpdate 让 change 正常回填（提及 id、@all 标记由调用方从 parts 重算）。 */
function setParts(parts: RichInputPart[]) {
  const e = editor.value
  if (!e) return
  const content = partsToContent(parts)
  e.commands.setContent({ type: 'doc', content }, { emitUpdate: true })
  // 与 setText 同口径：恢复是换草稿，Undo 不能倒回上一个会话的内容。
  e.unregisterPlugin('history')
  e.registerPlugin(history())
}
function focus() {
  editor.value?.commands.focus()
  // jsdom 对 contenteditable 无真实焦点引擎，TipTap commands.focus() 不落焦点——
  // 测试与极端环境下的 DOM 兑底：真实浏览器中 activeElement 已就位，此举为幂等重入。
  editor.value?.view.dom.focus({ preventScroll: true })
}
/** 对外坐标：返回光标的序列化文本下标（与 change 事件的 caret 同一套）。 */
function selection() {
  const e = editor.value
  if (!e) return 0
  const { segments, text } = serialize()
  return caretOf(segments, text.length, e.state.selection.from)
}
function removeAttachment(id: string) {
  const e = editor.value
  if (!e || props.disabled) return
  e.state.doc.forEach((node, offset) => {
    if (node.type.name === 'attachment' && node.attrs.id === id) e.chain().focus().deleteRange({ from: offset, to: offset + node.nodeSize }).run()
  })
}
watch(() => props.disabled, (disabled) => editor.value?.setEditable(!disabled), { immediate: true })
onBeforeUnmount(() => editor.value?.destroy())
defineExpose({ insertText, insertAttachment, insertMention, setText, setParts, focus, selection, removeAttachment })
</script>
<template>
  <div class="u-rich-input" :data-placeholder="placeholder" :aria-disabled="disabled">
    <EditorContent :editor="editor" />
  </div>
</template>
<style>
.u-rich-input { flex: 1; min-width: 0; border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); background: var(--unself-color-bg); color: var(--unself-color-text); }
.u-rich-input:focus-within { outline: var(--unself-focus-ring); outline-offset: 1px; }
.u-rich-input[aria-disabled="true"] { background: var(--unself-color-surface); }
.u-rich-editable { min-height: var(--unself-touch-target); max-height: 14rem; overflow-y: auto; padding: var(--unself-space-2) var(--unself-space-3); outline: none; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; font-size: var(--unself-font-size-base); }
.u-rich-editable:has(> br:only-child)::before, .u-rich-editable:empty::before { content: attr(data-placeholder); color: var(--unself-color-text-tertiary); pointer-events: none; position: absolute; }
.u-rich-attachment { display: inline-flex; vertical-align: middle; align-items: center; max-width: 8rem; margin: var(--unself-space-1); padding: var(--unself-space-1); border-radius: var(--unself-radius-sm); background: var(--unself-color-surface); cursor: grab; user-select: none; overflow: hidden; }
.u-rich-attachment img { display: block; max-width: 5rem; max-height: 4rem; object-fit: contain; }
.u-rich-attachment.ProseMirror-selectednode { outline: var(--unself-focus-ring); }
.u-rich-attachment span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--unself-font-size-sm); }
/* #347 提及 chip：不可编辑原子，随文字基线排布 */
.u-rich-mention { display: inline; padding: 0 var(--unself-space-1); border-radius: var(--unself-radius-sm); background: var(--unself-color-primary-soft); color: var(--unself-color-primary); user-select: none; }
</style>
