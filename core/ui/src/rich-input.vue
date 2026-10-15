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

const props = withDefaults(defineProps<{ disabled?: boolean; placeholder?: string; initialText?: string }>(), { disabled: false, placeholder: '输入消息…' })
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
const editor = useEditor({
  extensions: [Document.extend({ content: 'inline*' }), Text, HardBreak, UndoRedo, Media],
  content: { type: 'doc', content: textNodes(props.initialText ?? '') },
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
function parts(): RichInputPart[] {
  const result: RichInputPart[] = []
  editor.value?.state.doc.forEach((node) => {
    if (node.type.name === 'attachment') result.push({ type: 'attachment', id: node.attrs.id })
    else {
      const text = node.type.name === 'hardBreak' ? '\n' : node.text ?? ''
      const last = result.at(-1)
      if (last?.type === 'text') last.text += text
      else result.push({ type: 'text', text })
    }
  })
  return result
}
function notify() {
  const value = parts()
  emit('change', value, value.map(p => p.type === 'text' ? p.text : '\uFFFC').join(''), editor.value?.state.selection.from ?? 0)
}
function textNodes(text: string) {
  return text.split('\n').flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])])
}
function insertText(text: string, from?: number, to?: number) {
  const e = editor.value
  if (!e || props.disabled) return
  const selection = e.state.selection
  e.chain().focus().insertContentAt({ from: from ?? selection.from, to: to ?? selection.to }, textNodes(text)).run()
}
function insertAttachment(attrs: { id: string; src: string; name: string; image: boolean }) {
  if (!props.disabled) editor.value?.chain().focus().insertContent({ type: 'attachment', attrs }).run()
}
function setText(text: string) {
  const e = editor.value
  if (!e) return
  e.commands.setContent({ type: 'doc', content: textNodes(text) }, { emitUpdate: false })
  // Sending or changing conversations starts a new draft; Undo must not resurrect old private media.
  e.unregisterPlugin('history')
  e.registerPlugin(history())
}
function focus() {
  editor.value?.commands.focus()
  // jsdom 对 contenteditable 无真实焦点引擎，TipTap commands.focus() 不落焦点——
  // 测试与极端环境下的 DOM 兑底：真实浏览器中 activeElement 已就位，此举为幂等重入。
  editor.value?.view.dom.focus({ preventScroll: true })
}
function selection() { return editor.value?.state.selection.from ?? 0 }
function removeAttachment(id: string) {
  const e = editor.value
  if (!e || props.disabled) return
  e.state.doc.forEach((node, offset) => {
    if (node.type.name === 'attachment' && node.attrs.id === id) e.chain().focus().deleteRange({ from: offset, to: offset + node.nodeSize }).run()
  })
}
watch(() => props.disabled, (disabled) => editor.value?.setEditable(!disabled), { immediate: true })
onBeforeUnmount(() => editor.value?.destroy())
defineExpose({ insertText, insertAttachment, setText, focus, selection, removeAttachment, parts })
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
</style>
