// SPDX-License-Identifier: AGPL-3.0-only
/**
 * node:sqlite 可用性探测（#69 实测登记：Node 22.5–22.x 需 --experimental-sqlite，
 * 23.4+ 免 flag；本仓库真机基线 Node 26 免 flag 可用）。
 * 探测 = 真开一个内存库跑一条语句（「版本号推断」不可靠，实测主义）。
 * 不可用时给人话（怎么升级 / 加什么 flag），绝不抛出崩进程。
 * 静态 import 同 packages/sdk/test/test-factory.ts 先例（node: 内置零新依赖）。
 */
import { DatabaseSync } from 'node:sqlite';

export interface SqliteProbe {
  usable: true;
  /** node:sqlite 报告的 sqlite 编译版本（如 '3.50.4'）。 */
  version: string;
}

export interface SqliteProbeUnavailable {
  usable: false;
  /** 人话原因 + 两条出路（升级 Node / 加 flag）。 */
  reason: string;
}

export function probeSqlite(): SqliteProbe | SqliteProbeUnavailable {
  try {
    const db = new DatabaseSync(':memory:');
    try {
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v?: unknown } | undefined;
      return { usable: true, version: String(row?.v ?? 'unknown') };
    } finally {
      db.close();
    }
  } catch (err) {
    return unavailable(err);
  }
}

function unavailable(err: unknown): SqliteProbeUnavailable {
  const node = process.version;
  const detail = err instanceof Error ? err.message : String(err);
  return {
    usable: false,
    reason:
      `本机 Node ${node} 的 node:sqlite 不可用（${detail.slice(0, 160)}）。\n` +
      'Docker 模块落点需要 node:sqlite（Node ≥ 22.5 内置）：\n' +
      '  ① 升级 Node ≥ 23.4（或 24 LTS）后重跑；\n' +
      `  ② 或以实验 flag 运行：node --experimental-sqlite <命令>（Node 22.x）。`,
  };
}

/** 探测 + 不可用直接抛人话错误（装配器启动用；探测本身不抛，抛出的是这份人话）。 */
export function requireSqlite(): { version: string } {
  const probe = probeSqlite();
  if (!probe.usable) {
    throw new Error(probe.reason);
  }
  return { version: probe.version };
}
