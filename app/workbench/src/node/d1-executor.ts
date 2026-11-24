// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 控制面执行器 → D1Database 形状（#360）：workbench 业务 SQL 走 D1 的
 * `prepare().bind().first()/all()/run()`；但少数零参查询直接 `prepare(sql).all()`
 * （如 registryFrameOrigins），而 `ControlPlaneExecutor` 的公开面只保证 bind 之后的方法。
 * 这里补一层薄兼容（不复制 SQL、不改执行器实现），让 Node 执行器能直接坐进 `env.CORE_DB`。
 */
import type { ControlPlaneExecutor } from '@unself/control-plane';

export function toD1Database(executor: ControlPlaneExecutor): D1Database {
  return {
    prepare(sql: string) {
      const statement = executor.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return statement.bind(...values);
        },
        first() {
          return statement.bind().first();
        },
        all() {
          return statement.bind().all();
        },
        run() {
          return statement.bind().run();
        },
      };
    },
  } as unknown as D1Database;
}
