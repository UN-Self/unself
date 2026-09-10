// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * 模块 token claims（JWT payload）契约（与 core-api issueModuleToken 实现语义对齐）：
 * Core 向模块签发（iss = Core），模块携带 token 调模块自身后端 API；
 * - aud = 模块 id（token 不能跨模块重放）；
 * - sub = 核心内部用户 id（users.id，模块侧据此识别「谁」）；
 * - name = 会话展示名（可选，旧 token 无此字段；hello 等模块用作身份行）。
 * - #49 将消费 OIDC userinfo 补齐缺失的身份声明。
 */
export const ModuleTokenClaimsSchema = z.object({
  /** 签发方：Core 的 iss 标识。 */
  iss: z.string(),
  /** 主体：核心内部稳定用户 id（users.id）。 */
  sub: z.string(),
  /** 受众：模块 id（token 不能跨模块重放）。 */
  aud: z.string(),
  /** 签发时间（UNIX 秒）。 */
  iat: z.number(),
  /** 过期时间（UNIX 秒）。 */
  exp: z.number(),
  /** 代调上下文：核心代调时 = 发起模块 id（保留契约字段；Core 从未签发）。 */
  act: z.object({ sub: z.string() }).optional(),
  /** 已授牌能力列表（可选）。 */
  caps: z.array(z.string()).optional(),
  /** 会话展示名（可选；身份行展示用，避免前端再走一次用户查询）。 */
  name: z.string().optional(),
});

export type ModuleTokenClaims = z.infer<typeof ModuleTokenClaimsSchema>;
