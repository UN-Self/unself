// SPDX-License-Identifier: AGPL-3.0-only
import { createApp, h, type Component } from 'vue'
import { RouterView } from 'vue-router'
import { Transition } from 'vue'
import { router } from './router'
import { installFramePolicy } from './lib/csp-frame'
import './styles.css'
import './tokens.css'

/**
 * 壳启动顺序（#247b 竞态修复，实测Chrome 140：meta CSP 解析后不可放宽）：
 * ①拉注册表白名单、把最终 frame-src 注入 meta（失败注入 'self' 基线，fail-closed）；
 * ②才 mount 应用——ModuleHost 首建的跨域 iframe 立即受白名单约束，不存在「先建后宽」。
 * 首帧代价：白名单往返串行在 mount 前（本地 API 亚毫秒级，可接受；
 * 超时/失败路径同样快速回落基线，不白屏）。
 *
 * #265：导出 boot 供顺序守卫测试调用**真实引导路径**（不再由测试重演顺序）。
 * 自动启动仅在浏览器入口执行：测试 import 本模块不得产生 mount 副作用。
 */
export async function boot(): Promise<void> {
  await installFramePolicy(document)
  // #307 ③导航层：整页路由切换 fade+slide(8px)（transitions.dev page transition），
  // mode="out-in" 防两页交叠；类名落在根组件最外层元素上（各视图均为单根）。
  createApp({
    render: () =>
      h(RouterView, null, {
        default: ({ Component }: { Component: Component | null }) =>
          h(Transition, { name: 'page', mode: 'out-in' }, { default: () => Component }),
      }),
  })
    .use(router)
    .mount('#app')
}

// 真实浏览器入口自动启动；VITEST 下由测试显式调用 boot（避免 import 即 mount）。
if (!import.meta.env.VITEST) {
  void boot()
}
