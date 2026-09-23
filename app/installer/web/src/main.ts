// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 向导 SPA 入口：**主题先于应用**。
 * 顺序：注入 themeVars（/api/meta，唯一真源 = core/contracts theme-tokens.json）→
 * 失败渲染明确反馈（不静默裸样式）→ 成功才挂载 app（v-motion 变体解析因此拿得到令牌）。
 */
import { createApp, h } from 'vue';
import App from './app';
import { loadTheme } from './lib/theme';
import './styles.css';

const root = document.getElementById('app');

async function bootstrap(): Promise<void> {
  const theme = await loadTheme();
  if (!theme.ok || !root) {
    // 明确反馈：主题/服务不可用 ≠ 裸样式白屏（含失败原因，行动可指向）
    if (root) {
      createApp({
        render: () =>
          h('div', { class: 'bootstrap-failure', role: 'alert' }, [
            h('p', { class: 'bootstrap-failure-title' }, '向导启动失败'),
            h('p', { class: 'bootstrap-failure-detail' }, theme.problem || '应用挂载点缺失'),
            h('p', { class: 'bootstrap-failure-hint' }, '请回到启动向导的终端检查服务是否存活，然后刷新本页。'),
          ]),
      }).mount(root);
    }
    return;
  }
  createApp(App).mount(root);
}

bootstrap();
