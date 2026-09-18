// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 外壳 CSP frame-src 动态注入（决策 #63/#73，#247）：
 * 构建期在 index.html 塞入 CSP meta 占位（frame-src 'self'），
 * 运行期壳启动时拉 /api/modules/frame-origins（注册表白名单）就地重写——
 * 加模块只改注册表，不重建外壳；构建无配置无环境依赖（确定性）。
 */
function shellCspMeta(): Plugin {
  const name = 'unself-shell-csp-meta'
  return {
    name,
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; ')
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
