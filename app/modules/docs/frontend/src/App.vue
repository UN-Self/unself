<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * docs 模块应用壳（D7）：会话握手 → 列表页 ⇄ 编辑器。
 *
 * 这一层只做三件事：拿 token、在列表与编辑器之间切换、把失败兑成人话。
 * 列表逻辑在 lib/docs-list-state.ts，编辑逻辑在 lib/use-docs-editor.ts，
 * 两个状态机都已有独立用例，这里不重复测。
 *
 * 后端现状：D5（REST 业务）未落地时，app.ts 的业务体是显式 501。为了让界面能在
 * 真实模块页里打开并自证渲染，dev 态可用 VITE_DOCS_MOCK=1 切到内存 mock；
 * 生产构建里这条分支被常量折叠剔除（import.meta.env.DEV 为 false）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import DocsEditor from './components/DocsEditor.vue'
import DocsList from './components/DocsList.vue'
import { DocsApiError, createHttpDocsApi, type DocsApi } from './lib/docs-api'
import { createHttpDocsListApi, type DocsListApi } from './lib/docs-list-api'
import { createMockDocsApi } from './lib/docs-api-mock'
import {
  applyAppended,
  applyCreated,
  applyDeleteFailed,
  applyDeleted,
  applyLoadFailed,
  applyLoaded,
  beginDelete,
  beginLoad,
  beginRefresh,
  canLoadMore,
  createListState,
  PAGE_LIMIT,
  type ListState,
} from './lib/docs-list-state'
import { createDocsSession, HANDSHAKE_TIMEOUT_MS, type DocsSession } from './lib/docs-session'
import type { Doc } from './lib/docs-types'

/** 当前视图：列表 or 某一篇文档。 */
type View = { kind: 'list' } | { kind: 'editor'; id: string }

const session = ref<DocsSession | null>(null)
const token = ref<string | null>(null)
const meId = ref('')
const handshakeState = ref<'pending' | 'ready' | 'failed'>('pending')
const handshakeError = ref('')

const listState = ref<ListState>(createListState())
const view = ref<View>({ kind: 'list' })
const currentDoc = ref<Doc | null>(null)
const editorLoading = ref(false)
const editorError = ref('')

/** dev 态可用 mock 自证渲染；生产构建里这段被常量折叠掉。 */
const useMock = import.meta.env.DEV && import.meta.env.VITE_DOCS_MOCK === '1'

const docsApi: DocsApi = useMock
  ? createMockDocsApi()
  : createHttpDocsApi({ getToken: () => token.value })

const listApi: DocsListApi = useMock
  ? mockListApi()
  : createHttpDocsListApi({ getToken: () => token.value })

/** mock 态：列表与编辑器共享同一份内存数据，避免两个 mock 各说各话。 */
function mockListApi(): DocsListApi {
  const mock = docsApi as ReturnType<typeof createMockDocsApi>
  return {
    async listDocs() {
      return { items: [mock.current()], hasMore: false }
    },
    async createDoc() {
      return mock.current()
    },
    async deleteDoc() {
      throw new DocsApiError('forbidden', 403)
    },
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof DocsApiError) {
    if (error.code === 'not_implemented') return '后端接口还没实现（D5 未落地）。'
    return `请求失败：${error.code}`
  }
  return '网络不可用，请稍后重试。'
}

async function loadFirstPage(): Promise<void> {
  listState.value = beginLoad(listState.value)
  try {
    const page = await listApi.listDocs({ limit: PAGE_LIMIT, offset: 0 })
    listState.value = applyLoaded(listState.value, page)
  } catch (error) {
    listState.value = applyLoadFailed(
      listState.value,
      error instanceof DocsApiError ? error.code : 'unknown',
    )
  }
}

async function loadMore(): Promise<void> {
  if (!canLoadMore(listState.value)) return
  listState.value = beginLoad(listState.value)
  try {
    const page = await listApi.listDocs({
      limit: PAGE_LIMIT,
      offset: listState.value.nextOffset,
    })
    listState.value = applyAppended(listState.value, page)
  } catch (error) {
    listState.value = applyLoadFailed(
      listState.value,
      error instanceof DocsApiError ? error.code : 'unknown',
    )
  }
}

async function createDoc(): Promise<void> {
  try {
    const doc = await listApi.createDoc({ title: '未命名文档' })
    listState.value = applyCreated(listState.value, doc)
    await openDoc(doc.id)
  } catch (error) {
    listState.value = applyLoadFailed(
      listState.value,
      error instanceof DocsApiError ? error.code : 'unknown',
    )
  }
}

async function deleteDoc(id: string): Promise<void> {
  listState.value = beginDelete(listState.value, id)
  try {
    await listApi.deleteDoc(id)
    listState.value = applyDeleted(listState.value, id)
  } catch (error) {
    listState.value = applyDeleteFailed(
      listState.value,
      id,
      error instanceof DocsApiError ? error.code : 'unknown',
    )
  }
}

async function openDoc(id: string): Promise<void> {
  view.value = { kind: 'editor', id }
  currentDoc.value = null
  editorError.value = ''
  editorLoading.value = true
  try {
    currentDoc.value = await docsApi.getDoc(id)
  } catch (error) {
    editorError.value = errorMessageOf(error)
  } finally {
    editorLoading.value = false
  }
}

function backToList(): void {
  // 离开编辑器前确认未保存内容：编辑器组件卸载即丢草稿，先问一句再走。
  if (!globalThis.confirm('返回列表？编辑器里未保存的修改会丢失。')) return
  view.value = { kind: 'list' }
  currentDoc.value = null
  // 有数据时原地刷新，不切骨架（避免整页闪空）
  listState.value = beginRefresh(listState.value)
  void refresh()
}

/** 返回列表后的刷新：保留已有条目，失败只报错不清空。 */
async function refresh(): Promise<void> {
  try {
    const page = await listApi.listDocs({ limit: PAGE_LIMIT, offset: 0 })
    listState.value = applyLoaded(listState.value, page)
  } catch (error) {
    listState.value = applyLoadFailed(
      listState.value,
      error instanceof DocsApiError ? error.code : 'unknown',
    )
  }
}

const listVisible = computed(() => view.value.kind === 'list')

onMounted(async () => {
  const created = createDocsSession({ moduleId: 'docs' })
  session.value = created
  try {
    await created.handshake(HANDSHAKE_TIMEOUT_MS)
    token.value = created.getToken()
    meId.value = created.getUserId()
    handshakeState.value = 'ready'
    await loadFirstPage()
  } catch (error) {
    handshakeState.value = 'failed'
    handshakeError.value = error instanceof Error ? error.message : '连接失败'
  }
})

onBeforeUnmount(() => {
  session.value?.dispose()
})
</script>

<template>
  <main class="docs-app">
    <div v-if="handshakeState === 'pending'" class="center" data-test="handshake-pending">
      正在连接工作台…
    </div>

    <div v-else-if="handshakeState === 'failed'" class="center" data-test="handshake-failed" role="alert">
      <p class="fail-title">无法打开文档模块</p>
      <p class="fail-message">{{ handshakeError }}</p>
      <p class="fail-hint">请刷新页面；若持续失败，联系管理员检查模块接入。</p>
    </div>

    <template v-else>
      <DocsList
        v-if="listVisible"
        :state="listState"
        :me-id="meId"
        @open="openDoc"
        @create="createDoc"
        @delete="deleteDoc"
        @retry="loadFirstPage"
        @load-more="loadMore"
      />

      <section v-else class="editor-view">
        <button type="button" class="u-btn u-btn-ghost u-btn-sm back" data-test="back-to-list" @click="backToList">
          ← 返回列表
        </button>

        <p v-if="editorLoading" class="center" data-test="editor-loading">正在打开文档…</p>
        <p v-else-if="editorError" class="center error" role="alert" data-test="editor-error">
          {{ editorError }}
        </p>
        <DocsEditor v-else-if="currentDoc" :doc="currentDoc" :api="docsApi" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.docs-app {
  height: 100%;
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
}
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--unself-space-2);
  height: 100%;
  margin: 0;
  padding: var(--unself-space-6);
  text-align: center;
  color: var(--unself-color-text-secondary);
}
.fail-title {
  margin: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.fail-message {
  margin: 0;
}
.fail-hint {
  margin: 0;
  font-size: var(--unself-font-size-sm);
}
.error {
  color: var(--unself-color-danger);
}
.editor-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.back {
  align-self: flex-start;
  margin: var(--unself-space-3) var(--unself-space-4) 0;
}
</style>
