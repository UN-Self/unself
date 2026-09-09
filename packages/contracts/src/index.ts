// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

export * from './manifest';
export * from './token';
export * from './messages';
export * from './lifecycle';
export * from './lifecycle-schema';
export * from './theme';

/** 健康检查结果（Core API `/healthz` 等端点）。 */
export const HealthSchema = z.object({
  ok: z.boolean(),
});

export type Health = z.infer<typeof HealthSchema>;
