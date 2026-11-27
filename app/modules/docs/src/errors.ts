// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 统一错误形状（issue #358 · 契约 §6）：所有失败响应体都是 `{ error: <code> }`，
 * 唯一例外是 409 —— 额外带 `current`（**服务端最新行**，不是客户端提交值）。
 *
 * 纪律：
 * - code 与状态码的对应只在本文件出现一次，端点不得各自造 code 或硬编码状态码；
 * - code 是机器可读的 snake_case 词汇（与契约强制的 `version_conflict` 同形），
 *   人话文案归前端翻译，不放进响应体（免得两套措辞漂移）。
 */

/** 本模块错误码词表（新增必须同时给状态码，否则类型不通过）。 */
export const ERROR_CODES = {
  /** 401：缺 Authorization 或不是 Bearer 形态。 */
  missingBearerToken: 'missing_bearer_token',
  /** 401：签名不符 / 过期 / aud 不符——三者不区分原因，避免给攻击者当探针。 */
  tokenInvalid: 'token_invalid',
  /** 503：本进程拿不到 core 公钥（配置缺口，不冒充 401 误导排查）。 */
  jwksUnavailable: 'jwks_unavailable',
  /** 400：请求体不合法（字段缺失/类型不符/limit 越界由服务端钳制而非报错）。 */
  invalidRequest: 'invalid_request',
  /**
   * 404：文档不存在、已软删，或调用者非成员（成员表脏值也算）。三者同码，不泄露存在性。
   * 临时放开期间：无成员行的调用者读路径不再 404（按只读放行），写/删仍 403；见 auth/policy.ts。
   */
  notFound: 'not_found',
  /** 403：角色不够（owner / editor / viewer 矩阵见 auth/policy.ts）。临时放开期间，无成员行的调用者写/删也落这里。 */
  forbidden: 'forbidden',
  /** 409：baseVersion 与库内 version 不符，体里带服务端最新行。 */
  versionConflict: 'version_conflict',
  /** 501：路由已登记、业务未实现（当前只有 /life/* 在用，显式占位，不假装成功）。 */
  notImplemented: 'not_implemented',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 错误码 → HTTP 状态码（唯一真值）。 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODES.missingBearerToken]: 401,
  [ERROR_CODES.tokenInvalid]: 401,
  [ERROR_CODES.jwksUnavailable]: 503,
  [ERROR_CODES.invalidRequest]: 400,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.forbidden]: 403,
  [ERROR_CODES.versionConflict]: 409,
  [ERROR_CODES.notImplemented]: 501,
};

/** 常规错误响应体。 */
export interface ErrorBody {
  error: ErrorCode;
}

/** 409 响应体（契约 §6 固定形状，current 必须是服务端当前文档）。 */
export interface VersionConflictBody {
  error: typeof ERROR_CODES.versionConflict;
  current: unknown;
}

/** 造常规错误体。 */
export function errorBody(code: ErrorCode): ErrorBody {
  return { error: code };
}

/**
 * 造 409 体。`current` 由调用方从库里重新读出（不是把请求里的 baseVersion 之类拼回来），
 * 前端据此提供「覆盖 / 重载 / 取消」三个动作（#358 §5）。
 */
export function versionConflict(current: unknown): VersionConflictBody {
  return { error: ERROR_CODES.versionConflict, current };
}
