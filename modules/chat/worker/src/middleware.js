// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/middleware.js（GPL-3.0-only，裁剪版）
// #217 认证适配：上游本地会话（SESSIONS KV opaque token）换成 core 签发的模块 JWT 验签 + JIT 建档。
// 对下游路由暴露的 session 形状保持兼容（token/userId/isAdmin/username/displayName/bio/avatarUrl），
// 使 api/*、room-access、DO 桥等上游消费点零改动。
import { verifyAccessToken } from './core-auth.js';
import { jitEnsureUser } from './jit-users.js';
import { errorResponse, errorCodeForStatus, v1ErrorResponse } from './utils.js';

function extractToken(request) {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const url = new URL(request.url);
  return url.searchParams.get('token') || '';
}

export async function authMiddleware(c, next) {
  const token = extractToken(c.req.raw);
  const verified = await verifyAccessToken(c.env, token);
  if (!verified.ok) {
    if (new URL(c.req.url).pathname.startsWith('/api/v1/')) {
      return v1ErrorResponse(errorCodeForStatus(verified.status), verified.message, verified.status);
    }
    return errorResponse(verified.message, verified.status);
  }

  const ensured = await jitEnsureUser(c.env.DB, verified.claims);
  if (!ensured.ok) {
    if (new URL(c.req.url).pathname.startsWith('/api/v1/')) {
      return v1ErrorResponse(errorCodeForStatus(ensured.status), ensured.message, ensured.status);
    }
    return errorResponse(ensured.message, ensured.status);
  }

  const claims = verified.claims;
  const session = {
    token,
    userId: ensured.user.id,
    // 模块无 admin 面（#216 已裁 admin 路由）：恒 false，adminMiddleware 骨架保留但不可达。
    isAdmin: false,
    username: ensured.user.username,
    displayName: ensured.user.displayName,
    bio: '',
    avatarUrl: ''
  };
  c.set('session', session);
  await next();
}

export async function adminMiddleware(c, next) {
  const session = c.get('session');
  if (!session?.isAdmin) {
    if (new URL(c.req.url).pathname.startsWith('/api/v1/')) {
      return v1ErrorResponse('forbidden', '需要管理员权限', 403);
    }
    return errorResponse('需要管理员权限', 403);
  }

  await next();
}
