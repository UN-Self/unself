// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块 iframe 生命周期 composable（#83 壳拆分）：
 * 模块（RegistryModule | null）变化 → 拆旧桥 → 握手态 → 挂桥等 ready → token 成功转 ready；
 * 入口配置无效 / token 失败 / 15s 超时 → failed；retry 自增 frameReload 强制 iframe 重挂（#71 根因 2）。
 * 纯行为，不碰样式；视图渲染归 ModuleHost.vue，壳布局归 App.vue。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { attachModuleBridge, frameOriginFor, type BridgeHandle } from './module-bridge'
import { moduleFrameSrc, type RegistryModule } from './registry-api'
import type { ApiError } from './token-api'

export type FrameState = 'idle' | 'handshaking' | 'ready' | 'failed'

/** 握手超时（§6.5 异常卡：加载中骨架 → 失败卡）。 */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * 停用判定：token 接口 403（token-api 已带 status）为唯一真值，
 * 禁 frameError.message.includes('停用') 字符串嗅探（#83）。
 */
export function isDisabledFrameError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const status = (err as { status?: unknown }).status
  return status === 403
}

/**
 * 装载模块 iframe 的生命周期状态机。
 * @param module 当前选中模块（null = 壳内工作台视图，iframe 卸载）。
 */
export function useModuleFrame(module: Ref<RegistryModule | null>) {
  const frameState = ref<FrameState>('idle')
  const frameError = ref<ApiError | Error | null>(null)
  /** 重挂计数（#71 根因 2）：retry 自增 → frameKey 变化 → iframe 按 key 重挂 → SDK 重新发 ready。 */
  const frameReload = ref(0)
  /** iframe 模板 ref：挂载/重挂期间会短暂为空，挂桥前必须确认就位。 */
  const frameEl = ref<HTMLIFrameElement | null>(null)

  const frameSrc = computed(() => (module.value ? moduleFrameSrc(module.value) : null))
  const frameKey = computed(() => `${module.value?.id ?? 'none'}#${frameReload.value}`)

  let bridge: BridgeHandle | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined

  function detachBridge() {
    bridge?.detach()
    bridge = null
  }

  function clearHandshakeTimer() {
    clearTimeout(handshakeTimer)
    handshakeTimer = undefined
  }

  /**
   * 模块激活即挂桥（#71 根因 2）。immediate：宿主以「module 已就绪」姿态首次挂载时
   * （如从工作台视图切回、或初始落地即选中模块）也需入握手 → 挂桥；
   * flush 'post' 保证回调在 DOM 更新（iframe 挂载）之后执行；
   * 回调内再等一拍取 frameEl；若仍未挂载则等模板 ref 就位，不再静默判 failed。
   */
  watch(
    module,
    async (mod) => {
      detachBridge()
      clearHandshakeTimer()
      frameError.value = null
      if (!mod) {
        frameState.value = 'idle'
        return
      }
      frameState.value = 'handshaking'
      await nextTick()
      await attachBridgeFor(mod)
    },
    { flush: 'post', immediate: true },
  )

  /** 等 iframe 模板 ref 就位（首次挂载/重挂）；模块切换或组件卸载后返回 null。 */
  function waitForFrameEl(): Promise<HTMLIFrameElement | null> {
    if (frameEl.value) return Promise.resolve(frameEl.value)
    return new Promise((resolve) => {
      let stopFrame = () => {}
      const stopActive = watch(module, () => {
        stopFrame()
        resolve(null)
      })
      stopFrame = watch(frameEl, (el) => {
        if (el) {
          stopActive()
          stopFrame()
          resolve(el)
        }
      })
    })
  }

  /**
   * 给模块挂桥（watch 与 retry 共用，避免两处漂移）：
   * 仅入口配置无效（frameOriginFor 为 null）才判 failed；iframe 未挂载则等挂载后再挂。
   */
  async function attachBridgeFor(mod: RegistryModule): Promise<void> {
    const origin = frameOriginFor(mod.manifest?.entry ?? null)
    if (origin === null) {
      frameError.value = new Error('模块入口配置无效，请联系管理员')
      frameState.value = 'failed'
      return
    }
    const iframe = await waitForFrameEl()
    if (!iframe) return
    // 等待期间用户可能已切换模块：交给新模块的 watch 处理
    if (module.value !== mod) return
    detachBridge()
    bridge = attachModuleBridge({
      iframe,
      moduleId: mod.id,
      frameOrigin: origin,
      onToken: () => {
        frameState.value = 'ready'
      },
      onError: (err) => {
        frameError.value = err
        frameState.value = 'failed'
      },
    })
  }

  // 15s 握手超时（§6.5 异常卡：加载中骨架 → 失败卡）
  watch([module, frameState], ([, state]) => {
    clearHandshakeTimer()
    if (state === 'handshaking') {
      handshakeTimer = setTimeout(() => {
        if (frameState.value === 'handshaking') {
          frameError.value = new Error('模块加载超时，请稍后重试')
          frameState.value = 'failed'
        }
      }, HANDSHAKE_TIMEOUT_MS)
    }
  })

  /**
   * 手动重试：强制 iframe 重挂（frameReload 自增 → key 变化 → 新 iframe 重新发 ready），
   * 重挂后对新 iframe 重新挂桥——旧消息不再丢失（#71 根因 2）。
   */
  async function retryFrame(): Promise<void> {
    const mod = module.value
    if (!mod) return
    frameError.value = null
    frameState.value = 'handshaking'
    detachBridge()
    frameReload.value += 1
    await nextTick()
    await attachBridgeFor(mod)
  }

  onBeforeUnmount(() => {
    detachBridge()
    clearHandshakeTimer()
  })

  return { frameState, frameError, frameSrc, frameKey, frameEl, retryFrame }
}
