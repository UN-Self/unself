// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 公开结构类型（issue #283）：`@unself/sdk` 发布产物的 `.d.ts` 必须**自包含**——
 * 第三方只装 `@unself/sdk`（+ 其唯一运行期依赖 `jose`），不装契约包
 * （契约只在本包构建期内联进 JS）。故这里给出契约类型的**结构镜像**，
 * 供公开签名引用；镜像与契约包（`core/contracts`）的等价性由
 * `test/contract-parity.test.ts` 在 `pnpm -r typecheck` 下双向校对（漂移即编译失败）。
 *
 * 真源仍是契约包；本文件只描述已冻结的公开形状，不重新定义语义。
 */

/**
 * permissions 能力词表成员（结构镜像契约包的 `ModulePermission`
 * = `(typeof MODULE_PERMISSIONS)[number]`）。
 */
export type ModulePermission =
  | 'storage'
  | 'acl'
  | 'notify'
  | 'ai'
  | 'realtime'
  | 'mail';

/**
 * 模块清单（manifest.json）的公开形状，结构等价于契约包的
 * `ModuleManifest`（`z.infer<typeof ModuleManifestSchema>`，docs/modules.md §3
 * 字段冻结表）。字段语义见该契约；此处只镜像已冻结形状。
 */
export interface ModuleManifest {
  /** 模块 id：小写字母开头，`[a-z0-9-]`（决策 #59）。 */
  id: string;
  /** semver 版本号（x.y.z）。 */
  version: string;
  /** 支持的运行时（至少一项）：worker / docker / external。 */
  runtimes: ('worker' | 'docker' | 'external')[];
  /** 挂载路由建议值，以 `/m/` 开头。 */
  route: string;
  /** 模块入口 URL（http(s)）。 */
  entry: string;
  /** 权限门禁声明（词表见 MODULE_PERMISSIONS）；省略 = 不调用需授权的 Core API。 */
  permissions?: ModulePermission[];
  /** 数据落点声明（决策 #55）；省略等价于只支持 core。 */
  storage?: {
    /** 支持的数据落点（至少一项）。 */
    accepts: ('core' | 'shared' | 'dedicated' | 'external')[];
    /** 安装器默认勾选偏好；必须是 accepts 成员。 */
    preferred?: 'core' | 'shared' | 'dedicated' | 'external';
    /** 安装时实际选择（决策 #55）；必须是 accepts 成员。 */
    declaration?: 'core' | 'shared' | 'dedicated' | 'external';
  };
  /** 表名清单（accepts 含 shared 时必需）。 */
  tables?: string[];
  /** 配置页字段声明（决策 #53/#66）。 */
  config?: ModuleConfigField[];
  /** 契约版本区间（决策 #57）；省略 = 接受任意版本。 */
  compat?: { min: string; max: string };
  /** 壳展示用描述。 */
  description?: string;
  /** Lucide 图标名（`[a-z0-9-]`）。 */
  icon?: string;
  /** 壳页面 origin（决策 #63）；同域可省略，禁止 `'*'`。 */
  coreOrigin?: string;
}

/** 配置页字段声明（结构镜像契约包的 `ModuleConfigFieldSchema` 推断类型）。 */
export interface ModuleConfigField {
  /** 环境变量 / secret 名。 */
  key: string;
  /** 中文标签。 */
  label: string;
  /** 字段类型。 */
  type: 'string' | 'secret' | 'number' | 'boolean' | 'enum' | 'url' | 'json' | 'oauth';
  /** 是否必填。 */
  required?: boolean;
  /** 缺省值。 */
  default?: string | number | boolean;
  /** enum 候选。 */
  options?: string[];
  /** 连接测试标识。 */
  test?: string;
}

/**
 * 主题语义令牌映射（点号语义名 → CSS 值）。
 * 结构等价于契约包的 `ThemeTokens`（= `Record<string, string>`）。
 */
export type ThemeTokens = Record<string, string>;

/**
 * 模块 token（JWT）claims 的公开形状，结构等价于契约包的
 * `ModuleTokenClaims`（`z.infer<typeof ModuleTokenClaimsSchema>`）。
 * 字段语义见该契约（iss/sub/aud/iat/exp + 可选 act/name）。
 */
export interface ModuleTokenClaims {
  /** 签发方：Core 的 iss 标识。 */
  iss: string;
  /** 主体：核心内部稳定用户 id（users.id）。 */
  sub: string;
  /** 受众：模块 id（token 不能跨模块重放）。 */
  aud: string;
  /** 签发时间（UNIX 秒）。 */
  iat: number;
  /** 过期时间（UNIX 秒）。 */
  exp: number;
  /** 代调上下文（保留契约字段）。 */
  act?: { sub: string };
  /** 会话展示名（可选）。 */
  name?: string;
}
