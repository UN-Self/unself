import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { listVisibleChannels } from './data/channels.js';
import { listUserDms } from './data/dm-queries.js';
import { ensureGeneralChannelMembership } from './data/general-channel.js';
import { getSiteSettings } from './data/site-settings.js';
import { listActiveUsers } from './data/users.js';
import { ApiError } from './errors.js';
import { adminMiddleware, authMiddleware } from './middleware.js';
import { registerChannelRoutes } from './api/channels.js';
import { registerContactRoutes } from './api/contacts.ts';
import { registerDmRoutes } from './api/dm.js';
import { registerMessageRoutes } from './api/messages.js';
import { registerUploadRoutes } from './api/upload.js';
import { registerUserBlockRoutes } from './api/user-blocks.ts';
import { registerUserProfileRoutes } from './api/user-profile.ts';
import { registerV1Routes } from './api/v1.js';
import { ChannelRoom } from './do/ChannelRoom.js';
import { Scheduler } from './do/Scheduler.js';
import { UserInbox } from './do/UserInbox.js';
import { forwardInboxConnection, forwardRoomConnection } from './do-bridge.js';
import { runScheduledGc } from './gc.js';
import {
  errorCodeForStatus,
  errorResponse,
  requestBodyTooLarge,
  v1ErrorResponse
} from './utils.js';

const app = new Hono();

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const uploadLimit = Number(c.env.MAX_FILE_SIZE || 20971520) + 1024 * 1024;
  const maxBytes = ['/api/upload', '/api/v1/uploads'].includes(path) ? uploadLimit : undefined;
  if (requestBodyTooLarge(c.req.raw, maxBytes)) {
    // 提前拒绝超大请求体，避免 Worker 在 JSON 解析前消耗过多内存。
    return errorResponse('请求体过大', 413);
  }

  await next();
});

app.use('/api/*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/site', async (c) => {
  const site = await getSiteSettings(c.env.DB);
  return c.json({ site });
});

registerV1Routes(app);

app.use('/api/*', authMiddleware);

// #217：本地登录已裁，身份由 core 签发的模块 token 经验签 + JIT 建档给出（middleware.js）。
app.get('/api/me', (c) => {
  const session = c.get('session');
  return c.json({
    user: {
      id: session.userId,
      username: session.username,
      displayName: session.displayName
    }
  });
});

app.get('/api/users', async (c) => {
  const session = c.get('session');
  const users = await listActiveUsers(c.env.DB, session.userId);
  return c.json({ users });
});

app.get('/api/bootstrap', async (c) => {
  const session = c.get('session');
  await ensureGeneralChannelMembership(c.env.DB, session.userId);
  const [users, channels, dms] = await Promise.all([
    listActiveUsers(c.env.DB, session.userId),
    listVisibleChannels(c.env.DB, session.userId),
    listUserDms(c.env.DB, session.userId)
  ]);

  return c.json({ users, channels, dms });
});

app.use('/api/admin/*', adminMiddleware);

registerMessageRoutes(app);
registerContactRoutes(app);
registerDmRoutes(app);
registerUserBlockRoutes(app);
registerUserProfileRoutes(app);
registerUploadRoutes(app);
registerChannelRoutes(app);

app.get('/api/ws/:kind/:id', async (c) => {
  const session = c.get('session');
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (!['public', 'private', 'dm'].includes(kind)) {
    return errorResponse('无效的会话类型');
  }

  return forwardRoomConnection({
    env: c.env,
    request: c.req.raw,
    kind,
    roomId: id,
    principal: session
  });
});

app.get('/api/inbox/ws', async (c) => {
  const session = c.get('session');
  return forwardInboxConnection({
    env: c.env,
    request: c.req.raw,
    principal: session
  });
});

app.notFound(async (c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return errorResponse('接口不存在', 404);
  }
  return new Response('Not Found', { status: 404 });
});

app.onError((error, c) => {
  console.error(error);
  const isV1 = new URL(c.req.url).pathname.startsWith('/api/v1/');
  if (error instanceof ApiError) {
    if (isV1) {
      return v1ErrorResponse(error.code, error.message, error.status);
    }
    return errorResponse(error.message, error.status);
  }
  if (isV1) {
    return v1ErrorResponse(errorCodeForStatus(500), '服务器开小差了', 500);
  }
  return errorResponse('服务器开小差了', 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledGc(env));
  }
};
export { ChannelRoom, Scheduler, UserInbox };
