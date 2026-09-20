// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 六步向导页（#307 决策 #93）：每步一屏、步进器常驻、上一步/下一步。
 *
 * 分步化只改**渲染**——推进逻辑（状态机 + POST 端点）复用既有：
 * ① 凭证 auth → ② 域名 domain → ③ 模块 modules → ③★ 模块配置 module-config（动态 N 页）
 * → ③½ 数据存放 storage → ④ 装配 ready/deploying → ⑤ 完成 done（⑥ failed 重跑收敛）。
 * 当前步由 state.step 决定（location.reload 推进，简单可靠）；已完成的步在步进器上可回退
 * （浏览器历史 + 服务端已存 state，回退 = 返回带历史输入的表单屏）。
 *
 * 样式纪律：全部值走 var(--unself-*)（themeVarBlock 运行时注入契约令牌，含 #307 动效 token）；
 * 零魔法动效数（时长/缓动/位移取 token）；每个动画带 prefers-reduced-motion 降级；
 * color-scheme 收口 light-only（产品=亮色单主题）。
 */
import { themeVarBlock } from './server';
import {
  SHARED_CONSENT_NOTE,
  type WizardEnvHint,
  type WizardModuleConfig,
  type WizardState,
  type WizardStorageOption,
} from './state';

/** 步进器条目（⑤ 完成也是一步；failed 归属④装配屏内错误卡）。 */
const STEPS: Array<{ id: string; label: string }> = [
  { id: 'auth', label: '凭证' },
  { id: 'domain', label: '域名' },
  { id: 'modules', label: '模块' },
  { id: 'module-config', label: '配置' },
  { id: 'storage', label: '数据' },
  { id: 'ready', label: '装配' },
  { id: 'done', label: '完成' },
];

/**
 * state.step → 步进器当前位（deploying/failed 都显示在「装配」上；module-config 显示「配置」）。
 */
function stepIndex(step: WizardState['step']): number {
  if (step === 'deploying' || step === 'failed') return STEPS.findIndex((s) => s.id === 'ready');
  return Math.max(0, STEPS.findIndex((s) => s.id === step));
}

/** 顶部横向步进器：完成（✓ 可点回退）/ 当前 / 未来三态；纯 CSS。 */
function stepper(state: WizardState): string {
  const cur = stepIndex(state.step);
  const items = STEPS.map((s, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'current' : 'future';
    const clickable = i < cur ? ` data-goto="${s.id}"` : '';
    return `<li class="stp ${cls}"${clickable}><span class="stp-dot">${i < cur ? '✓' : i + 1}</span><span class="stp-label">${s.label}</span></li>`;
  }).join('');
  return `<ol class="stepper" aria-label="安装进度">${items}</ol>`;
}

/** 上一步按钮：step 前一位的标签；第一步不渲染。渲染分步的「上一步」= 浏览器回退（历史输入保留在页面表单值里）。 */
function backLabel(state: WizardState): string {
  const cur = stepIndex(state.step);
  if (cur <= 0) return '';
  return STEPS[cur - 1]!.label;
}

/** ① 步引导语（#246）：oauthUsable=false 或 CI 态 → 人话引导创建 API Token；否则引导点开折叠入口。 */
function authGuidance(hint: WizardEnvHint): string {
  if (hint.ci) return '<p class="sub">CI/无浏览器环境：创建 API Token 粘贴到下方（已设 CLOUDFLARE_API_TOKEN 则本步可跳过）。</p>';
  if (!hint.oauthUsable) return '<p class="sub">没有可借用的 wrangler OAuth：创建 API Token 粘贴到下方。</p>';
  return '<p class="sub">也可以点开下方 API Token 入口创建并粘贴。</p>';
}

/**
 * ① 步折叠入口（决策 #66）：API Token 深链接默认收起，露出条件（任一）——
 * 需 Total TLS（多级子域）/ CI 态（无浏览器）/ oauthUsable=false。`<details>` 天然支持用户点开，无需 JS。
 */
function authDetails(hint: WizardEnvHint): string {
  const open = !hint.oauthUsable || hint.ci || hint.needsTotalTls ? ' open' : '';
  const title = hint.needsTotalTls
    ? '多级子域需要 Total TLS：OAuth 不覆盖，需 API Token'
    : '手动创建 API Token（深链接入口，权限已预选）';
  return `<details class="auth-fold"${open}>
  <summary>${title}</summary>
  <p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer noopener">打开 Cloudflare 创建 API Token</a></p>
  <p>权限清单与向导失败提示一致（Account：Workers Scripts/D1/R2 Edit；Zone：Workers Routes/DNS/SSL Edit），创建后整段复制粘贴到下面密码框（掩码输入，不落盘）。</p>
</details>`;
}

/** HTML 转义（来源串/版本/SRI 都来自包元数据，进页面前一律转义）。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * ③★ 单模块配置页（#307 决策 #93 每模块一页）：manifest.config 声明驱动。
 * 控件映射：secret→password 掩码；enum→radio；boolean→checkbox；number→number；
 * url→url（https 校验）；json→textarea（提交时 JSON.parse 预检）；oauth/string→text。
 * test:'http' 出「测试连接」按钮；其他 test 标识渲染禁用按钮 + 「装配时验证」。
 */
function configPage(cfg: WizardModuleConfig, state: WizardState): string {
  const got = state.configValues[cfg.id] ?? {};
  const rows = cfg.fields
    .map((f) => {
      const cur = got[f.key] ?? f.default ?? '';
      const req = f.required ? ' <span class="req">*</span>' : '';
      const testBtn =
        f.test === 'http'
          ? `<button type="button" class="btn-test" data-mod="${esc(cfg.id)}" data-key="${esc(f.key)}">测试连接</button><span class="test-out" data-out="${esc(cfg.id)}-${esc(f.key)}"></span>`
          : f.test
            ? `<button type="button" class="btn-test" disabled title="装配时验证">装配时验证</button>`
            : '';
      let control: string;
      if (f.type === 'secret') {
        control = `<input type="password" name="${esc(f.key)}" autocomplete="new-password" placeholder="掩码输入；只存本次安装进程内存，不回显">`;
      } else if (f.type === 'enum') {
        const opts = (f.options ?? []).map((o) => `<label class="radio"><input type="radio" name="${esc(f.key)}" value="${esc(o)}" ${cur === o ? 'checked' : ''}> ${esc(o)}</label>`).join('');
        control = `<div class="opt-row">${opts}</div>`;
      } else if (f.type === 'boolean') {
        control = `<label class="radio"><input type="checkbox" name="${esc(f.key)}" value="true" ${cur === 'true' ? 'checked' : ''}> 启用</label>`;
      } else if (f.type === 'json') {
        control = `<textarea name="${esc(f.key)}" rows="4" placeholder='JSON（如 {"a":1}）'>${esc(cur)}</textarea>`;
      } else if (f.type === 'number') {
        control = `<input type="number" name="${esc(f.key)}" value="${esc(cur)}">`;
      } else if (f.type === 'url') {
        control = `<input type="url" name="${esc(f.key)}" value="${esc(cur)}" placeholder="https://…">`;
      } else {
        control = `<input type="text" name="${esc(f.key)}" value="${esc(cur)}">`;
      }
      return `<div class="field" data-type="${f.type}"><label class="field-label">${esc(f.label)}${req}<code class="field-key">${esc(f.key)}</code></label>${control}${testBtn}</div>`;
    })
    .join('\n');
  return `<section class="screen" data-screen="module-config" data-mod="${esc(cfg.id)}">
  <h2>③★ 配置模块：<span class="mod-id">${esc(cfg.id)}</span></h2>
  <p class="sub">按模块 manifest 声明收值；secret 只进本次安装进程内存（不落盘、不回显）。</p>
  ${rows}
  <p class="err" id="err-cfg-${esc(cfg.id)}"></p>
  <div class="actions">
    <button type="button" class="btn-back">← 上一步</button>
    <button type="button" class="btn-primary btn-cfg-save" data-mod="${esc(cfg.id)}">保存并继续</button>
  </div>
</section>`;
}

/**
 * ③★ 全部配置页拼接（#307）：只渲染「有声明且选中」的模块；无声明 → 空串（③ 直达 ③½）。
 * 最后一个配置页的「保存并继续」先 POST step3c 再 POST step3c/finish（进 ③½）。
 */
function configPages(state: WizardState): string {
  return state.moduleConfigs.map((c) => configPage(c, state)).join('\n');
}

/** ③ 已添加的第三方模块预览（#269）：卡片化展示（来源/版本/SRI/permissions/落点）。 */
function moduleAddsSection(state: WizardState): string {
  if (state.moduleAdds.length === 0) return '';
  const rows = state.moduleAdds
    .map((m) => {
      const sri = m.integrity ? `${esc(m.integrity).slice(0, 24)}…` : '（本地目录形态，无下载字节）';
      const perms = m.permissions.length > 0 ? esc(m.permissions.join('、')) : '（不声明任何需授权能力）';
      const storage = `accepts=${esc(m.storageAccepts.join('/'))}${m.storagePreferred ? `，preferred=${esc(m.storagePreferred)}` : ''}`;
      return `<li class="card mod-add" data-mod="${esc(m.id)}"><strong>${esc(m.id)}</strong> v${esc(m.version)}
      <ul>
        <li>来源：<code>${esc(m.source)}</code>（${esc(m.kind)}）</li>
        <li>SRI：<code>${sri}</code></li>
        <li>声明权限：${perms}</li>
        <li>数据落点：${storage}</li>
      </ul></li>`;
    })
    .join('\n    ');
  return `<h3 class="adds-title">将要安装的模块</h3>
  <ul class="mod-adds">
    ${rows}
  </ul>`;
}

/** ③½ 存储选择段（#55）：逐模块卡片单选 + shared 知情同意。无可选模块（全 core）时整段省略。 */
function storageScreen(state: WizardState, back?: string): string {
  const options: WizardStorageOption[] = state.storageOptions;
  if (options.length === 0) return '';
  const levelNote: Record<string, string> = {
    core: '经 Core API 代理（默认，推荐）',
    shared: '共享库自建表（需知情同意）',
    dedicated: '独立库（占账户配额）',
    external: '自备外部库（配置页填连接串）',
  };
  const rows = options
    .map((opt) => {
      const current = state.storageChoices[opt.id] ?? opt.preferred ?? 'core';
      const radios = opt.accepts
        .map(
          (level) =>
            `<label class="radio"><input type="radio" name="sto-${opt.id}" value="${level}" ${current === level ? 'checked' : ''}> ${level}（${levelNote[level] ?? level}）</label>`,
        )
        .join('');
      return `<fieldset class="card sto-mod" data-mod="${opt.id}"><legend>${opt.id}</legend>${radios}</fieldset>`;
    })
    .join('\n');
  const consent = `<label class="radio consent"><input type="checkbox" id="shared-consent"> ${SHARED_CONSENT_NOTE}</label>`;
  return `<section class="screen" data-screen="storage">
  <h2>③½ 数据存放</h2>
  <p class="sub">每模块四选一；声明之外的选项已被模块排除。</p>
  ${rows}
  ${consent}
  <p class="err" id="err-storage"></p>
  <div class="actions">
    ${back ?? '<button type="button" class="btn-back">← 上一步</button>'}
    <button type="button" class="btn-primary" id="btn-storage">确认存储选择</button>
  </div>
</section>`;
}

/** 资源名预览段（#272）：只读卡片（④ 装配屏内展示）。 */
function resourceNamesSection(state: WizardState): string {
  if (state.resourceNames.length === 0) return '';
  const rows = state.resourceNames
    .map((r) => `<li><code>${r.name}</code><span class="kind">${r.kind}</span></li>`)
    .join('\n    ');
  return `<details class="fold res-fold">
  <summary>本实例会占用的 Cloudflare 资源名（${state.resourceNames.length} 项）</summary>
  <ul class="res-names">
    ${rows}
  </ul>
</details>`;
}

/** 九步进度段名（引擎 rep.step(n, title) 标题的短名 → 进度条分段；#307 ④ 进度条映射）。 */
const NINE_STEP_SHORT: Record<number, string> = {
  1: '数据库',
  2: '迁移',
  3: '核心',
  4: '模块',
  5: '注册表',
  6: '存储桶',
  7: 'OIDC',
  8: 'Setup',
  9: '冒烟',
};

/** ④ 九步进度条骨架（分段填充由页面 JS 按事件流 [n/9] 推进）。 */
function deployProgress(): string {
  const segs = Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return `<div class="seg" data-seg="${n}"><span class="seg-fill"></span><span class="seg-label">${n} ${NINE_STEP_SHORT[n]}</span></div>`;
  }).join('');
  return `<div class="progress" id="deploy-progress" hidden>${segs}</div>`;
}

/**
 * 当前步一屏（渲染分步：state.step 决定渲染哪屏；推进 = POST + location.reload）。
 * 未来步不渲染（防跳步——推进权限全在 POST 端点的状态机守卫里）；已完成步回退 = 步进器点击。
 * 「上一步」取舍：用 history.back()（浏览器历史回退）而非 ?step= 重渲染——reload 推进已把每步
 * 表单值收进服务端 state，回退屏的服务端渲染值即用户输入；免一套「读 ?step 渲染旧值」的分支。
 */
function screen(state: WizardState, hint: WizardEnvHint, back: string): string {
  const backBtn = back ? '<button type="button" class="btn-back">← 上一步</button>' : '';
  void backBtn;
  switch (state.step) {
    case 'auth':
      return authScreen(state, hint);
    case 'domain':
      return domainScreen(back);
    case 'modules':
      return modulesScreen(state);
    case 'module-config':
      return configPages(state) || storageScreen(state, back);
    case 'storage':
      return storageScreen(state);
    case 'ready':
    case 'deploying':
    case 'failed':
      return deployScreen(state);
    case 'done':
      return doneScreen(state);
    default:
      return deployScreen(state);
  }
}

/** ① 凭证屏：OAuth 主路径大卡（直跳）∥ 环境凭证提示 ∥ API Token 折叠（真验三要素人话在 400 problem 里）。 */
function authScreen(state: WizardState, hint: WizardEnvHint): string {
  void state;
  const oauthCard =
    hint.oauthUsable && !hint.ci
      ? `<div class="card oauth-card">
    <p class="ok-line">✓ 已检测到本机 Cloudflare 授权</p>
    <p class="sub">检测到本机 wrangler OAuth，可零输入直跑（跳过本步）——官方支持「for use with other tools and scripts」。</p>
    <button type="button" class="btn-primary btn-big" id="btn-oauth-skip">直接下一步</button>
  </div>`
      : '';
  const envNote = hint.hasEnvToken
    ? '<p class="ok">已检测到环境变量 CLOUDFLARE_API_TOKEN——下一步时自动使用，无需粘贴。</p>'
    : authGuidance(hint);
  return `<section class="screen" data-screen="auth">
  <h2>① Cloudflare 凭证</h2>
  ${envNote}
  ${oauthCard}
  ${authDetails(hint)}
  <form id="form-auth">
    <label>API Token <input type="password" name="token" autocomplete="off" placeholder="${oauthCard ? '留空 = 使用上面的 OAuth 直跑' : '粘贴 API Token'}"></label>
    <p class="err" id="err-auth"></p>
    <div class="actions">${oauthCard ? '' : '<button class="btn-primary" type="submit">下一步</button>'}</div>
  </form>
</section>`;
}

/** ② 域名屏：workers.dev 默认卡 ∥ 自有域卡（zone 自动发现；OAuth 不可用回退手填完整域名）。 */
function domainScreen(back: string): string {
  return `<section class="screen" data-screen="domain">
  <h2>② 团队入口域名</h2>
  <p class="sub">部署后团队的登录与使用都从这个地址进；之后可加自有域。</p>
  <div class="zone-list" id="zone-area">
    <label class="card zone-card selected" id="zone-workers">
      <span class="radio"><input type="radio" name="dchoice" value="workers" checked></span>
      <span><strong>workers.dev 免费域名</strong><br><span class="desc">零输入、零配置（推荐起步）。</span></span>
    </label>
    <label class="card zone-card" id="zone-custom-card">
      <span class="radio"><input type="radio" name="dchoice" value="custom"></span>
      <span><strong>自有域名</strong><br><span class="desc">选你的 zone（自动发现），只填子域前缀。</span></span>
    </label>
  </div>
  <div id="custom-area" hidden>
    <div id="zone-pick" class="zone-list" hidden><p class="hint">正在读取账户 zone…</p></div>
    <div id="zone-fallback" hidden>
      <p class="warn">zone 自动发现不可用（OAuth 未登录或无 Zone·Read 权限）：请直接输入完整域名（如 team.example.com）。</p>
    </div>
    <label id="prefix-wrap" hidden>子域前缀 <input type="text" id="sub-prefix" placeholder="team" autocomplete="off"></label>
    <label id="fulldom-wrap" hidden>完整域名 <input type="text" id="full-domain" placeholder="team.example.com" autocomplete="off"></label>
    <p class="preview-line" id="domain-preview">team.example.com</p>
    <p class="warn" id="total-tls-warn" hidden>前缀里再含点（如 a.b）= 多级子域：Universal SSL 只盖一层，装配时会开 Total TLS（需 API Token，OAuth 不覆盖）。</p>
  </div>
  <p class="err" id="err-domain"></p>
  <div class="actions">
    ${back}
    <button class="btn-primary" id="btn-domain" type="button">下一步</button>
  </div>
</section>`;
}

/** ③ 模块屏：官方模块勾选卡（默认勾 hello）+「添加模块」收进高级折叠。 */
function modulesScreen(state: WizardState): string {
  return `<section class="screen" data-screen="modules">
  <h2>③ 启用模块</h2>
  <p class="sub">勾选要装的模块；官方模块已随安装器预装（部署零网络）。</p>
  <label class="card mod-card"><input type="checkbox" name="mod" value="hello" ${state.modules.includes('hello') ? 'checked' : ''}>
    <span><strong>hello</strong><br><span class="desc">hello world 演示模块（SDK 存储计数器）——验证安装的最小闭环。</span></span></label>
  <label class="card mod-card"><input type="checkbox" name="mod" value="chat" ${state.modules.includes('chat') ? 'checked' : ''}>
    <span><strong>chat</strong><br><span class="desc">EdgeChat 频道聊天（dedicated 独立库；专属 D1/KV/DO）。</span></span></label>
  <div id="added-mods">${moduleAddsSection(state)}</div>
  <details class="fold">
    <summary>高级：添加模块（安装串）</summary>
    <form id="form-module-add">
      <label>安装串 <input type="text" name="source" placeholder="npm:@acme/unself-todo@1.2.0 / github:acme/pkg#v1.0.0 / https://…/x.tgz / file:./modules/x"></label>
      <p class="err" id="err-module-add"></p>
      <button type="submit">添加模块</button>
    </form>
  </details>
  <p class="err" id="err-modules"></p>
  <div class="actions">
    <button type="button" class="btn-back">← 上一步</button>
    <button class="btn-primary" id="btn-modules" type="button">下一步</button>
  </div>
</section>`;
}

/** ④ 装配屏：确认行 + 撞车守卫勾选 + 九步进度条 + 可折叠终端窗（默认展开，完成后折叠）+ 失败错误卡。 */
function deployScreen(state: WizardState): string {
  const failedCard =
    state.step === 'failed' && state.error
      ? `<div class="error-card">
    <p><strong>装配失败</strong></p>
    <p class="cause">${esc(state.error.cause)}</p>
    <p class="fix">归属：${esc(state.error.owner)}；修复：${esc(state.error.fix)}</p>
  </div>`
      : '';
  const deploying = state.step === 'deploying';
  const terminalOpen = state.step === 'ready' ? ' open' : '';
  return `<section class="screen" data-screen="deploy">
  <h2>④ 装配</h2>
  <p id="confirm-line" class="sub">域名：${state.domainChoice === 'custom' ? esc(state.domain) : 'workers.dev 免费域'}；模块：${esc(state.modules.join('、'))}</p>
  ${resourceNamesSection(state)}
  ${failedCard}
  <label class="radio consent"><input type="checkbox" id="allow-adopt"> 允许接管既有同名资源（撞车守卫放行，仅在确认这些资源确属本实例时勾选）</label>
  <p class="err" id="err-deploy"></p>
  <div class="actions">
    <button type="button" class="btn-primary btn-big" id="btn-deploy" ${deploying ? 'disabled' : ''}>${deploying ? '装配中…' : '开始装配（九步）'}</button>
    ${state.step === 'failed' ? '<button type="button" class="btn-big" id="btn-retry">重跑（幂等，只补没完成的部分）</button>' : ''}
  </div>
  ${deployProgress()}
  <details class="fold terminal-fold" id="terminal-fold"${terminalOpen}>
    <summary>装配日志（九步事件流）</summary>
    <pre class="terminal" id="events"></pre>
  </details>
</section>`;
}

/** ⑤ 完成屏（peak-end）：绿勾描画 + 打开激活页 + 复制链接（同位换位）+ 部署摘要。 */
function doneScreen(state: WizardState): string {
  const r = state.result;
  const sealed = !r?.setupUrl;
  const baseUrl = r?.baseUrl ?? '';
  const link = r?.setupUrl ? baseUrl + r.setupUrl : baseUrl;
  const sealedBlock = sealed
    ? `<p class="sub">本实例已有管理员（已封箱）：直接去工作台登录。</p>
       <p><a class="btn-primary btn-big btn-link" href="${esc(baseUrl)}/login" target="_blank" rel="noreferrer noopener">打开工作台登录</a></p>`
    : `<p class="sub">激活链接只出现这一次（一次性 setup token）——请立即打开并完成管理员激活。</p>
       <p><a class="btn-primary btn-big btn-link" href="${esc(link)}" target="_blank" rel="noreferrer noopener">打开激活页</a></p>
       <p style="margin-top:var(--unself-space-3)"><button type="button" id="btn-copy-link" data-link="${esc(link)}">复制链接</button></p>`;
  return `<section class="screen" data-screen="done">
  <div class="done-wrap">
    <svg class="check-ring" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="28"/>
      <path d="M20 33 L29 42 L45 24"/>
    </svg>
    <h2>装配完成</h2>
    ${sealedBlock}
    <ul class="summary card">
      <li><span class="k">实例目录</span><code>${esc(state.instancePath)}</code></li>
      <li><span class="k">访问地址</span><code>${esc(baseUrl)}</code></li>
      <li><span class="k">模块</span>${esc(state.modules.join('、'))}</li>
    </ul>
    <p class="hint">任何时候重跑 <code>unself wizard</code> 都收敛同一终态（幂等）。</p>
  </div>
</section>`;
}

/** 页面内联脚本（#307 六步接线；POST 推进 + location.reload；每步只接当前屏的元素，全带守卫）。 */
function pageScript(state: WizardState): string {
  const isDeploying = state.step === 'deploying';
  return `"use strict";
const $ = (id) => document.getElementById(id);
for (const b of document.querySelectorAll('button.copy')) {
  b.addEventListener('click', () => navigator.clipboard.writeText($(b.dataset.copy).textContent));
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}
function showErr(id, problem) { const el = $(id); if (el) el.textContent = problem ?? ''; }
function reload() { location.reload(); }

// 步进器回退：?step=<id> 只换渲染视图（推进权限在服务端状态机守卫）
document.querySelectorAll('.stp[data-goto]').forEach((el) => {
  el.addEventListener('click', () => { location.assign('/?step=' + el.dataset.goto); });
});
// 屏内「上一步」= 浏览器历史回退（服务端已存每步值，回退屏渲染的就是已存输入）
document.querySelectorAll('.btn-back').forEach((el) => {
  el.addEventListener('click', () => { history.back(); });
});

// ① OAuth 主路径直跳（POST /api/step1 空值 = submitOAuthSkip；#246 接线）
const oauthBtn = $('btn-oauth-skip');
if (oauthBtn) oauthBtn.addEventListener('click', async () => {
  oauthBtn.disabled = true;
  const r = await post('/api/step1', { token: '' });
  r.ok ? reload() : showErr('err-auth', r.data.problem);
});
$('form-auth')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/step1', { token: e.target.token.value });
  r.ok ? reload() : showErr('err-auth', r.data.problem);
});

// ② zone 自动发现（custom 选中时拉取；不可用回退手填完整域名）
let zonePick = null;
function currentDomainInput() {
  const choice = document.querySelector('input[name=dchoice]:checked')?.value;
  if (choice !== 'custom') return { choice: 'workers', domain: '' };
  if (zonePick) {
    const p = $('sub-prefix').value.trim();
    return { choice: 'custom', domain: p ? p + '.' + zonePick.name : '' };
  }
  return { choice: 'custom', domain: $('full-domain').value.trim() };
}
function zoneDepthOk(full) {
  return Boolean(zonePick) && full.split('.').filter(Boolean).length > zonePick.name.split('.').length + 1;
}
function updatePreview() {
  const { choice, domain } = currentDomainInput();
  if (choice !== 'custom') return;
  $('domain-preview').textContent = domain || '（填前缀后这里实时预览完整域名）';
  $('total-tls-warn').hidden = !zoneDepthOk(domain);
}
async function loadZones() {
  try {
    const res = await (await fetch('/api/zones')).json();
    if (!res.ok || !res.zones.length) {
      $('zone-pick').hidden = true; $('zone-fallback').hidden = false; $('fulldom-wrap').hidden = false;
      $('full-domain').addEventListener('input', updatePreview);
      return;
    }
    $('zone-pick').innerHTML = res.zones.map((z) =>
      '<label class="card zone-card"><span class="radio"><input type="radio" name="zone" value="' + z.id + '" data-zone="' + z.name + '"></span><span><strong>' + z.name + '</strong></span></label>'
    ).join('');
    $('zone-pick').hidden = false;
    $('prefix-wrap').hidden = false;
    $('zone-pick').querySelectorAll('input[name=zone]').forEach((el) => {
      el.addEventListener('change', () => {
        zonePick = { id: el.value, name: el.dataset.zone };
        $('zone-pick').querySelectorAll('.zone-card').forEach((c) => c.classList.remove('selected'));
        el.closest('.zone-card').classList.add('selected');
        updatePreview();
      });
    });
    $('sub-prefix').addEventListener('input', updatePreview);
    updatePreview();
  } catch {
    $('zone-pick').hidden = true; $('zone-fallback').hidden = false; $('fulldom-wrap').hidden = false;
  }
}
document.querySelectorAll('input[name=dchoice]').forEach((el) => {
  el.addEventListener('change', () => {
    document.querySelectorAll('.zone-card').forEach((c) => c.classList.remove('selected'));
    if (el.value === 'workers') { $('zone-workers').classList.add('selected'); $('custom-area').hidden = true; }
    else {
      $('zone-custom-card').classList.add('selected');
      $('custom-area').hidden = false;
      if (!$('zone-pick').dataset.loaded) { $('zone-pick').dataset.loaded = '1'; loadZones(); }
    }
  });
});
$('btn-domain')?.addEventListener('click', async () => {
  const r = await post('/api/step2', currentDomainInput());
  r.ok ? reload() : showErr('err-domain', r.data.problem);
});

// ③ 模块勾选 + 高级添加
$('btn-modules')?.addEventListener('click', async () => {
  const mods = [...document.querySelectorAll('input[name=mod]:checked')].map((el) => el.value);
  const r = await post('/api/step3', { modules: mods });
  r.ok ? reload() : showErr('err-modules', r.data.problem);
});
$('form-module-add')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/step3/add', { source: e.target.source.value });
  r.ok ? reload() : showErr('err-module-add', r.data.problem);
});

// ③★ 配置页（逐模块保存 → finish 进 ③½）
function collectConfigForm(section) {
  const values = {};
  for (const el of section.querySelectorAll('input[name], textarea[name]')) {
    if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; continue; }
    if (el.type === 'checkbox') { values[el.name] = el.checked ? 'true' : 'false'; continue; }
    values[el.name] = el.value;
  }
  return values;
}
function fieldLabel(section, type) {
  const f = section.querySelector('.field[data-type="' + type + '"]');
  return f ? f.querySelector('.field-label').textContent.replace('*', '').trim() : '';
}
document.querySelectorAll('.btn-cfg-save').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mod = btn.dataset.mod;
    const section = btn.closest('.screen');
    const values = collectConfigForm(section);
    for (const el of section.querySelectorAll('.field[data-type=json] textarea[name]')) {
      const raw = (values[el.name] ?? '').trim();
      if (raw) { try { JSON.parse(raw); } catch (e) { showErr('err-cfg-' + mod, '「' + fieldLabel(section, 'json') + '」不是合法 JSON：' + e.message); return; } }
    }
    for (const el of section.querySelectorAll('.field[data-type=url] input[name]')) {
      const raw = (values[el.name] ?? '').trim();
      if (raw && !/^https?:\\/\\//.test(raw)) { showErr('err-cfg-' + mod, '「' + fieldLabel(section, 'url') + '」要以 http(s):// 开头'); return; }
    }
    btn.disabled = true;
    const r1 = await post('/api/step3c', { modId: mod, values });
    if (!r1.ok) { showErr('err-cfg-' + mod, r1.data.problem); btn.disabled = false; return; }
    const r2 = await post('/api/step3c/finish', {});
    r2.ok ? reload() : (showErr('err-cfg-' + mod, r2.data.problem), (btn.disabled = false));
  });
});
document.querySelectorAll('.btn-test[data-key]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const section = btn.closest('.screen');
    const el = section.querySelector('[name="' + btn.dataset.key + '"]');
    const url = (el?.value ?? '').trim();
    const out = section.querySelector('[data-out="' + btn.dataset.mod + '-' + btn.dataset.key + '"]');
    if (!/^https?:\\/\\//.test(url)) { if (out) out.textContent = '先填一个 http(s) 地址'; return; }
    btn.disabled = true; if (out) out.textContent = '测试中…';
    try {
      const r = await post('/api/config-test', { url });
      if (out) { out.textContent = r.data.message; out.className = r.data.ok ? 'test-out ok' : 'test-out err'; }
    } finally { btn.disabled = false; }
  });
});

// ③½ 存储
$('btn-storage')?.addEventListener('click', async () => {
  const choices = {};
  for (const opt of document.querySelectorAll('fieldset.sto-mod')) {
    const id = opt.dataset.mod;
    const checked = opt.querySelector('input[type=radio]:checked');
    if (checked) choices[id] = checked.value;
  }
  const consent = document.getElementById('shared-consent')?.checked ?? false;
  const r = await post('/api/step3b', { choices, sharedConsent: consent });
  r.ok ? reload() : showErr('err-storage', r.data.problem);
});

// ④ 装配：九步进度条 + 终端窗（默认展开，完成后折叠）
function markSeg(n, cls) {
  const seg = document.querySelector('[data-seg="' + n + '"]');
  if (seg && cls) seg.className = 'seg ' + cls;
}
async function watchDeploy() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    $('events').textContent += m.data + '\\n';
    const m2 = m.data.match(/\\[(\\d)\\/9\\]/);
    if (m2) {
      const n = Number(m2[1]);
      for (let i = 1; i < n; i++) markSeg(i, 'done');
      markSeg(n, 'running');
    }
    if (m.data.indexOf('✓ 装配完成') === 0) { for (let i = 1; i <= 9; i++) markSeg(i, 'done'); }
  };
  const timer = setInterval(async () => {
    const s = await (await fetch('/api/state')).json();
    if (s.step === 'done') {
      clearInterval(timer); es.close();
      const fold = $('terminal-fold'); if (fold) fold.open = false;
      setTimeout(reload, 600);
    }
    if (s.step === 'failed') {
      clearInterval(timer); es.close();
      const fold = $('terminal-fold'); if (fold) fold.open = true;
      showErr('err-deploy', s.error.cause + '\\n修复：' + s.error.fix);
      const b = $('btn-deploy'); if (b) b.disabled = false;
    }
  }, 800);
}
const deployBtn = $('btn-deploy');
if (deployBtn && ${isDeploying ? 'false' : 'true'}) {
  deployBtn.addEventListener('click', async () => {
    deployBtn.disabled = true;
    const r = await post('/api/step4', { allowAdopt: document.getElementById('allow-adopt')?.checked ?? false });
    if (!r.ok) { showErr('err-deploy', r.data.problem); deployBtn.disabled = false; return; }
    watchDeploy();
  });
}
if (${isDeploying ? 'true' : 'false'}) watchDeploy();
const retryBtn = $('btn-retry');
if (retryBtn) retryBtn.addEventListener('click', () => { location.reload(); });

// ⑤ 复制链接 →「已复制 ✓」同位换位（ease-spring 在 .copied 过渡上）
const copyBtn = $('btn-copy-link');
if (copyBtn) copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(copyBtn.dataset.link);
  copyBtn.textContent = '已复制 ✓';
  copyBtn.classList.add('copied');
  copyBtn.disabled = true;
});`;
}

/** 页面：页头常驻实例目录（可复制）+ 步进器 + 当前步一屏。 */
export function renderPage(state: WizardState, envHint: WizardEnvHint): string {
  const banner = envHint.ci
    ? '<p class="banner">CI/无浏览器环境：请用 CLOUDFLARE_API_TOKEN 或展开 API Token 入口</p>'
    : '';
  const back = backLabel(state);
  const hint = envHint;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unself 安装向导</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; ${themeVarBlock()} }
  * { box-sizing: border-box; }
  body { max-width: 42rem; margin: 0 auto; padding: var(--unself-space-6) var(--unself-space-4); color: var(--unself-color-text); background: var(--unself-color-bg); }
  header { display: flex; align-items: center; gap: var(--unself-space-2); border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3); margin-bottom: var(--unself-space-5); background: var(--unself-color-surface); box-shadow: var(--unself-shadow-card); }
  header strong { font-size: var(--unself-font-size-sm); }
  code { user-select: all; word-break: break-all; font-size: var(--unself-font-size-sm); }
  h2 { font-size: var(--unself-font-size-xl); margin: var(--unself-space-2) 0; }
  p.sub { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); margin: var(--unself-space-2) 0; }
  .banner { border: 1px solid var(--unself-color-warning); border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3); background: var(--unself-color-surface); margin-bottom: var(--unself-space-3); font-size: var(--unself-font-size-sm); }

  /* 步进器：三态 + 可回退 */
  .stepper { display: flex; gap: var(--unself-space-1); list-style: none; padding: 0; margin: 0 0 var(--unself-space-5); flex-wrap: wrap; }
  .stp { display: flex; align-items: center; gap: var(--unself-space-1); padding: var(--unself-space-1) var(--unself-space-2); border-radius: var(--unself-radius-full); font-size: var(--unself-font-size-sm); color: var(--unself-color-text-tertiary); transition: color var(--unself-duration-fast) var(--unself-ease-out), background var(--unself-duration-fast) var(--unself-ease-out), transform var(--unself-duration-fast) var(--unself-ease-spring); }
  .stp-dot { display: inline-flex; align-items: center; justify-content: center; width: var(--unself-space-5); height: var(--unself-space-5); border-radius: var(--unself-radius-full); border: 1px solid var(--unself-color-border); background: var(--unself-color-surface); font-size: var(--unself-font-size-xs); }
  .stp.done { color: var(--unself-color-success); cursor: pointer; }
  .stp.done:hover { background: var(--unself-color-surface-hover); transform: translateY(calc(-1 * var(--unself-motion-lift-y))); }
  .stp.done .stp-dot { border-color: var(--unself-color-success); background: var(--unself-color-success); color: var(--unself-color-surface); }
  .stp.current { color: var(--unself-color-primary); font-weight: 600; }
  .stp.current .stp-dot { border-color: var(--unself-color-primary); background: var(--unself-color-primary-soft); color: var(--unself-color-primary); }

  /* 屏与卡 */
  .screen { border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-lg); padding: var(--unself-space-5); background: var(--unself-color-surface); box-shadow: var(--unself-shadow-card); animation: screen-in var(--unself-duration-slow) var(--unself-ease-out); }
  @keyframes screen-in { from { opacity: 0; transform: translateY(var(--unself-motion-lift-y)); } to { opacity: 1; transform: translateY(0); } }
  .card { border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); padding: var(--unself-space-3); margin: var(--unself-space-2) 0; background: var(--unself-color-surface); transition: border-color var(--unself-duration-fast) var(--unself-ease-out), box-shadow var(--unself-duration-fast) var(--unself-ease-out), transform var(--unself-duration-fast) var(--unself-ease-out); }
  .card:hover { border-color: var(--unself-color-primary); box-shadow: var(--unself-shadow-pop); transform: translateY(calc(-1 * var(--unself-motion-lift-y))); }

  /* 表单 */
  label { display: block; margin: var(--unself-space-2) 0; }
  label.radio { display: flex; align-items: center; gap: var(--unself-space-2); font-size: var(--unself-font-size-base); }
  input[type=password], input[type=text], input[type=number], input[type=url], textarea { width: 100%; padding: var(--unself-space-2) var(--unself-space-3); margin-top: var(--unself-space-1); border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); font: inherit; color: var(--unself-color-text); background: var(--unself-color-bg); transition: border-color var(--unself-duration-fast) var(--unself-ease-out); }
  input:focus, textarea:focus { outline: var(--unself-focus-ring); border-color: var(--unself-color-primary); }
  .opt-row { display: flex; gap: var(--unself-space-4); flex-wrap: wrap; }
  .field { margin: var(--unself-space-3) 0; }
  .field-label { font-weight: 600; font-size: var(--unself-font-size-base); }
  .field-key { margin-left: var(--unself-space-2); color: var(--unself-color-text-tertiary); font-weight: 400; }
  .req { color: var(--unself-color-danger); }

  /* 按钮：按压 press-scale（token）+ hover 浮起（token） */
  button { font: inherit; cursor: pointer; border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); background: var(--unself-color-surface); color: var(--unself-color-text); padding: var(--unself-space-2) var(--unself-space-4); transition: transform var(--unself-duration-fast) var(--unself-ease-spring), background var(--unself-duration-fast) var(--unself-ease-out), border-color var(--unself-duration-fast) var(--unself-ease-out), opacity var(--unself-duration-fast) var(--unself-ease-out); }
  button:hover:not(:disabled) { transform: translateY(calc(-1 * var(--unself-motion-lift-y))); border-color: var(--unself-color-primary); }
  button:active:not(:disabled) { transform: scale(var(--unself-motion-press-scale)); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary { background: var(--unself-color-primary); border-color: var(--unself-color-primary); color: var(--unself-color-surface); }
  .btn-primary:hover:not(:disabled) { background: var(--unself-color-primary-hover); }
  .btn-big { font-size: var(--unself-font-size-lg); padding: var(--unself-space-3) var(--unself-space-6); }
  .actions { display: flex; gap: var(--unself-space-3); margin-top: var(--unself-space-4); align-items: center; }
  .err { color: var(--unself-color-danger); font-size: var(--unself-font-size-sm); white-space: pre-wrap; min-height: 1em; }
  .ok { color: var(--unself-color-success); }
  .hint { color: var(--unself-color-text-tertiary); font-size: var(--unself-font-size-sm); }
  .kind { color: var(--unself-color-info); margin-left: var(--unself-space-2); font-size: var(--unself-font-size-sm); }

  /* 折叠 */
  details.fold, details.auth-fold { border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3); margin: var(--unself-space-2) 0; background: var(--unself-color-surface); }
  details.fold summary, details.auth-fold summary { cursor: pointer; color: var(--unself-color-info); font-size: var(--unself-font-size-sm); }

  /* ① 主路径大卡 */
  .oauth-card { text-align: center; padding: var(--unself-space-6) var(--unself-space-4); }
  .oauth-card .ok-line { font-size: var(--unself-font-size-lg); color: var(--unself-color-success); font-weight: 600; margin-bottom: var(--unself-space-2); }

  /* ② zone 卡 + 前缀实时预览 */
  .zone-list { display: flex; flex-direction: column; gap: var(--unself-space-2); margin: var(--unself-space-3) 0; }
  .zone-card { cursor: pointer; }
  .zone-card.selected { border-color: var(--unself-color-primary); background: var(--unself-color-primary-soft); }
  .preview-line { font-size: var(--unself-font-size-lg); padding: var(--unself-space-3); border: 1px dashed var(--unself-color-border); border-radius: var(--unself-radius-md); background: var(--unself-color-bg); word-break: break-all; }
  .warn { color: var(--unself-color-warning); font-size: var(--unself-font-size-sm); }

  /* ③ 模块勾选卡 */
  .mod-card { display: flex; align-items: flex-start; gap: var(--unself-space-2); cursor: pointer; }
  .mod-card input[type=checkbox] { margin-top: var(--unself-space-1); }
  .mod-card .desc { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); }

  /* ④ 装配：进度条 + 终端窗 */
  .progress { display: flex; gap: var(--unself-space-1); margin: var(--unself-space-3) 0; flex-wrap: wrap; }
  .seg { flex: 1 1 30%; min-width: 96px; border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-sm); overflow: hidden; background: var(--unself-color-bg); position: relative; height: var(--unself-space-6); }
  .seg-fill { position: absolute; inset: 0; width: 0%; background: var(--unself-color-primary); transition: width var(--unself-duration-normal) var(--unself-ease-out); }
  .seg.running .seg-fill { width: 35%; animation: seg-pulse var(--unself-duration-slow) var(--unself-ease-out) infinite alternate; }
  .seg.done .seg-fill { width: 100%; }
  @keyframes seg-pulse { from { opacity: .5; } to { opacity: 1; } }
  .seg-label { position: relative; z-index: 1; font-size: var(--unself-font-size-xs); line-height: var(--unself-space-6); padding-left: var(--unself-space-2); color: var(--unself-color-text-secondary); }
  .seg.done .seg-label { color: var(--unself-color-surface); }
  .terminal { background: var(--unself-color-text); color: var(--unself-color-bg); border-radius: var(--unself-radius-md); padding: var(--unself-space-3); font-family: ui-monospace, monospace; font-size: var(--unself-font-size-sm); max-height: 18rem; overflow: auto; white-space: pre-wrap; }
  details.terminal-fold[open] summary { margin-bottom: var(--unself-space-2); }

  /* ⑤ 完成：绿勾描画（duration-slow + ease-out token；reduced-motion 关） */
  .done-wrap { text-align: center; padding: var(--unself-space-6) var(--unself-space-4); }
  .check-ring { width: 64px; height: 64px; margin: 0 auto var(--unself-space-4); }
  .check-ring circle { fill: none; stroke: var(--unself-color-success); stroke-width: 3; stroke-dasharray: 176; stroke-dashoffset: 176; animation: ring-draw var(--unself-duration-slow) var(--unself-ease-out) forwards; }
  .check-ring path { fill: none; stroke: var(--unself-color-success); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 48; stroke-dashoffset: 48; animation: ring-draw var(--unself-duration-slow) var(--unself-ease-out) forwards; animation-delay: var(--unself-duration-normal); }
  @keyframes ring-draw { to { stroke-dashoffset: 0; } }
  .summary { text-align: left; margin: var(--unself-space-4) auto; max-width: 28rem; }
  .summary li { margin: var(--unself-space-1) 0; font-size: var(--unself-font-size-base); list-style: none; }
  .summary .k { color: var(--unself-color-text-secondary); margin-right: var(--unself-space-2); }
  .copied { color: var(--unself-color-success); }
  button.copied { border-color: var(--unself-color-success); color: var(--unself-color-success); background: var(--unself-color-surface); transition: transform var(--unself-duration-normal) var(--unself-ease-spring); }

  ul.mod-adds { list-style: none; padding: 0; }
  ul.mod-adds ul { padding-left: var(--unself-space-5); margin: var(--unself-space-1) 0; }
  ul.res-names { padding-left: var(--unself-space-5); margin: var(--unself-space-2) 0; }
  ul.res-names li { margin: var(--unself-space-1) 0; font-size: var(--unself-font-size-sm); }

  /* 失败错误卡（三要素） */
  .error-card { border: 1px solid var(--unself-color-danger); background: var(--unself-color-danger-soft); border-radius: var(--unself-radius-md); padding: var(--unself-space-3); margin: var(--unself-space-3) 0; animation: screen-in var(--unself-duration-normal) var(--unself-ease-out); }
  .error-card .cause { color: var(--unself-color-text); word-break: break-all; }
  .error-card .fix { color: var(--unself-color-text-secondary); font-size: var(--unself-font-size-sm); }

  /* reduced-motion 降级：所有动画/过渡关闭 */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .check-ring circle, .check-ring path { stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
<header>
  <strong>实例目录</strong>：<code id="instance-path">${state.instancePath}</code>
  <button class="copy" type="button" data-copy="instance-path">复制</button>
</header>
<main data-step="${state.step}">
${banner}
${hint.needsTotalTls ? '<p class="banner">多级子域需要 Total TLS：OAuth 不覆盖，需 API Token——可在①换用 API Token 直跑。</p>' : ''}
${stepper(state)}
${screen(state, hint, back)}
</main>
<script>
${pageScript(state)}
</script>
</body>
</html>`;
}
