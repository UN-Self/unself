# Calendar 前端

日历「编辑日程」的前端，含 409 撞车对比与 3 秒轮询提示。默认 mock 模式，可在 .env.local 切真接口。

## 启动

```bash
cd app/modules/calendar/frontend
npx vite --port 5175 --strictPort
```

浏览器打开 <http://localhost:5175/>。

类型检查：

```bash
./node_modules/.bin/vue-tsc --noEmit
```

## 假壳页（联调真接口时用）

<http://localhost:5175/dev-shim.html>

模拟 Unself 工作台给模块发 token（SDK 握手），左边是握手日志，右边 iframe 装着模块页。窄屏预览加 `?w=375`。mock 模式下假壳和直接开 `/` 效果一样（都跳过握手），这个入口主要给联调用。

## mock 演示

页面底部有「模拟别人改了这条」按钮，点完等 3 秒弹黄条。三档可看：

1. **轮询黄条**：改标题 → 点模拟按钮 → 等 3 秒 → 顶部弹黄条（只有「刷新成最新」「保留我的修改」两个按钮，changes 接口不含完整日程，所以没有对比表）。
2. **409 对比**：先改标题 → 点模拟按钮 → 黄条出来后**别点刷新** → 点保存 → 撞 409 → 黄条下方出现「我填的 / 对方改成」逐字段对比。
3. **用我的重试**：在第 2 步的黄条上点「用我的重试」，拿 409 返回的 version 重新提交。

时间按浏览器本地时区显示和保存（页面顶部有说明）。

## 切真接口

默认不用配。页面启动时先试着和壳握手，1.5 秒内拿到 token 就走真接口，没壳则回落 mock。

想强制某个模式，在 `frontend/` 下建 `.env.local`（不入库）：

```
VITE_USE_MOCK=false
```

- `VITE_USE_MOCK=false` 强制真接口，`true` 强制 mock，不写就自动探测。
- `VITE_API_BASE` 默认空串表示跟当前页面同源；`/m/calendar` 前缀由宿主剥掉，不要写死 `localhost:8788`。

真接口模式下页面要先走 SDK 握手拿 token，所以要通过工作台或上面的假壳页打开。
