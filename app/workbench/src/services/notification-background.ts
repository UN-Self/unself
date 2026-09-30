// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #134 通知后台化口径（approve 发信不再阻塞审批响应）：
 *
 * - 有 executionCtx（CF Workers / 测试注入假 ctx）→ 投递挂 `waitUntil` 后台跑：
 *   审批响应不被发信阻塞（CF 上发信必超时，管理员批准按钮不能跟着转圈）；
 *   发信失败审计照落（deliverNotification 内部），后台完成行为由测试 drain 假 ctx 断言。
 * - 无 executionCtx（vitest `app.request` 不传第四参，Hono 读 ctx 会抛）→ 前台 await：
 *   行为测试才能在响应返回后同步断言站内通知/审计在场；生产 Workers 恒有 ctx。
 *
 * 两种模式对调用方同一写法（await deliverNotificationInBackground(...)）：
 * 有 ctx 时 await 的是「登记」动作本身，投递 promise 已并行开跑、不阻塞响应。
 */
import type { Context, ExecutionContext } from 'hono';

import type { Bindings } from '../index';
import {
  deliverNotification,
  type DeliveryResult,
  type NotificationRecipient,
} from './notifications';
import type { MailSender } from '@unself/mail-smtp';

/** 抓取请求的 executionCtx；vitest `app.request` 无 ctx 时回 null（降级为前台投递）。 */
export function requestExecutionContext(c: Context<{ Bindings: Bindings }>): ExecutionContext | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/**
 * 把一段异步工作挂到请求后台（#152 重发激活复用同一口径）：
 * - 有 executionCtx：`waitUntil` 登记后立即返回，调用方（HTTP 处理器）不被阻塞；
 * - 无 executionCtx（测试 `app.request` 未传第四参）：就地 await 完成再返回，
 *   行为测试才能在响应后同步断言副作用。
 * 两种模式对调用方同一写法 `await runInBackground(c, work)`——有 ctx 时 await 的是
 * 「登记」动作，工作 promise 已并行开跑。异常自吞并落日志，防后台未处理拒绝。
 */
export async function runInBackground(
  c: Context<{ Bindings: Bindings }>,
  work: () => Promise<void>,
): Promise<void> {
  const executionCtx = requestExecutionContext(c);
  if (!executionCtx) {
    await work();
    return;
  }
  executionCtx.waitUntil(
    work().catch((error: unknown) => {
      console.error(`[background] task failed: ${String(error)}`);
    }),
  );
}

/**
 * 发起一次通知投递：有 ctx → waitUntil 后台（响应不等发信）；无 ctx → 前台
 * （回值 await 后投递已完成，测试可断言站内行/审计）。见文件头口径说明。
 */
export async function deliverNotificationInBackground(
  c: Context<{ Bindings: Bindings }>,
  db: D1Database,
  mailSender: MailSender | null,
  type: string,
  payload: Record<string, unknown>,
  recipient: NotificationRecipient,
): Promise<DeliveryResult | null> {
  const delivery = deliverNotification(db, mailSender, type, payload, recipient);
  const executionCtx = requestExecutionContext(c);
  if (!executionCtx) {
    return delivery;
  }
  executionCtx.waitUntil(
    delivery.catch((error: unknown) => {
      // 理论上到不了（deliverNotification 自吞发信失败落审计）；兜底防后台未处理拒绝。
      console.error(`[notify] background delivery failed: ${String(error)}`);
    }),
  );
  return null;
}
