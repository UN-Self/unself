// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * SDK ↔ Core（shell/embedding 页）window.postMessage 消息协议契约。
 * 按 type 判别的 union，客户端与服务端共用同一 schema 校验。
 */
export const SdkMessageSchema = z.discriminatedUnion('type', [
  /** SDK 就绪，可开始接收 token 等消息。 */
  z.object({ type: z.literal('ready') }),
  /** Core 下发模块认证 token。 */
  z.object({ type: z.literal('token'), token: z.string() }),
  /** 请求 Core 导航到指定路径。 */
  z.object({ type: z.literal('navigate'), path: z.string() }),
  /** 发送通知（标题必填，正文可选）。 */
  z.object({ type: z.literal('notify'), title: z.string(), body: z.string().optional() }),
  /** 切换到指定主题模式。 */
  z.object({ type: z.literal('theme'), mode: z.enum(['light', 'dark']) }),
]);

export type SdkMessage = z.infer<typeof SdkMessageSchema>;
