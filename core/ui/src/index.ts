// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @unself/ui 共享基元（PRODUCT_SPEC §6.5「基元内聚」）：
 * 自包含、无外部样式依赖——样式只取设计令牌（tokens.css 的 CSS 自定义属性）。
 * 组件查找序已执行：beUI（React/motion，无 Vue 等价动效可移植）→
 * shadcn-vue（需引入 reka-ui 依赖树）→ 本包手写；Vue 动效通过 @vueuse/motion
 * 接入，参数统一来自契约令牌，符合 M0 亮色单主题约定。
 */

export { UI_VERSION } from './version';
export { default as UButton } from './button.vue';
export { default as UInput } from './input.vue';
export { default as UCard } from './card.vue';
export { default as UErrorCard } from './error-card.vue';
export { default as USkeleton } from './skeleton.vue';
export { default as USwitch } from './switch.vue';
export { default as UDrawCheck } from './draw-check.vue';
export { default as UMotionSelect } from './motion-select.vue';
export type { SelectOption, UMotionSelectProps } from './motion-select-types';
export { default as UChoiceCardGroup } from './choice-card.vue';
export type { ChoiceCardOption, UChoiceCardGroupProps } from './choice-card-types';
export { default as UActivity } from './activity.vue';
export type { ActivityLine, ActivityGroup } from './activity-types';
export { default as UStepper } from './stepper.vue';
export type { StepperStep } from './stepper-types';
export { default as UBanner } from './banner.vue';
export { default as UResultCard } from './result-card.vue';
export { default as UStepProgress } from './step-progress.vue';
export type { StepSegment } from './step-progress-types';
export { liftFadeVariants, panelVariants, popVariants, prefersReducedMotion, motionAvailable, resetMotionCache } from './motion';
export type { TokenVariants } from './motion';
