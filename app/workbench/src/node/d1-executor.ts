// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 控制面执行器 → D1Database 形状（#360）：workbench 业务 SQL 走 D1 的
 * `prepare().bind().first()/all()/run()`；但少数零参查询直接 `prepare(sql).all()`
 * （如 registryFrameOrigins），而 `ControlPlaneExecutor` 的公开面只保证 bind 之后的方法。
 * 这里补一层薄兼容（不复制 SQL、不改执行器实现），让 Node 执行器能直接坐进 `env.CORE_DB`。
 *
 * `batch()` 也在这里补：D1 的 batch 是**隐式事务**（要么全成要么全败），core 有两处依赖这个
 * 语义——开通内置管理员、审批邀请时写 `users` + `builtin_credentials` 两条 INSERT；不是原子
 * 的话会留下「有用户行、没凭据」的半截数据，那个账号永远登录不了。
 *
 * 为什么 batch 要记住 SQL 与参数再重放，而不是直接调已有语句的 `run()`：事务必须把语句发到
 * **同一连接**上（PG 尤其如此，pool 会把语句派发到任意连接，事务就不成立）。所以 batch 把
 * 每条语句还原成「SQL + 参数」，交给 `transaction` 提供的**事务内执行器**重跑。
 */
import type { ControlPlaneExecutor } from '@unself/control-plane';

/** 事务能力：把一组操作放进单个事务内执行；回调收到「事务内执行器」。 */
export type TransactionRunner = <T>(fn: (tx: ControlPlaneExecutor) => Promise<T>) => Promise<T>;

/** batch 语句的内部形状：既要能当 D1PreparedStatement 用，也要能被还原重放。 */
interface ReplayableStatement {
  readonly sql: string;
  readonly params: () => unknown[];
}

export function toD1Database(
  executor: ControlPlaneExecutor,
  options: { transaction?: TransactionRunner } = {},
): D1Database {
  const statements = new WeakMap<object, ReplayableStatement>();

  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const bound = {
      first: () => executor.prepare(sql).bind(...params).first(),
      all: () => executor.prepare(sql).bind(...params).all(),
      run: () => executor.prepare(sql).bind(...params).run(),
    };
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      first() {
        return bound.first();
      },
      all() {
        return bound.all();
      },
      run() {
        return bound.run();
      },
    };
    statements.set(statement, { sql, params: () => params });
    return statement;
  };

  return {
    prepare,
    /**
     * batch：按序执行并保证原子。有事务能力时走事务（内部重放到事务连接上）；
     * 没有时退化为顺序执行（此时**不保证原子**，仅供无事务的运行体/单测使用）。
     */
    async batch(input: readonly unknown[]) {
      const replay = async (tx: ControlPlaneExecutor) => {
        const out: unknown[] = [];
        for (const item of input) {
          const meta = statements.get(item as object);
          if (!meta) {
            // 不是本适配器产出的语句（不该发生）：退回直接执行，保持行为可见。
            out.push(await (item as { run(): Promise<unknown> }).run());
            continue;
          }
          out.push(await tx.prepare(meta.sql).bind(...meta.params()).run());
        }
        return out;
      };
      if (options.transaction) return options.transaction(replay);
      return replay(executor);
    },
  } as unknown as D1Database;
}
