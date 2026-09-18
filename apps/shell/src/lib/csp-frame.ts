// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 外壳 CSP 动态收紧（决策 #63/#73，#247）：
 * index.html 内置 CSP meta（frame-src 'self' 基线，vite 构建期注入）；
 * 壳启动时拉 /api/modules/frame-origins（注册表白名单）重写 meta——
 * 加模块只改注册表，不重建外壳。这是 HTTP 头白名单的浏览器侧兜底补位
 * （真正权威的响应头由 core Worker 的 withHtmlSecurityHeaders 上）。
 *
 * 失败语义：拉取失败 = 维持 'self' 基线，**不放宽**（fail-closed）；
 * meta 重写只在 parse 成功且当前值确有 frame-src 时发生（防篡改/重复注入）。
 */

/**
 * 壳 CSP meta 的唯一锚点：vite 构建注入的是 http-equiv 形态（index.html 首个 meta），
 * 选择器必须与之一致（用 name 形态会找不到 → 白名单永远不生效）。
 */
const CSP_META_SELECTOR = 'meta[http-equiv="Content-Security-Policy" i]'

/** meta[http-equiv=CSP] 的当前值解析：无 meta / 无 frame-src → null。 */
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

/**
 * 用白名单收紧 meta 的 frame-src：'self' + origins；origin 先做合法性过滤
 * （必须 http(s) origin 形态，坏值丢弃——宁可窄不可宽）。返回重写后的完整 CSP；
 * meta 缺失/frame-src 不存在时返回 null（不动文档）。
 */
export function tightenFrameSrcInMeta(doc: Document, origins: string[]): string | null {
  const meta = doc.querySelector<HTMLMetaElement>(CSP_META_SELECTOR)
  if (!meta) return null
  const csp = meta.getAttribute('content') ?? ''
  const parts = csp.split(';')
  let found = false
  const valid = origins.filter((o) => {
    try {
      const url = new URL(o)
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === o
    } catch {
      return false
    }
  })
  const next = parts
    .map((part) => {
      const trimmed = part.trim()
      if (trimmed.startsWith('frame-src')) {
        found = true
        const existing = trimmed.split(/\s+/).slice(1)
        const merged = [...new Set([...existing, ...valid])].join(' ')
        return `frame-src ${merged}`
      }
      return part
    })
    .join(';')
  if (!found) return null
  meta.setAttribute('content', next)
  return next
}

/** 壳启动时拉白名单并收紧 meta（失败静默维持基线——fail-closed 不放宽）。 */
export async function applyRegistryFrameOrigins(doc: Document): Promise<void> {
  try {
    const res = await fetch('/api/modules/frame-origins')
    if (!res.ok) return
    const origins = (await res.json()) as unknown
    if (!Array.isArray(origins)) return
    tightenFrameSrcInMeta(doc, origins.filter((o): o is string => typeof o === 'string'))
  } catch {
    // 白名单不可得 = 维持 'self' 基线（跨域模块加载失败属模块异常卡范畴）
  }
}
