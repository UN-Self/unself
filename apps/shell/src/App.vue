// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildNav, type NavItem } from './lib/nav'

// M0 stub：模块清单暂时硬编码，后续由 @unself/contracts manifest 下发
const modulesStub = [{ id: 'Hello', enabled: true }]
const nav = buildNav(modulesStub)

// 侧边栏：固定“工作台”（buildNav 保证在最前）+ 壳内固定“管理” + enabled 动态模块项
const adminItem: NavItem = { id: '管理', label: '管理' }
const sidebar: NavItem[] = [...nav.slice(0, 1), adminItem, ...nav.slice(1)]

// 固定视图不装载模块 iframe，显示占位
const HOST_VIEW_IDS = new Set(['工作台', '管理'])

const selectedId = ref('工作台')
const activeModule = computed(() =>
  HOST_VIEW_IDS.has(selectedId.value) ? null : selectedId.value,
)
</script>

<template>
  <div class="flex h-screen flex-col">
    <!-- 顶部：实例标题 -->
    <header class="flex h-12 shrink-0 items-center border-b border-gray-200 px-4">
      <h1 class="text-lg font-semibold">Unself</h1>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- 左侧边栏 -->
      <aside class="w-48 shrink-0 overflow-y-auto border-r border-gray-200 p-2">
        <nav class="space-y-1">
          <button
            v-for="item in sidebar"
            :key="item.id"
            type="button"
            class="w-full rounded px-3 py-1.5 text-left hover:bg-gray-100"
            :class="selectedId === item.id ? 'bg-gray-200' : ''"
            @click="selectedId = item.id"
          >
            {{ item.label }}
          </button>
        </nav>
      </aside>

      <!-- 主区 -->
      <main class="flex-1 overflow-hidden">
        <div
          v-if="activeModule === null"
          class="flex h-full items-center justify-center text-gray-400"
        >
          占位：未选择模块
        </div>
        <!-- M0：动态模块经 /m/:id/ iframe 装载；下一步在此接入 @unself/module-sdk 握手（postMessage 换模块 token） -->
        <iframe
          v-else
          :src="`/m/${activeModule}/`"
          class="h-full w-full border-0"
          :title="`module:${activeModule}`"
        ></iframe>
      </main>
    </div>
  </div>
</template>
