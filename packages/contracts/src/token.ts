// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * 模块 token claims（JWT payload）契约。
 * Core 向模块签发（iss = Core），模块携带 token 调 Core API；
 * act 表示「以某模块身份代调」，非代调时省略。
 */
export const ModuleTokenClaimsSchema = z.object({
  /** 签发方：Core 的 iss 标识。 */
  iss: z.string(),
  /** 主体：当前模块 id。 */
  sub: z.string(),
  /** 受众：Core API 的 audience 标识。 */
  aud: z.string(),
  /** 签发时间（UNIX 秒）。 */
  iat: z.number(),
  /** 过期时间（UNIX 秒）。 */
  exp: z.number(),
  /** 代调上下文：核心代调时 = 发起模块 id。 */
  act: z.object({ sub: z.string() }).optional(),
  /** 已授牌能力列表（可选）。 */
  caps: z.array(z.string()).optional(),
});

export type ModuleTokenClaims = z.infer<typeof ModuleTokenClaimsSchema>;
