// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块 iframe 生命周期 composable（#83 壳拆分）：
 * 模块（RegistryModule | null）变化 → 拆旧桥 → 握手态 → 挂桥等 ready → token 成功转 ready；
 * 入口配置无效 / token 失败 / 15s 超时 → failed；retry 自增 frameReload 强制 iframe 重挂（#71 根因 2）。
 * 纯行为，不碰样式；视图渲染归 ModuleHost.vue，壳布局归 App.vue。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { attachModuleBridge, frameOriginFor, type BridgeHandle } from './module-bridge'
import { attachFrameTokens } from './frame-tokens'
import { currentThemeTokens } from './theme'
import { moduleFrameSrc, type RegistryModule } from './registry-api'
import type { ApiError } from './token-api'

export type FrameState = 'idle' | 'handshaking' | 'ready' | 'failed'

/** 握手超时（§6.5 异常卡：加载中骨架 → 失败卡）。 */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * 壳侧握手诊断号前缀（#306）：超时/本地失败没有服务端响应，也就没有 x-request-id。
 * 壳自己发一个短号给用户，报障时能对上「哪一次装载」——`UErrorCard` 的 requestId 位
 * 对成员只承诺「可报障的编号」，来源是服务端还是壳不重要，但绝不能缺位。
 */
const SHELL_HANDSHAKE_ID_PREFIX = 'mh-'

/** 生成壳侧握手诊断号（时间戳 base36 + 随机尾，够区分同一次会话内的装载）。 */
export function makeHandshakeRequestId(): string {
  const stamp = Date.now().toString(36)
  const tail = Math.random().toString(36).slice(2, 8)
  return `${SHELL_HANDSHAKE_ID_PREFIX}${stamp}-${tail}`
}

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
  /** 通道 A（§6.5.5）直注句柄：与桥同生命周期，detach 拆掉旧 iframe 的 load 监听。 */
  let frameTokens: { detach: () => void } | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined

  function detachBridge() {
    bridge?.detach()
    bridge = null
  }

  function detachFrameTokens() {
    frameTokens?.detach()
    frameTokens = null
  }

  /** 停表（进任何终态或换模块都必须调用；漏调 = 上一轮定时器把新状态误判超时）。 */
  function clearHandshakeTimer() {
    clearTimeout(handshakeTimer)
    handshakeTimer = undefined
  }

  /**
   * 交到失败态（唯一出口）：停表 + 落错误对象（requestId 已由调用方给全）。
   * 失败卡因此永不出现「有人话、无编号」的半截现场（#306 验收）。
   */
  function failFrame(error: ApiError | Error): void {
    clearHandshakeTimer()
    frameError.value = error
    frameState.value = 'failed'
  }

  /**
   * 进入握手态（唯一入口）：状态与超时定时器**在同一次调用里**绑定。
   *
   * #306 根因：旧实现把「进 handshaking」放在按 module 的 watch 回调里、把「上定时器」
   * 放在另一个 watch([module, frameState]) 里。首次挂载时前者（flush post + immediate）
   * 在 setup 期间同步把 state 置为 handshaking，而后者当时还没注册——pre-flush 的它
   * 永远看不到 idle→handshaking 这次跃迁，定时器从未上过表：`ready` 缺失时骨架永久滞留，
   * 15s 兜底形同虚设（正是 probe304 现场）。两者合并后，任何进入握手的路径都必然带表。
   */
  function enterHandshaking(): void {
    clearHandshakeTimer()
    frameState.value = 'handshaking'
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined
      if (frameState.value !== 'handshaking') return
      const error = Error('模块加载超时，请稍后重试') as ApiError
      // status 0 = 本地/网络不可达语义（与 api-client 的 NETWORK_UNAVAILABLE 同口径），
      // 不冒充服务端状态码；requestId 由壳发放，供成员报障引用。
      error.status = 0
      error.requestId = makeHandshakeRequestId()
      failFrame(error)
    }, HANDSHAKE_TIMEOUT_MS)
  }

  /** 交到就绪态（唯一出口）：停表——迟到的超时回调不得再翻状态。 */
  function readyFrame(): void {
    clearHandshakeTimer()
    frameState.value = 'ready'
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
      detachFrameTokens()
      clearHandshakeTimer()
      frameError.value = null
      if (!mod) {
        frameState.value = 'idle'
        return
      }
      enterHandshaking()
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
      const error = Error('模块入口配置无效，请联系管理员') as ApiError
      error.status = 0
      error.requestId = makeHandshakeRequestId()
      failFrame(error)
      return
    }
    const iframe = await waitForFrameEl()
    if (!iframe) return
    // 等待期间用户可能已切换模块：交给新模块的 watch 处理
    if (module.value !== mod) return
    detachBridge()
    detachFrameTokens()
    const tokens = currentThemeTokens()
    bridge = attachModuleBridge({
      iframe,
      moduleId: mod.id,
      frameOrigin: origin,
      tokens,
      onToken: () => {
        readyFrame()
      },
      onError: (err) => {
        failFrame(err)
      },
    })
    // 通道 A（§6.5.5）：同源模块直注 style#unself-tokens；跨域返回 null 走通道 B，不记句柄
    frameTokens = attachFrameTokens(iframe, tokens)
  }

  /**
   * 手动重试：强制 iframe 重挂（frameReload 自增 → key 变化 → 新 iframe 重新发 ready），
   * 重挂后对新 iframe 重新挂桥——旧消息不再丢失（#71 根因 2）。
   */
  async function retryFrame(): Promise<void> {
    const mod = module.value
    if (!mod) return
    frameError.value = null
    enterHandshaking()
    detachBridge()
    detachFrameTokens()
    frameReload.value += 1
    await nextTick()
    await attachBridgeFor(mod)
  }

  onBeforeUnmount(() => {
    detachBridge()
    detachFrameTokens()
    clearHandshakeTimer()
  })

  return { frameState, frameError, frameSrc, frameKey, frameEl, retryFrame }
}
