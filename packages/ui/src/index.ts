// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @unself/ui 共享基元（PRODUCT_SPEC §6.5「基元内聚」）：
 * 自包含、无外部样式依赖——样式只取设计令牌（tokens.css 的 CSS 自定义属性）。
 * 组件查找序已执行：beUI（React/motion，无 Vue 等价动效可移植）→
 * shadcn-vue（需引入 reka-ui 依赖树）→ 本包手写，动效从简（transition，
 * 无 motion 库），符合 M0 亮色单主题约定。
 */

export { UI_VERSION } from './version';
export { default as UButton } from './button.vue';
export { default as UInput } from './input.vue';
export { default as UCard } from './card.vue';
export { default as UErrorCard } from './error-card.vue';
export { default as USkeleton } from './skeleton.vue';
