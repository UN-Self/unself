// SPDX-License-Identifier: AGPL-3.0-only
/**
 * connect 反连（dial-home）凭证核验与在线表（issue #349，决策 #109）。
 *
 * 核验规则（任务书 T2）：连接带 moduleId+keyHash（hex(SHA-256(key))，64 位小写 hex），
 * core 核对 registry credential_hash 一致才维持隧道。查询对 module_registry 定向单行读
 * （与 T1 的 connect-register / admin upsert 写面同库同表）；形状校验复用
 * @unself/control-plane/types 的 CREDENTIAL_HASH_PATTERN（形状单点）。
 *
 * 实现说明（对齐点，T1 并行开发期约定）：T1 的迁移 0013_registry_credential 已落在
 * 工作树（app/workbench/migrations/core/0013_registry_credential.sql：ADD COLUMN
 * credential_hash TEXT 可空），核验查询直接引用该列。若 T1 列未及时落库，此查询对无该列
 * 的库报错即 fail-closed 拒连——测试库按文件名顺序加载 migrations/core/*.sql，0013
 * 存在即建列；测试不另设 fake 过渡（真迁移 + 真 SQLite，#349 走查同款）。
 */
import { CREDENTIAL_HASH_PATTERN } from '@unself/control-plane/types';

/** 核验行（module_registry 定向读；列名引 0013 真列，真列 SELECT 可暴露查询列 ↔ 建表列错位）。 */
interface VerifyRow {
  enabled: number;
  /** 0016 列 lifecycle：pending/active 放行握手，disabled 拒（403）；不核 enabled（两段式）。 */
  lifecycle: string;
  /** 0013 列 credential_hash：T1 记账哈希（64 位小写 hex）；未完成记账为 null。 */
  credential_hash: string | null;
}

/** connect 凭证面仅放行 pending（记账待测）与 active（已启用）；disabled 及异常值一律 403。 */
function lifecycleAllowsConnect(lifecycle: string | null | undefined): boolean {
  return lifecycle === 'pending' || lifecycle === 'active';
}

/**
 * 核验常量：hex(SHA-256("unself-connect-v1"))。
 * 这是任务书给定的 KDF 定案（纯哈希裸撞 registry credential_hash）的盐值形态：
 * 为什么要记账加盐、如何换盐（#349 后续 issue 的义务，非本期）——盐是漂移锚：
 * 同一明文 key 的哈希随盐改变，verifier（隧道核验）必须与记账端（T1 浏览器 WebCrypto
 * KDF 侧）同盐同形，否则换盐 = 全量重生成 key。本期盐值仅占位定型；更换算法/盐 =
 * 凭证重生成动线，归后续 issue（注释为对齐点）。
 */
export const KDF_SALT = 'unself-connect-v1';

/** 64 位小写 hex → 32 字节（时序安全比较用）。形状非法返回 null（调用方按不配拒）。 */
function hexToBytes(hex: string): Uint8Array | null {
  if (!CREDENTIAL_HASH_PATTERN.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isNaN(byte) ? 0 : byte;
  }
  return out;
}

/** 时序安全比较（两个等长 32 字节 buffer）。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** 核验结果（fail-closed 三态：未知模块 / 哈希不配 / 通过）。 */
export type CredentialCheck =
  | { ok: true; moduleId: string }
  | { ok: false; status: 404 | 403; error: string };

/** 纯哈希反查结果：ok 时回命中行的模块 id（调用方凭它定位 DO 分片）。 */
export type HashLookup =
  | { ok: true; moduleId: string }
  | { ok: false; status: 404 | 403; error: string };

/**
 * 核对反连凭证（隧道 WS upgrade / poll 共用单点，#51 验签纪律：fail-closed）。
 * 规则：
 * - 未知模块 id → 404（不区分「不存在」与「未记账」，防枚举）；
 * - 模块存在但无凭证（credential_hash NULL）→ 403（两段式第①段未做，keyHash 必不配）；
 * - keyHash 形状非法 → 403（64 位小写 hex，CREDENTIAL_HASH_PATTERN 单点）；
 * - 哈希不一致 → 403（时序安全比较，时序侧信道最小化）；
 * - **不核对 enabled，只核 lifecycle**（#349 真机取证修正）：反连是两段式——第①段记账
 *   即 pending（enabled=false），模块拨号上来「测试连接」通过后才第②段保存激活。若此处
 *   要求 enabled=1，则待接入模块永远连不上（鸡生蛋死锁，真浏览器抓到的 403）。停用后
 *   disabled 且 enabled=0，**这里直接 403**——模块拿 key 握手、轮询、读配置
 *   （module-api keyHash 轨）都被拒；token 签发与导航/iframe 装载仍按 enabled 拦（双闸）。
 * 一律不回明文原因给连接方（连接方不是浏览器用户，人话无意义；管理员排障走审计）。
 */
export async function verifyConnectCredential(
  db: D1Database,
  moduleId: string,
  keyHash: string,
): Promise<CredentialCheck> {
  // 先按 id 行锁（调用方已持 moduleId 时走快路径，哈希比较同 lookupConnectModule 语义）
  const row = await db
    .prepare('SELECT enabled, lifecycle, credential_hash FROM module_registry WHERE id = ?')
    .bind(moduleId)
    .first<VerifyRow>();
  if (!row) {
    return { ok: false, status: 404, error: 'unknown module' };
  }
  if (!lifecycleAllowsConnect(row.lifecycle)) {
    return { ok: false, status: 403, error: 'module disabled' };
  }
  const stored = hexToBytes(row.credential_hash ?? '');
  const provided = hexToBytes(keyHash);
  if (!stored || !provided || !constantTimeEqual(stored, provided)) {
    return { ok: false, status: 403, error: 'credential mismatch' };
  }
  return { ok: true, moduleId };
}

/**
 * 纯哈希反查（#349 验收反馈收敛：模块拨号只交 keyHash，不报自己的 id——#109 env 契约
 * 本就只有「core 地址 + key」两项，id 是实现自加的冗余）。core 凭 0013 credential_hash
 * 列定位模块：64 位 hex 全域唯一（key 生成于浏览器 CSPRNG，碰撞概率忽略），按哈希等值
 * 定向单行读 + 时序安全比较。语义与 verifyConnectCredential 同一构（404 不区分不存在与
 * 未记账防枚举 / 403 形状、不配或 disabled / pending 与 active 放行），仅查找方向相反。
 */
export async function lookupConnectModule(
  db: D1Database,
  keyHash: string,
): Promise<HashLookup> {
  const provided = hexToBytes(keyHash);
  if (!provided) {
    return { ok: false, status: 403, error: 'credential mismatch' };
  }
  const row = await db
    .prepare('SELECT id, lifecycle, credential_hash FROM module_registry WHERE credential_hash = ?')
    .bind(keyHash)
    .first<{ id: string; lifecycle: string; credential_hash: string | null }>();
  // 哈希列等值命中后再时序安全比较（防 DB 级旁路；单行读不存在枚举面）
  if (!row || !constantTimeEqual(hexToBytes(row.credential_hash ?? '') ?? new Uint8Array(), provided)) {
    return { ok: false, status: 404, error: 'unknown credential' };
  }
  // 停用后 key 仍对也不放行：否则停用只是导航层假动作，模块可继续轮询/读配置。
  if (!lifecycleAllowsConnect(row.lifecycle)) {
    return { ok: false, status: 403, error: 'module disabled' };
  }
  return { ok: true, moduleId: row.id };
}

/**
 * 在线表（「测试连接」数据源；在线状态语义）：
 * - CF 落点：TunnelRoom DO（hibernation）持有 webSocket 对，在线表 = 存活 WS 会话的真值
 *   ——DO 内存 Map 即表，见 src/do/TunnelRoom.ts（serializeAttachment 绑 moduleId+keyHash）；
 * - Node 运行体（#106 过渡事实）：同 Map 结构由运行时自持（决策 #109：连接形式模块自选，
 *   core 备能力不强制）。本文件只定义表的读形状，两个运行体各自承载实例。
 * - 在线 ≠ enabled：在线表只回答「此刻有没有活连接」；是否允许建连由 verifyConnectCredential
 *   （registry 真值面）判定，两层不混。
 */
export interface TunnelOnlineStatus {
  moduleId: string;
  online: boolean;
}

/** 在线表的读接口（DO 存活会话表 / Node 内存表各自实现）。 */
export interface TunnelOnlineTable {
  status(moduleId: string): Promise<TunnelOnlineStatus>;
}
