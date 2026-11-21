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
  /** 会话展示名（可选；身份行展示用，避免前端再走一次用户查询）。 */
  name: z.string().optional(),
  /** Core 头像地址；缺省保留旧投影，空串代表用户移除头像。 */
  avatar_url: z.string().optional(),
  /** Core 资料的单调修订号；模块用它拒绝旧 token 回退展示资料。 */
  profile_revision: z.number().int().nonnegative().optional(),
  /** 登录用户名（可选）：内置账号取 builtin_credentials.username；OIDC 用户无凭据行，缺省。
   * 仅为展示句柄——模块内部身份锚（如 chat 的 core:<sub>）不外露，与此字段无关。 */
  username: z.string().optional(),
  /** 工作邮箱（可选）：核心 users.email（激活开户落库）；未开户/IdP 未签 email 时缺省。 */
  email: z.string().optional(),
  /** 身份来源（可选）：核心 users.issuer 落库值——'builtin'=内置账号，其余值一律签 'oidc'。
   * 权威判断字段（模块侧不得用「username 有无」推断）；旧签发侧不带此字段 → 模块侧按「来源未知」处理。 */
  identity_source: z.enum(['builtin', 'oidc']).optional(),
});

export type ModuleTokenClaims = z.infer<typeof ModuleTokenClaimsSchema>;
