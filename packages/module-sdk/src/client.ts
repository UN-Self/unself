// SPDX-License-Identifier: AGPL-3.0-only
import { ModuleTokenClaimsSchema, type ModuleTokenClaims } from '@unself/contracts';

/**
 * window 最小访问面（不引入 DOM lib：包可运行在 Node 侧，测试用 stub window）。
 */
interface ParentPort {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface WindowLike {
  parent: ParentPort;
  addEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
}

interface MessageLikeEvent {
  origin: string;
  data: unknown;
}

declare const window: WindowLike;
declare const atob: (data: string) => string;
declare const TextDecoder: new () => { decode(input: Uint8Array): string };

/**
 * 静默续期默认提前量：到期前约 2 分钟触发重握手（§5.2 ⑥，10 分钟 token）。
 * 短 TTL 的 token 按 TTL/3 提前（见 scheduleRenewal），保证续期时
 * 新 token 至少还有 1/3 生命周期可用。
 */
const RENEWAL_LEAD_MS = 2 * 60 * 1000;

export interface CreateModuleSDKOptions {
  /** 当前模块 id（M1 握手上下文保留字段）。 */
  moduleId: string;
  /**
   * Core（embedding shell）页面 origin，如 'https://team.example.com'。
   * 入站消息（token 下发）必须校验 event.origin === coreOrigin；
   * 未配置时走安全默认：拒收一切入站 token（不再沿用 '*' 通配语义）。
   */
  coreOrigin?: string;
}

export interface ModuleSDK {
  /** 向 Core 发送就绪消息（握手第 ② 步，触发壳下发 token）。 */
  ready(): void;
  /**
   * 监听 Core 下发的 token 消息并解析。
   * 仅接受 event.origin === coreOrigin 的消息；coreOrigin 未配置时直接 reject
   * （安全默认：无法校验来源就拒绝接受任何 token，绝不回退到 '*' 通配）。
   */
  waitForToken(): Promise<string>;
  /**
   * 启动静默续期循环：按初始 token 的 exp-iat 计算 TTL，到期前
   * 复用握手（重发 {type:'ready'}，约定见下）触发壳下发新 token；
   * 新 token 到达后由 onToken 回调通知并重新调度。
   *
   * 续期约定：模块重发 ready → 壳收 ready 后调 Core `POST /api/modules/:id/token`
   * → 壳经 postMessage 回发新 token → 本循环接住并重置定时器。
   */
  startTokenLoop(initialToken: string, onToken?: (token: string) => void): void;
  /** 停止静默续期循环（清除定时器与消息监听）。 */
  stopTokenLoop(): void;
  /** 请求 Core 导航到指定路径。 */
  navigate(path: string): void;
  /** 发送通知。 */
  notify(title: string, body?: string): void;
  /** 切换主题模式（与消息契约 theme.mode 对齐：仅 light | dark）。 */
  theme(mode: 'light' | 'dark'): void;
  /** 解码模块 token payload（不验签，仅展示用）。 */
  decodeContext(token: string): ModuleTokenClaims;
}

/**
 * 解码 JWT payload：base64url → UTF-8 → JSON。不验签，仅展示用。
 */
export function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token: expected 3 parts');
  }
  const payload = parts[1];
  if (!payload) {
    throw new Error('malformed token: empty payload');
  }
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * 创建模块侧 SDK 客户端。
 * 所有 window 访问均在运行时做 typeof 守卫，便于非浏览器环境与测试。
 */
export function createModuleSDK(options: CreateModuleSDKOptions): ModuleSDK {
  const { moduleId, coreOrigin } = options;
  // M0：moduleId 仅保留，供 M1 握手上下文使用。
  void moduleId;

  // 出站消息（发给 own parent）的 targetOrigin：未配置 coreOrigin 时用 '*'
  // （握手惯例：发向宿主页无法预知对方 origin，由壳侧自行校验来源）。
  // 注意反方向（入站 token 消息）一律要求 coreOrigin 配置，见 waitForToken。
  const targetOrigin = coreOrigin ?? '*';

  const postToParent = (message: unknown): void => {
    if (typeof window === 'undefined') {
      return;
    }
    window.parent.postMessage(message, targetOrigin);
  };

  const sendReady = (): void => {
    postToParent({ type: 'ready' });
  };

  /** 入站 token 消息判定：origin 严格等于 coreOrigin 且 type/token 形状正确。 */
  const isTrustedTokenEvent = (event: MessageLikeEvent): boolean => {
    if (coreOrigin === undefined || event.origin !== coreOrigin) {
      return false;
    }
    const data = event.data as { type?: unknown; token?: unknown } | null;
    return (
      data !== null &&
      typeof data === 'object' &&
      data.type === 'token' &&
      typeof data.token === 'string'
    );
  };

  // ---- 静默续期循环状态（闭包私有） ----
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let loopListener: ((event: MessageLikeEvent) => void) | null = null;
  let loopOnToken: ((token: string) => void) | undefined;

  /** 解码 claims（不验签，仅用于计算 TTL/展示）。 */
  const decodeContextSafe = (token: string): ModuleTokenClaims =>
    ModuleTokenClaimsSchema.parse(decodeJwtPayload(token));

  /**
   * 依据 token claims 计算续期时点并调度重握手。
   *
   * 续期时点 = exp - 提前量；提前量取 min(2 分钟, TTL/3)：
   * - 标准 10 分钟 token：提前 2 分钟（§5.2 ⑥「过期前静默续期」）；
   * - 短 TTL token：提前量压缩到 TTL/3，保证续期时新 token 至少还有
   *   1/3 生命周期可用，避免「刚换到手的 token 已过了 2/3 寿命」。
   */
  const scheduleRenewal = (token: string): void => {
    if (renewalTimer !== null) {
      clearTimeout(renewalTimer);
      renewalTimer = null;
    }
    const claims = decodeContextSafe(token);
    const ttlMs = (claims.exp - claims.iat) * 1000;
    if (ttlMs <= 0) {
      throw new Error('module-sdk: malformed token claims: exp must be after iat');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingMs = (claims.exp - nowSec) * 1000;
    if (remainingMs <= 0) {
      // token 已过期：立即重握手，等壳回发新 token 后重新调度。
      sendReady();
      return;
    }
    const leadMs = Math.min(RENEWAL_LEAD_MS, ttlMs / 3);
    const delayMs = Math.max(0, remainingMs - leadMs);
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      // 静默续期 = 复用握手：重发 ready，壳据此调 Core 换发新 token（§5.2 ②③④）。
      sendReady();
    }, delayMs);
  };

  return {
    ready(): void {
      sendReady();
    },
    waitForToken(): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (typeof window === 'undefined') {
          reject(new Error('module-sdk: window is not available'));
          return;
        }
        if (coreOrigin === undefined) {
          // 安全默认（收紧旧的 '*' 通配语义）：未配置 coreOrigin 时无法校验
          // 消息来源，拒绝接受任何来源的 token —— 宁可显式报错也不静默放行。
          reject(
            new Error(
              'module-sdk: coreOrigin is not configured; ' +
                'refusing to accept token messages from any origin. ' +
                'Set CreateModuleSDKOptions.coreOrigin to the shell origin.',
            ),
          );
          return;
        }
        const onMessage = (event: MessageLikeEvent): void => {
          if (!isTrustedTokenEvent(event)) {
            return;
          }
          window.removeEventListener('message', onMessage);
          resolve((event.data as { token: string }).token);
        };
        window.addEventListener('message', onMessage);
      });
    },
    startTokenLoop(initialToken: string, onToken?: (token: string) => void): void {
      if (typeof window === 'undefined') {
        throw new Error('module-sdk: window is not available');
      }
      if (coreOrigin === undefined) {
        // 与 waitForToken 同一安全默认：无 coreOrigin 无法校验入站来源，禁止启动循环。
        throw new Error(
          'module-sdk: coreOrigin is not configured; refusing to start token loop. ' +
            'Set CreateModuleSDKOptions.coreOrigin to the shell origin.',
        );
      }
      // 幂等：重复调用先停掉旧循环，再按新 token 重新调度。
      if (loopListener !== null) {
        window.removeEventListener('message', loopListener);
        loopListener = null;
      }
      loopOnToken = onToken;
      scheduleRenewal(initialToken);
      loopListener = (event: MessageLikeEvent): void => {
        if (!isTrustedTokenEvent(event)) {
          return;
        }
        const token = (event.data as { token: string }).token;
        // 新 token 到达：通知调用方并按其 claims 重新调度下一轮续期。
        scheduleRenewal(token);
        loopOnToken?.(token);
      };
      window.addEventListener('message', loopListener);
    },
    stopTokenLoop(): void {
      if (renewalTimer !== null) {
        clearTimeout(renewalTimer);
        renewalTimer = null;
      }
      if (loopListener !== null) {
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', loopListener);
        }
        loopListener = null;
      }
      loopOnToken = undefined;
    },
    navigate(path: string): void {
      postToParent({ type: 'navigate', path });
    },
    notify(title: string, body?: string): void {
      postToParent(
        body === undefined
          ? { type: 'notify', title }
          : { type: 'notify', title, body },
      );
    },
    theme(mode: 'light' | 'dark'): void {
      // 编译期由 'light' | 'dark' 约束；运行时防御一次 JS 调用方（契约 SdkMessageSchema 同款枚举）。
      if (mode !== 'light' && mode !== 'dark') {
        throw new Error(`module-sdk: invalid theme mode: ${String(mode)}`);
      }
      postToParent({ type: 'theme', mode });
    },
    decodeContext(token: string): ModuleTokenClaims {
      return decodeContextSafe(token);
    },
  };
}
