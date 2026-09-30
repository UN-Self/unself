// SPDX-License-Identifier: AGPL-3.0-only
// #310 新增（unself 集成层，非上游件）：chat worker 表名前缀单一注入点。
// 上游 SQL 里的表名是裸写（FROM users / REFERENCES messages / UPDATE channels …）。
// shared 落点建的表带 chat_ 前缀、dedicated 不带；为保持上游件逐字节一致，
// 只在 D1 绑定边界做一次 SQL 标识符替换，不改任何上游 SQL 文件。

/** 本模块逻辑表名，严格与 manifest.yaml tables 一致（顺序即 manifest 顺序）。 */
export const CHAT_TABLES = Object.freeze([
  'users',
  'channels',
  'channel_members',
  'messages',
  'user_blocks',
  'channel_pins',
  'message_reads',
  'site_settings',
  'registration_invites',
  'registration_invite_uses',
  'uploaded_files',
  'device_sessions',
  'realtime_tickets',
  'message_events',
  'message_event_compaction',
  'pending_r2_delete',
  'core_identities',
  'read_receipts'
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 长名优先，避免同名前缀互相遮挡；两侧用 [A-Za-z0-9_] 整词边界，
// 保证 userId / users_extra / chat_users 这类斜接标识符不被二次加前缀。
const TABLE_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])(${[...CHAT_TABLES]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})(?![A-Za-z0-9_])`,
  'g'
);

function substituteTableNames(sql, prefix) {
  return sql.replace(TABLE_PATTERN, (match) => prefix + match);
}

/**
 * 重写 SQL：按单引号把语句分段，只在非字符串段做整词替换。
 * SQL 里用 '' 表示字面单引号，需要成对跳过，不能误判为字符串结束。
 */
function rewriteTableNames(sql, prefix) {
  if (typeof sql !== 'string' || sql.length === 0) return sql;

  let result = '';
  let segmentStart = 0;
  let inString = false;
  let index = 0;

  while (index < sql.length) {
    if (sql[index] !== "'") {
      index += 1;
      continue;
    }

    if (!inString) {
      result += substituteTableNames(sql.slice(segmentStart, index), prefix);
      inString = true;
      segmentStart = index;
      index += 1;
      continue;
    }

    if (sql[index + 1] === "'") {
      index += 2;
      continue;
    }

    inString = false;
    index += 1;
    result += sql.slice(segmentStart, index);
    segmentStart = index;
  }

  const tail = sql.slice(segmentStart);
  result += inString ? tail : substituteTableNames(tail, prefix);
  return result;
}

/**
 * 给 D1 绑定套一层表名前缀。dedicated（prefix 为空）时原样返回，零行为变化；
 * 否则只代理绑定面：prepare/exec 先重写 SQL 再委托，batch 直接委托
 * （语句早已在 prepare 处重写）。其余成员透传，避免遮蔽未来用到的绑定方法。
 */
export function applyTablePrefix(db, prefix) {
  if (!prefix) return db;

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql) => target.prepare(rewriteTableNames(sql, prefix));
      }
      if (prop === 'exec') {
        return (sql) => target.exec(rewriteTableNames(sql, prefix));
      }
      if (prop === 'batch') {
        return (statements) => target.batch(statements);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
