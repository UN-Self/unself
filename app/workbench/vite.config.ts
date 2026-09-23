// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * 外壳 CSP meta 占位（决策 #63/#73，#247；#247b 修订）：
 * 构建期在 index.html 塞入 CSP meta，但 **不含 frame-src**——实测（Chrome 140）
 * meta 与响应头 CSP 取交集且文档解析后 meta 无法放宽，构建期写死 frame-src 'self'
 * 会永久卡死跨域模块（运行期重写救不回来）。frame-src 由壳启动时
 * （挂载任何 iframe 之前）经 installFramePolicy 注入：'self' + 注册表白名单，
 * 拉取失败注入 'self' 基线（fail-closed）。指令清单唯一来源 = BASE_CSP_DIRECTIVES。
 */
import { BASE_CSP_DIRECTIVES } from './web/src/lib/csp-frame'

/**
 * 构建期版本烙印（#287，决策 #80）：build 结束（closeBundle）写 `dist/build-info.json`，
 * 让前端构建路径也烙印。落点在 outDir 上一级（`dist/`），`emptyOutDir` 清不到；
 * 与 build-worker 写同一路径同一键集合（整文件覆盖写）——`pnpm build` 两条路径
 * （build:worker 先、vite 后）谁先谁后都幂等。
 */
function buildInfoStamp(): Plugin {
  const name = 'unself-build-info-stamp'
  let pkgDir: string | undefined
  return {
    name,
    configResolved(resolved) {
      pkgDir = dirname(resolved.root)
    },
    // closeBundle：产物已全部写出；此处抛错会让 vite build 失败（烙印是构建的硬性产出）。
    //
    // 为什么动态 import 且先 register tsx：本包 scripts/build-info.ts 依赖 @unself/contracts
    // （workspace 包，入口内部是**无扩展名**相对导入）。vite 配置文件被 esbuild 打包时裸导入
    // 会外置到 Node 原生解析——Node 原生 TS 不解析无扩展名导入，直接炸在 contracts 内部。
    // tsx 本就是本包脚本运行器（devDependency，非新增依赖），先注册它的解析钩子再加载，
    // tsx CLI（build:worker）与 vitest 两条路都不受影响。
    //
    // 定位用 configResolved 的 root（= web/）上一级锚出包目录，不用相对路径：配置文件
    // 被打包到 node_modules/.vite-temp/ 后 import.meta.url 指向临时目录，相对定位必歪。
    async closeBundle() {
      if (!pkgDir) throw new Error('构建烙印插件未拿到 configResolved（vite 生命周期异常）')
      const { register } = await import('tsx/esm/api')
      register()
      const specifier = pathToFileURL(join(pkgDir, 'scripts', 'build-info.ts')).href
      const { writeBuildInfo } = await import(specifier)
      await writeBuildInfo()
    },
  }
}

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
  // 前端根 = web/（index.html / public/ / src/ 都在里面）；后端在 src/、测试在 test/，同为这个包。
  root: 'web',
  plugins: [vue(), tailwindcss(), shellCspMeta(), buildInfoStamp()],
  // 产物落 dist/web：dist/ 下另有 dist/worker.js（core Worker bundle，见 scripts/build-worker.ts）。
  // emptyOutDir 只清自己那层，不动 dist/worker.js。
  build: { outDir: '../dist/web', emptyOutDir: true },
  test: {
    // #83：行为断言化后不再需要 css 级联（#75 getComputedStyle 类断言已退场）
    // #303：一个包两个半边——后端测试在 test/（node 环境），前端测试与源码同目录
    // （逐文件 `// @vitest-environment jsdom` 声明）。test.root 回到包根，两边都收。
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
  },
})
