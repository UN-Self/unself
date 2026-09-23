# 模块契约与开发指南

> 对象：写模块的人（第三方与官方同规）与部署模块的人。
> 本文是**模块包契约的权威去处**；部署编排与装配器行为见 [docs/architecture.md](architecture.md)，拍板条目编号见 [docs/decisions.md](decisions.md)。
> 状态：契约 v1（2026-09-17 定稿）。带「待定」标记的条目尚未定案，不要按它实现。

## 0. 一句话

模块 = **一个自包含的部署单元**，通过 manifest、`@unself/sdk`、Core API 三条通道与壳协作；壳对模块内部实现一无所知。

按来源与形态分三类（决策 #31，与部署方式、信任边界一致）：

| 类 | 是什么 | 例子 |
|---|---|---|
| 功能模块 | 原生 Worker 实现的协作能力，随实例部署 | 聊天、会议信令、看板 |
| 适配器 | 代码随实例部署，包一层外部系统 | Stalwart（邮件）、CalDAV（日历）、Git Webhook |
| 伴生服务 | 实例外的整台服务，只做配置接线 | Stalwart 本体、外部 IdP、TURN/SFU |

## 1. 来源与身份

**全局唯一身份 = 包名/来源**（决策 #59）。`manifest.id` 只是**作者建议的实例内名字**，部署者安装时可以改；撞名由安装器提示改名。注册表主键是实例内 id，升级靠 `source` 定位包。

来源协议（决策 #58 / #77）：

| 写法 | 含义 | 是否允许本地构建 |
|---|---|---|
| `npm:@acme/unself-todo@1.2.0` | npm / 私有 registry（走 npm 配置） | 否 |
| `github:acme/unself-todo#v1.2.0` | git 仓库的 **release 产物** | 否 |
| `https://内网/…/todo-1.2.0.tgz` | 任意 tarball URL | 否 |
| `file:./modules/my-todo` | 本地目录（**唯一允许源码**的路径） | **是** |

**没有 `official:` 特权来源（决策 #77）**：官方模块就是普通 npm 包（`@unself/hello`、`@unself/chat`），与第三方走同一个解析器、同一套安装与卸载路径。安装器 `dependencies` 里精确预装了官方模块，因此 `npm:@unself/hello@0.1.0` 这类串**本地有就直接用（零网络）**、缺了才去 registry 取——这是「默认值」，不是「特权」。

**信任边界（硬）**：远端来源一律要求**已打包**。安装器直接从 registry 取 tarball 解包，**不走 `npm install`**（`postinstall` 没有执行机会），**不执行包内任何脚本**。作者的构建只发生在作者自己的 CI 或本地目录模式。

## 2. 包格式

由 `unself module pack` 产出（打包器随安装器按需加载）：

```
unself-todo-1.2.0.tgz
├─ manifest.json     契约声明（唯一必需，见第 3 节）
├─ worker.js         预构建、自包含；runtimes 含 worker 时必需
├─ assets/           模块页静态文件；只含 var(--unself-*) 名字，不含值
├─ migrations/       可选：000N_*.sql，仅 shared / dedicated 模式需要
├─ config.schema     可选：配置页字段声明（见第 5 节）
├─ theme.json        可选：模块自己的皮肤（默认跟随实例主题）
├─ docker/           可选：runtimes 含 docker 时的镜像/端口/健康检查声明
├─ LICENSE / NOTICE  许可证随包走；GPL 类模块必须自带
└─ package.json      生成的 npm 元数据（name/version/files）；`npm publish` 用它
```

`manifest.json` 是**安装侧的真相**；生成的 `package.json` 只服务 npm 发布（决策 #78），二者版本号必须一致。

**包里不得出现**：`node_modules/`、`.env` / 密钥、测试残留、源码（除非是 `file:` 本地模式）。

**worker.js 的要求**：单文件自包含——一切依赖必须 bundle 进产物（决策 #60）。部署时零安装，也没有任何运行时动态装包机制。

## 3. manifest.json 字段表（契约 v1）

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string，`^[a-z][a-z0-9-]+$` | ✅ | 作者建议的实例内名字，可被部署者覆盖 |
| `version` | semver `x.y.z` | ✅ | 版本；实例侧的确切版本另记在 `unself.lock` |
| `runtimes` | `worker` / `docker` / `external` 的子集 | ✅ | 本模块支持跑在哪；决定可选的 `mode`（见第 4 节） |
| `route` | string，以 `/m/` 开头 | ✅ | 挂载路由建议值；同域路径制下由装配器生成 `/m/<id>/*` |
| `entry` | url | ✅ | `external` 运行时为模块自身地址；其他运行时由装配器覆写为实例内地址 |
| `description` | string | — | 壳展示用 |
| `icon` | `^[a-z0-9-]+$`（Lucide 图标名） | — | 未知/缺省回退模块名首字；**拒绝 emoji** |
| `permissions` | 能力词表子集（见下） | — | **门禁**：模块向平台请求的权限。未声明即调用对应 Core API → 403 |
| `storage` | object（见第 4 节） | — | 数据落点声明；省略等价于只支持 `core` |
| `tables` | string[] | 条件 | `storage.accepts` 含 `shared` 时**必须**申报本模块的表名清单 |
| `config` | object（见第 5 节） | — | 配置页字段声明 |
| `compat` | `{ "min": "0.2", "max": "0.3" }` | — | 契约版本区间；**省略 = 接受任意版本**（决策 #57） |

**`permissions` 词表**（首版，权威定义在 `@unself/contracts`）：`storage` / `acl` / `notify` / `ai` / `realtime` / `mail`。
**未知能力在安装时直接拒绝**——静默忽略会让模块跑起来莫名 403，部署者查不出原因（沿用 #64 已立原则）。

**已删除的字段**（决策 #56）：`capabilities`（模块「提供什么功能」不属 core 契约，放错层）与 `requires`（恒定值、无消费者）。需要「模块实现的是哪项产品能力」时再按增量补，不要现在预留。

## 4. 部署位置与数据落点

**位置（`mode`）由部署者选，模块声明支持哪些**（决策 #54）：

| 部署者选 | 模块必须声明 | 含义 |
|---|---|---|
| `cloudflare` | `runtimes ∋ worker` | 部署到部署者的 CF 账户 |
| `docker` | `runtimes ∋ docker` | 部署到一个 Docker 端点（安装器渲染 compose） |
| `connect` | `runtimes ∋ external`（或只给 `entry`） | 你自己已经跑着，实例只注册地址 |

选了模块未声明的模式 → **拒绝安装**，不让它跑一半炸。三种部署形态（纯 CF / 纯 Docker / 混杂）只是这些取值的组合。

**数据（`storage`）由部署者选，模块声明 `accepts` + `preferred`**（决策 #55）：

```jsonc
"storage": { "accepts": ["shared", "dedicated"], "preferred": "shared" }
```

| 级 | 模块怎么存 | 隔离 | 谁跑迁移 | 代价 |
|---|---|---|---|---|
| `core`（默认，省略时等价） | 经 Core API 代理，仅 `get` / `put` / `delete` / `list` | ✅ 物理隔离 | core | 无 |
| `shared` | 在共享 modules 库**自建表** | ❌ 零隔离 | 模块自带 | 无配额，但需三护栏 |
| `dedicated` | 装配器供给独立 D1 / KV / R2 | ✅ | 模块自带 | **占账户配额** |
| `external` | 你自备的外部数据库（Postgres 等） | ✅ | 模块自己 | 需部署者提供连接串（走配置页） |

**`shared` 的三条护栏（硬）**：① 每个模块用**独立的迁移记账表**；② 必须在 `tables` 里申报表名清单（卸载/备份按清单执行）；③ 表名必须以 `<模块id>_` 开头，禁止跨模块外键。安装时安装器会提示部署者「此模块将获得共享数据库完整访问权」。

**只做键值存储就用 `core`；要建表就选自建库。** 「共享库不接收未经申报的表」是硬规则。

## 5. 配置页（config schema）

模块自己带配置表单，部署者不用翻模块文档找「要填什么」（决策 #53/#66 配套）。安装器**渲染**表单，不执行模块提供的页面。

```jsonc
"config": [
  { "key": "DATABASE_URL", "label": "PostgreSQL 连接串",
    "type": "secret", "required": true, "test": "pg" },
  { "key": "REGION", "label": "区域", "type": "enum",
    "options": ["us", "eu", "ap"], "default": "ap" }
]
```

| 字段 | 说明 |
|---|---|
| `key` | 环境变量 / secret 名 |
| `label` | 中文标签（部署者看到的就是这个） |
| `type` | `string` / `secret` / `number` / `boolean` / `enum` / `url` / `json` / `oauth` |
| `required` | 是否必填 |
| `default` | 缺省值 |
| `options` | `enum` 的候选 |
| `test` | 可选的连接测试标识（如 `pg` / `s3` / `http`），安装器据此提供「测试连接」按钮 |

**secret 与非 secret 分流**：`type: secret` 的值写进 `wrangler secret` / docker secret，**不落** `unself.config.jsonc` 与 `unself.lock`；其余落配置文件。装配开始前一次收齐，不插在九步中间。

**向导渲染形态（#307 定稿，决策 #93）**：
- **每模块独立一页**：选中模块逐个声明了 `config` 的各占一步（③★），无 `config` 的模块自动跳过不出现页；步进器显示「配置 <模块id>」
- 控件按 `type` 映射：`secret`→掩码输入（不回显、提交后不可回看，只进程内存，同部署 token 语义）；`enum`→单选；`boolean`→开关；`url`→带格式校验；`json`→多行文本（提交时 parse 预检）；`oauth`→M1 按文本框处理（语义待定，见下）
- **连接测试**：`test: http` 向导内真测试（服务端代理，同 OIDC 测试连接模式）；`pg`/`s3` 等其余标识 M1 只渲染禁用态按钮 + 「装配时验证」文案，逐步补
- `oauth` 类型字段语义未定稿（当初 #53 未给渲染口径）：M1 按普通凭据字段收值，渲染口径待首个真实需要 oauth 的模块出现时再定
- 配置值收齐后才进 ③½/④；装配失败回退时表单值保留（浏览器历史回退或 state 回带）

## 6. 迁移契约（硬）

只对 `shared` 与 `dedicated` 有意义（`core` 的 schema 归 core；`external` 由模块自己管）。

1. **逐条幂等**：记账表只在**整份文件成功后**记账，失败后重跑会**整份重放**——所以 `CREATE TABLE/INDEX` 必须带 `IF NOT EXISTS`，`INSERT` 必须 `OR IGNORE` / `OR REPLACE`。
2. **只写增量安全语句**：`CREATE` / `ADD COLUMN` / `CREATE INDEX`。破坏性变更走 expand/contract（加新表新列 → 迁数据 → 弃用旧的，但不删）。
3. 表名以 `<模块id>_` 开头；禁止跨模块外键；迁移文件命名 `000N_描述.sql`，**只增不改**（改了不重跑）。

**失败时**：安装器**停住**并指出「模块 / 文件 / 第几条语句」，**不自动重试、不自动回滚**（D1 无事务，自动回滚可能更糟）。不做迁移前自动备份（低频，复杂度不划算）——要安全回滚请用部署者自己的备份。

## 7. `unself module validate`（发布前必过）

硬拦六类错：

1. `id` 不合法或与包名不一致；
2. `storage.accepts` 与代码实际用法不符（声明 `core` 却直连数据库等）；
3. `tables` 清单与迁移文件建的表不一致；
4. 缺 `LICENSE` / `NOTICE`（GPL 类模块）；
5. `permissions` 里有**未知能力**；
6. `compat` 与当前契约版本不匹配（且未显式声明可放宽）。

外加：`worker.js` 存在且自包含、无 `node_modules`、无 `.env`/密钥、`config` schema 合法、迁移语句满足第 6 节两条规则。

## 8. 打包与发布

```sh
unself module pack      # 在作者自己的 CI / 本地跑：构建 → 产出 .tgz → 打印 integrity
unself module validate  # 跑第 7 节全部检查
```

### 8.1 发布到 npm（模块作者路径）

```sh
npm i @unself/sdk                  # ① 唯一要装的包（能力全在里面，按需 import）
# ② 写你的模块：worker 后端（+ 可选前端）+ manifest.yaml
unself module validate             # ③ 发布前自检（第 7 节六类硬检查）
unself module pack                 # ④ 打包 → 产出可直接 `npm publish` 的 .tgz（含生成的 package.json）
npm publish                        # ⑤ 发到你自己的 scope（如 @acme/unself-todo）
```

实例侧用安装串消费：`npm:@acme/unself-todo@1.2.0`。也可以作为 git release 产物、或任意 HTTPS 可取的 tarball。**官方模块就是同一条路**（`@unself/hello` 只是恰好由项目自己发布的普通 npm 包），没有任何特权通道（决策 #77）。

### 8.2 热更边界（决策 #81）

模块可热更：重新上传模块 Worker 即可，**core 不停机**。三条边界：

1. **已打开的页面要刷新**才拿到新资产（资产哈希变了）
2. **模块迁移必须向后兼容**（记账按文件名，只有新增安全——见第 6 节）
3. **契约版本或权限声明变更**时，核心会在装配期重新签发 module-token（同样不需要重启核心）

实例侧由部署者用配置或安装器加入：

```jsonc
"modules": [
  "hello",
  { "id": "todo", "source": "npm:@acme/unself-todo@1.2.0", "mode": "docker" }
]
```

`unself.lock` 记下解析出的确切版本、`integrity`（SRI sha512）、`manifestHash` 与安装时的契约版本；**重跑一律用 lock，升级必须显式**，哈希不匹配直接拒绝安装（决策 #60）。

## 9. 运行时契约

- **身份**：模块只接受 core 签发的短时 token（`aud` = 模块 id），本地验签、零运行时网络取钥；公钥由装配器在部署期以 `vars.CORE_JWKS_JSON` 注入。
- **模块后端面（Core API 代理）**：模块带 `Authorization: Bearer <模块 token>` 调 `/api/module-api/*`；权限真值取**服务端注册表快照**的 `permissions` 声明（token 不携带能力清单，决策 #56），**未声明即调用 → 403**。当前端点：
  - `GET` / `PUT` / `DELETE` `/api/module-api/storage/:key`、`GET /api/module-api/storage/`（列键）= `core` 落点的 get/put/delete/list 四形状（**不承诺关系表**，决策 #55）
  - `POST /api/module-api/notify` = `notify` 词（站内通知，`module_notify` 类型；模块触发通知不直接发邮件）
  - `acl` / `ai` / `realtime` / `mail` 四个词**门禁已生效但端点未实现**（`501` 预留）
  - 落地与收敛：端点与 `module_notify` 由 #243 落地；`@unself/sdk` 客户端收敛（消除「SDK 直连 D1」与「Core API 代理」两条并存）归 **#248**。
- **`coreOrigin` 必填**：跨域模块必须显式配置，**禁止回落到 `'*'`**（决策 #63）。
- **模块恒挂根路径**：模块代码按「部署在根路径」编写；`/m/<id>/` 前缀由**宿主**剥离（CF wrapper / 反代 / 独立域名本就挂根）。模块不要自己实现前缀逻辑。
- **CSP / CORS**：自托管模块页必须带 `frame-ancestors <壳的 origin>`；Core API 按注册表 origin 白名单放行。
- **浏览器侧 SDK 由平台注入**（`assets/sdk/module-sdk.esm.js`），模块**不要自带**——它实现的是壳↔模块的 postMessage 协议，必须与 core 同版本。worker 侧的 `@unself/sdk` 则是普通依赖，随 bundle。
- **健康检查**：`GET /api/health`（冒烟与可达性体检用）。
- **生命周期**：`GET /life/export`、`POST /life/purge`（卸载「导出并删除」/「直接删除」用）。

## 10. 兼容与升级

- 契约版本（`CONTRACT_VERSION`，独立于产品版本）**只在破坏性变更时 bump**；增量变更不拦人（新字段有默认值、新能力进词表、新端点老模块不调用即可）。
- `compat` 省略 = 接受任意版本。注册表记「安装时的契约版本」，core 升级时据此发现潜在破坏 → 停用该模块并提示；`--allow-incompatible` 可硬上。
- **发版约定（破坏性变更定义、弃用周期、bump 责任、CI 卡点）待定。**

## 11. 待定

| 项 | 归属 |
|---|---|
| `permissions` 词表的对外可见面（首版 6 项） | 由 `@unself/sdk` 具名导出（决策 #78②；issue #294，未落） |
| 发版约定细节 | 留档待定（决策 #57） |
| DO / realtime 在 Docker 侧的平替原语 | 下一阶段 |
| `oauth` 类型配置字段的交互细节 | 下一阶段 |
