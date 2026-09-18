// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 外壳 CSP frame-src 挂载前注入（决策 #63/#73，#247；#247b 修订）。
 *
 * 实测机制（Chrome 140，有头 E2E，#247b）：
 * 1. meta CSP 与响应头 CSP **取交集**（各自独立约束，取最严格组合）；
 * 2. 文档解析完成后 meta 的 frame-src **不可放宽**——运行期重写 meta 对后续创建的
 *    frame 是 no-op（securitypolicyviolation 的 originalPolicy 始终是解析期基线）。
 * 因此「构建期 meta 写死 frame-src 'self' + 运行期收紧」这条路对跨域 iframe 必然死锁：
 * 首个跨域 frame 被基线拦掉且永不重试。唯一正确顺序是 **挂载前** 把最终 frame-src
 * 注入 meta：'self' + 注册表白名单；拉取失败注入 'self' 基线（fail-closed 不放宽）。
 *
 * 响应头侧（core Worker withHtmlSecurityHeaders / 反代）仍带权威白名单头，
 * 与 meta 一致；meta 只是离线兜底（无响应头时的静态托管场景）。
 */

/** 构建 meta 占位的指令清单：**不含 frame-src**（运行期由 installFramePolicy 注入）。
 * 唯一来源：vite shellCspMeta 与运行期共用，杜绝两处清单漂移。 */
export const BASE_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]

/**
 * 壳 CSP meta 的唯一锚点：vite 构建注入的是 http-equiv 形态（index.html 首个 meta），
 * 选择器必须与之一致（用 name 形态会找不到 → 白名单永远不生效）。
 */
const CSP_META_SELECTOR = 'meta[http-equiv="Content-Security-Policy" i]'

/** meta[http-equiv=CSP] 的当前 frame-src 指令解析：无 meta / 无 frame-src → null。 */
export function frameSrcFromMeta(doc: Document): string | null {
  const meta = doc.querySelector<HTMLMetaElement>(CSP_META_SELECTOR)
  if (!meta) return null
  const csp = meta.getAttribute('content') ?? ''
  for (const part of csp.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith('frame-src')) return trimmed
  }
  return null
}

/** origin 合法性：必须 http(s) 绝对 origin 形态（坏值丢弃——宁可窄不可宽）。 */
function validOrigin(o: string): boolean {
  try {
    const url = new URL(o)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === o
  } catch {
    return false
  }
}

/**
 * 把最终 frame-src 指令（'self' + origins，去重）注入 CSP meta：
 * meta 已含 frame-src → 原位替换；不含 → 追加到 content 末尾。
 * meta 缺失时返回 null（不动文档——生产 meta 由 vite 注入，缺失属装配异常）。
 */
export function installFrameSrcInMeta(doc: Document, origins: string[]): string | null {
  const meta = doc.querySelector<HTMLMetaElement>(CSP_META_SELECTOR)
  if (!meta) return null
  const merged = [...new Set(["'self'", ...origins.filter(validOrigin)])].join(' ')
  const directive = `frame-src ${merged}`
  const csp = meta.getAttribute('content') ?? ''
  const parts = csp.split(';')
  let found = false
  const next = parts
    .map((part) => {
      const trimmed = part.trim()
      if (trimmed.startsWith('frame-src')) {
        found = true
        return directive
      }
      return part
    })
    .filter((part) => part !== '')
    .join(';')
  const content = found ? next : (csp === '' ? directive : `${next};${directive}`)
  meta.setAttribute('content', content)
  return content
}

/**
 * 挂载前注入最终 frame-src 到 meta（#247b 竞态修复主入口）：
 * 必须在 mount / 创建任何 iframe **之前** await 完成。
 * 白名单：'self' + /api/modules/frame-origins；拉取失败/非 200/形状错 → 'self' 基线
 * （fail-closed：注入窄值，跨域模块加载失败属模块异常卡范畴，绝不放宽）。
 * 返回注入的 meta content（诊断用）。
 */
export async function installFramePolicy(doc: Document): Promise<string | null> {
  let origins: string[] = []
  try {
    const res = await fetch('/api/modules/frame-origins')
    if (res.ok) {
      const body = (await res.json()) as unknown
      if (Array.isArray(body)) origins = body.filter((o): o is string => typeof o === 'string')
    }
  } catch {
    // 白名单不可得 = 维持 'self' 基线
  }
  return installFrameSrcInMeta(doc, origins)
}
