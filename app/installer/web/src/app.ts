// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 向导 SPA 根组件：轮询 /api/state（当前步 + 事件）→ 渲染当前屏。
 * 屏切换 = 子组件 advanced 事件 → 重新拉状态（服务端状态机是唯一真源；推进权限在 POST 端点）。
 * 步进器回退 = ?step=（服务端 viewStepOf 守卫已完成步）；页头常驻实例目录。
 */
import { computed, defineComponent, h, onMounted, ref, type VNode } from 'vue';
import { UBanner, UButton, UStepper } from '@unself/ui';
import { getJson } from './lib/api';
import { STEPS, canNavigateTo, stepIndexOf, type WizardStateDto, type WizardStep } from './lib/state-view';
import AuthScreen from './screens/auth-screen.vue';
import DomainScreen from './screens/domain-screen.vue';
import ModulesScreen from './screens/modules-screen.vue';
import ModuleConfigScreen from './screens/module-config-screen.vue';
import StorageScreen from './screens/storage-screen.vue';
import DeployScreen from './screens/deploy-screen.vue';
import DoneScreen from './screens/done-screen.vue';

/** 主区块顶部常驻横幅（CI / 多级子域），从 /api/state 的 envHint 派生。 */
const App = defineComponent({
  name: 'WizardApp',
  setup() {
    const state = ref<WizardStateDto | null>(null);
    const loadError = ref('');
    /** ?step= 渲染回退目标（本地视图覆盖；守卫语义同服务端 viewStepOf）。 */
    const viewStep = ref<WizardStep | null>(null);
    const tokenDeepLink = ref('');

    async function refresh(): Promise<void> {
      try {
        state.value = await getJson<WizardStateDto>('/api/state');
        loadError.value = '';
      } catch {
        loadError.value = '拿不到向导状态：本地服务可能已退出。回终端查看。';
      }
    }

    const viewStepOfState = computed<WizardStep>(() => {
      const s = state.value;
      if (!s) return 'auth';
      const target = viewStep.value;
      const step: WizardStep = target ? (canNavigateTo(s.step, target) ? target : s.step) : s.step;
      // ③★ 自动跳过语义（同旧 renderPage 的 configPages()||storageScreen 兜底）：
      // 视图落 module-config 但无任何声明 → 实渲染 storage 屏
      if (step === 'module-config' && s.moduleConfigs.length === 0) return 'storage';
      return step;
    });

    function gotoBack(target: WizardStep): void {
      const s = state.value;
      if (!s || !canNavigateTo(s.step, target)) return;
      viewStep.value = target;
      window.history.replaceState(null, '', `/?step=${target}`);
    }

    function clearViewOverride(): void {
      if (viewStep.value !== null) {
        viewStep.value = null;
        window.history.replaceState(null, '', '/');
      }
      void refresh();
    }

    onMounted(async () => {
      // 深链接权限预选串（服务端经 /api/state 下发，页面零硬编码权限清单）
      const params = new URLSearchParams(window.location.search);
      const step = params.get('step') as WizardStep | null;
      if (step) viewStep.value = step;
      await refresh();
      try {
        const meta = await getJson<{ tokenDeepLink: string }>('/api/meta');
        tokenDeepLink.value = meta.tokenDeepLink;
      } catch {
        tokenDeepLink.value = '';
      }
      // 推进后 URL 里的 ?step= 已失效：清掉本地视图覆盖（同旧 reload-to-root 语义）
      window.addEventListener('popstate', () => void refresh());
      // ③ 添加来源模块后：清单/资源名/声明在服务端已重算 → 重新拉状态（模块卡与预览跟随）
      window.addEventListener('wizard:module-added', () => void refresh());
    });

    const currentStep = computed<WizardStep>(() => viewStepOfState.value);
    const envHint = computed(
      () =>
        state.value?.envHint ?? { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false },
    );
    const credentialSource = computed(() => state.value?.credentialSource ?? null);

    const banners = computed<string[]>(() => {
      const out: string[] = [];
      if (envHint.value.ci) out.push('CI/无浏览器环境：请用 CLOUDFLARE_API_TOKEN 或展开 API Token 入口');
      if (envHint.value.needsTotalTls)
        out.push('多级子域需要 Total TLS：OAuth 不覆盖，需 API Token——可在①换用 API Token 直跑。');
      return out;
    });

    const stepCur = computed(() => stepIndexOf(currentStep.value));

    function screenOf(step: WizardStep): VNode {
      const s = state.value!;
      switch (step) {
        case 'auth':
          return h(AuthScreen, {
            envHint: envHint.value,
            tokenDeepLink: tokenDeepLink.value,
            onAdvanced: clearViewOverride,
          });
        case 'domain':
          return h(DomainScreen, {
            envHint: envHint.value,
            credentialSource: credentialSource.value,
            domainChoice: s.domainChoice,
            onAdvanced: clearViewOverride,
          });
        case 'modules':
          return h(ModulesScreen, {
            modules: s.modules,
            moduleAdds: s.moduleAdds,
            onAdvanced: clearViewOverride,
          });
        case 'module-config': {
          const configs = s.moduleConfigs;
          const savedAll = s.configValues;
          return h('div', [
            ...configs.map((cfg, i) =>
              h(ModuleConfigScreen, {
                key: cfg.id,
                config: cfg,
                saved: savedAll[cfg.id] ?? {},
                isLast: i === configs.length - 1,
                onAdvanced: clearViewOverride,
              }),
            ),
          ]);
        }
        case 'storage':
          return h(StorageScreen, {
            storageOptions: s.storageOptions,
            storageChoices: s.storageChoices,
            sharedConsent: s.sharedConsent,
            onAdvanced: clearViewOverride,
          });
        case 'ready':
        case 'deploying':
        case 'failed': {
          // 独立激活入口（#272 走查定稿）：failed 但第⑧步已生成一次性链接时，入口已注册可先继续。
          // 数据链 = state 本身：result.setupUrl（引擎回写）优先，事件流「一次性激活链接：」兜底。
          const resultLink = s.result?.setupUrl ? `${s.result.baseUrl}${s.result.setupUrl}` : null;
          const eventLink = s.events
            .map((event) => /一次性激活链接：\s*(https?:\/\/\S+)/.exec(event.text)?.[1] ?? null)
            .find(Boolean) ?? null;
          return h(DeployScreen, {
            domainChoice: s.domainChoice,
            domain: s.domain,
            modules: s.modules,
            resourceNames: s.resourceNames,
            step: s.step,
            error: s.error,
            events: s.events,
            deploymentLink: resultLink ?? eventLink,
            onAdvanced: clearViewOverride,
          });
        }
        case 'done':
          return h(DoneScreen, {
            result: s.result,
            instancePath: s.instancePath,
            modules: s.modules,
          });
        default:
          return h('p', { class: 'sub' }, '未知状态');
      }
    }

    return () => {
      if (loadError.value) {
        return h('p', { class: 'banner', role: 'alert' }, loadError.value);
      }
      const s = state.value;
      if (!s) {
        return h('p', { class: 'sub', 'aria-busy': 'true' }, '正在连接本地向导服务…');
      }
      return h('div', [
        h('header', { class: 'wizard-header' }, [
          h('strong', '实例目录：'),
          h('code', { id: 'instance-path' }, s.instancePath),
        ]),
        ...banners.value.map((text) => h(UBanner, { key: text }, { default: () => text })),
        h(UStepper, {
          steps: STEPS.map(({ id, label }) => ({ id, label })),
          current: stepCur.value,
          ariaLabel: '安装进度',
          onNavigate: (id: string) => gotoBack(id as WizardStep),
        }),
        h('main', { 'data-step': currentStep.value }, [screenOf(currentStep.value)]),
        h('div', { class: 'actions', style: { marginTop: 'var(--unself-space-4)' } }, [
          h(UButton, { variant: 'ghost', onClick: () => void refresh() }, { default: () => '刷新状态' }),
        ]),
      ]);
    };
  },
});

export default App;
