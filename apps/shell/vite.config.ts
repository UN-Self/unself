// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 外壳 CSP meta 占位（决策 #63/#73，#247；#247b 修订）：
 * 构建期在 index.html 塞入 CSP meta，但 **不含 frame-src**——实测（Chrome 140）
 * meta 与响应头 CSP 取交集且文档解析后 meta 无法放宽，构建期写死 frame-src 'self'
 * 会永久卡死跨域模块（运行期重写救不回来）。frame-src 由壳启动时
 * （挂载任何 iframe 之前）经 installFramePolicy 注入：'self' + 注册表白名单，
 * 拉取失败注入 'self' 基线（fail-closed）。指令清单唯一来源 = BASE_CSP_DIRECTIVES。
 */
import { BASE_CSP_DIRECTIVES } from './src/lib/csp-frame'

function shellCspMeta(): Plugin {
  const name = 'unself-shell-csp-meta'
  return {
    name,
    transformIndexHtml(html) {
      const csp = BASE_CSP_DIRECTIVES.join('; ')
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), shellCspMeta()],
  test: {
    // #83：行为断言化后不再需要 css 级联（#75 getComputedStyle 类断言已退场）
  },
})
