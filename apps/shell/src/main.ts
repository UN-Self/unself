// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import { RouterView } from 'vue-router'
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
 */
async function boot(): Promise<void> {
  await installFramePolicy(document)
  createApp(RouterView).use(router).mount('#app')
}

void boot()
