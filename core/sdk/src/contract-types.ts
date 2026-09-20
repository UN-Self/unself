// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 公开结构类型（issue #283）：`@unself/sdk` 发布产物的 `.d.ts` 必须**自包含**——
 * 第三方只装 `@unself/sdk`（+ 其唯一运行期依赖 `jose`），不装契约包
 * （契约只在本包构建期内联进 JS）。故这里给出契约类型的**结构镜像**，
 * 供公开签名引用；镜像与契约包（`core/contracts`）的等价性由
 * `test/contract-parity.test.ts` 在 `pnpm -r typecheck` 下双向校对（漂移即编译失败）。
 *
 * 真源仍是契约包；本文件只描述已冻结的公开形状，不重新定义语义。
 */

/**
 * 主题语义令牌映射（点号语义名 → CSS 值）。
 * 结构等价于契约包的 `ThemeTokens`（= `Record<string, string>`）。
 */
export type ThemeTokens = Record<string, string>;

/**
 * 模块 token（JWT）claims 的公开形状，结构等价于契约包的
 * `ModuleTokenClaims`（`z.infer<typeof ModuleTokenClaimsSchema>`）。
 * 字段语义见该契约（iss/sub/aud/iat/exp + 可选 act/name）。
 */
export interface ModuleTokenClaims {
  /** 签发方：Core 的 iss 标识。 */
  iss: string;
  /** 主体：核心内部稳定用户 id（users.id）。 */
  sub: string;
  /** 受众：模块 id（token 不能跨模块重放）。 */
  aud: string;
  /** 签发时间（UNIX 秒）。 */
  iat: number;
  /** 过期时间（UNIX 秒）。 */
  exp: number;
  /** 代调上下文（保留契约字段）。 */
  act?: { sub: string };
  /** 会话展示名（可选）。 */
  name?: string;
}
