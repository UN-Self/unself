// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/auth.js（GPL-3.0-only，裁剪版）
//
// #231 下架记录：本地会话机制（SESSIONS KV opaque token）已被 core 模块 JWT + JIT 取代
// （#217：middleware.js → core-auth.js + jit-users.js，session.js 读取面已死）。但残留写入面
// 仍把模块 JWT 明文写进 KV（PATCH /api/me/profile → putSession，TTL 7 天 > token 10 分钟），
// 与「明文令牌不落库」纪律相悖。本文件删除本地会话四函数（putSession/getSession/
// deleteSession/createSession）及其私有 helper（SESSION_TTL_SECONDS/toSessionVersion/
// resolveSessionTtl）；worker/src/session.js 一并删除（validateSession 已无任何 import）。
//
// 保留项（不删理由）：
// - hashPassword/verifyPassword：test/chat-test-factory.ts 种子用户依赖真 PBKDF2 实现
//   （禁手搓哈希桩）；M3 登录面若开路由，这是唯一哈希实现。
// - isAdminUser：权限判定唯一依据（DB is_admin）的单点定义；adminMiddleware 语义文档位。
// - isConfiguredAdminUsername：注册阶段的同名占用检查（防钓鱼），待 M3 登录/注册面复用。
const encoder = new TextEncoder();

function toBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;

  // 密码哈希是固定长度的敏感值；始终遍历完整派生结果，避免普通字符串比较随首个差异提前结束。
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function hashPassword(password, salt = null) {
  const passwordSalt = salt || toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromBase64Url(passwordSalt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return {
    salt: passwordSalt,
    hash: toBase64Url(new Uint8Array(bits))
  };
}

export async function verifyPassword(password, passwordHash, passwordSalt) {
  const derived = await hashPassword(password, passwordSalt);
  return timingSafeEqual(derived.hash, passwordHash);
}

function parseAdminUsernames(env) {
  return String(env.ADMIN_USERNAMES || '')
    .split(',')
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean);
}

// 仅用于注册环节的用户名占用检查，防止有人注册出跟管理员同名(忽略大小写)的账号用于钓鱼/混淆。
// 不再作为权限判定依据。
export function isConfiguredAdminUsername(env, username) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  return Boolean(normalizedUsername) && parseAdminUsernames(env).includes(normalizedUsername);
}

// 权限判定唯一依据：数据库中的 is_admin 字段，不再比对用户名。
export function isAdminUser(_env, user) {
  return Boolean(Number(user?.is_admin));
}
