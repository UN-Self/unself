// SPDX-License-Identifier: AGPL-3.0-only

/**
 * calendar 模块页：月历 + 当日面板 + 新增日程表单（本模块前端，§6.5 同款动线）。
 *
 * 硬约束（均有测试门禁）：
 * - 样式只引用 var(--unself-*) 令牌，页面不定义任何令牌、不出现裸色值（page-theme.test.ts）；
 * - coreOrigin 取 resolveShellOrigin()，不得写死自身 origin（page-shell-origin.test.ts，#277）；
 * - 页面内 fetch/import 全用相对路径：同一路径制下模块同时挂 /m/calendar/（部署）
 *   与开发期根路径，根相对路径只在后者成立（#14）；
 * - token 由壳经 SDK ready 握手下发，页面不自行管理凭证；静默续期走 startTokenLoop。
 */

export function renderCalendarPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>calendar</title>
  <style>
    /* 令牌唯一来源 = 壳注入（§6.5.5 通道 A/B）；页面只引用 --unself- 前缀变量，不持有值副本 */
    * { box-sizing: border-box; }
    body { margin: 0; font: var(--unself-font-size-base)/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
           color: var(--unself-color-text); background: var(--unself-color-bg); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: var(--unself-space-6) var(--unself-space-4) var(--unself-space-8); }

    /* 顶栏 */
    .bar { display: flex; align-items: center; gap: var(--unself-space-3); margin-bottom: var(--unself-space-4); flex-wrap: wrap; }
    .bar h1 { margin: 0; font-size: var(--unself-font-size-xl); font-weight: 600; }
    .bar .who { font-size: var(--unself-font-size-sm); color: var(--unself-color-text-secondary); }
    .bar .spacer { flex: 1; }
    .status { width: 100%; margin: 0; font-size: var(--unself-font-size-sm); color: var(--unself-color-danger); }

    /* 按钮 */
    button { font: inherit; cursor: pointer; border-radius: var(--unself-radius-md); border: 1px solid transparent;
             transition: background var(--unself-duration-fast) var(--unself-ease-out); }
    button:disabled { opacity: .6; cursor: wait; }
    .btn-primary { background: var(--unself-color-primary); color: var(--unself-color-surface);
                   padding: var(--unself-space-2) var(--unself-space-4); }
    .btn-primary:hover { background: var(--unself-color-primary-hover); }
    .btn-ghost { background: var(--unself-color-surface); border-color: var(--unself-color-border);
                 color: var(--unself-color-text); padding: var(--unself-space-1) var(--unself-space-3); }
    .btn-ghost:hover { background: var(--unself-color-surface-hover); }
    .btn-icon { background: transparent; color: var(--unself-color-text-secondary);
                padding: var(--unself-space-1) var(--unself-space-2); font-size: var(--unself-font-size-lg); line-height: 1; }
    .btn-icon:hover { background: var(--unself-color-surface-hover); color: var(--unself-color-primary); }

    /* 主体布局 */
    .layout { display: flex; gap: var(--unself-space-4); align-items: flex-start; }
    .card { background: var(--unself-color-surface); border: 1px solid var(--unself-color-border);
            border-radius: var(--unself-radius-lg); box-shadow: var(--unself-shadow-card); padding: var(--unself-space-4); }
    .cal-card { flex: 1; min-width: 0; }
    .day-card { width: 280px; flex: none; }

    /* 日历 */
    .cal-head { display: flex; align-items: center; gap: var(--unself-space-2); margin-bottom: var(--unself-space-3); }
    .cal-head h2 { flex: 1; margin: 0; text-align: center; font-size: var(--unself-font-size-lg); font-weight: 600; }
    .weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--unself-space-1);
                padding-bottom: var(--unself-space-1); margin-bottom: var(--unself-space-1);
                border-bottom: 1px solid var(--unself-color-border); }
    .weekdays span { text-align: center; font-size: var(--unself-font-size-xs); color: var(--unself-color-text-secondary); }
    .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--unself-space-1); }
    .cell { min-height: 84px; padding: var(--unself-space-1); border: 1px solid var(--unself-color-border);
            border-radius: var(--unself-radius-md); background: var(--unself-color-surface); cursor: pointer;
            overflow: hidden; transition: background var(--unself-duration-fast) var(--unself-ease-out); }
    .cell:hover { background: var(--unself-color-surface-hover); }
    .cell.other { background: var(--unself-color-surface-active); }
    .cell.other .num { color: var(--unself-color-text-tertiary); }
    .cell.selected { border-color: var(--unself-color-primary); background: var(--unself-color-primary-soft); }
    .num { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
           border-radius: var(--unself-radius-full); font-size: var(--unself-font-size-sm); }
    .cell.today .num { background: var(--unself-color-primary); color: var(--unself-color-surface); font-weight: 600; }
    .evt { display: block; margin-top: var(--unself-space-1); padding: 0 var(--unself-space-1);
           border-radius: var(--unself-radius-sm); background: var(--unself-color-primary-soft);
           color: var(--unself-color-primary); font-size: var(--unself-font-size-xs); line-height: 1.4;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .more { display: block; margin-top: var(--unself-space-1); font-size: var(--unself-font-size-xs);
            color: var(--unself-color-text-tertiary); }
    .hint { margin: var(--unself-space-3) 0 0; text-align: center; font-size: var(--unself-font-size-xs);
            color: var(--unself-color-text-tertiary); }

    /* 当日面板 */
    .day-head { display: flex; align-items: center; justify-content: space-between; gap: var(--unself-space-2);
                margin-bottom: var(--unself-space-3); }
    .day-head h2 { margin: 0; font-size: var(--unself-font-size-base); font-weight: 600; }
    .day-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--unself-space-2); }
    .day-list li { border-left: 3px solid var(--unself-color-primary); background: var(--unself-color-surface-hover);
                   border-radius: var(--unself-radius-sm); padding: var(--unself-space-2) var(--unself-space-3); }
    .day-list li.empty { border-left-color: transparent; background: transparent; text-align: center;
                         color: var(--unself-color-text-tertiary); padding: var(--unself-space-6) 0; }
    .ev-time { display: block; font-size: var(--unself-font-size-xs); color: var(--unself-color-text-secondary); }
    .ev-title { display: block; font-weight: 600; margin-top: var(--unself-space-1); }
    .ev-loc { display: block; font-size: var(--unself-font-size-xs); color: var(--unself-color-text-secondary);
              margin-top: var(--unself-space-1); }

    /* 弹窗（遮罩走 scrim 令牌） */
    .mask { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
            padding: var(--unself-space-4); background: var(--unself-color-scrim); }
    .mask[hidden] { display: none; }
    .modal { width: 460px; max-width: 100%; max-height: calc(100vh - 32px); overflow: auto;
             background: var(--unself-color-surface); border: 1px solid var(--unself-color-border);
             border-radius: var(--unself-radius-lg); box-shadow: var(--unself-shadow-pop);
             padding: var(--unself-space-6); }
    .modal h2 { margin: 0 0 var(--unself-space-4); font-size: var(--unself-font-size-lg); font-weight: 600; }
    .alert { background: var(--unself-color-danger-soft); color: var(--unself-color-danger);
             border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3);
             margin-bottom: var(--unself-space-4); font-size: var(--unself-font-size-sm); }
    .alert[hidden] { display: none; }

    /* 表单 */
    .field { display: block; margin-bottom: var(--unself-space-4); }
    .field > span { display: block; font-size: var(--unself-font-size-sm); color: var(--unself-color-text-secondary);
                    margin-bottom: var(--unself-space-1); }
    .field em { font-style: normal; color: var(--unself-color-danger); }
    .field input, .field textarea { display: block; width: 100%; padding: var(--unself-space-2) var(--unself-space-3);
             border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md);
             font: inherit; color: var(--unself-color-text); background: var(--unself-color-surface); outline: none;
             transition: border-color var(--unself-duration-fast) var(--unself-ease-out); }
    .field textarea { resize: vertical; }
    .field input:focus, .field textarea:focus { border-color: var(--unself-color-primary); outline: var(--unself-focus-ring); }
    .field input.invalid { border-color: var(--unself-color-danger); }
    .ferr { display: block; min-height: 1em; margin-top: var(--unself-space-1); font-size: var(--unself-font-size-xs);
            color: var(--unself-color-danger); }
    .time-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--unself-space-3); }
    .foot { display: flex; justify-content: flex-end; gap: var(--unself-space-2); }

    /* Toast */
    .toast { position: fixed; top: var(--unself-space-4); right: var(--unself-space-4); z-index: 20;
             padding: var(--unself-space-2) var(--unself-space-4); border-radius: var(--unself-radius-md);
             color: var(--unself-color-surface); box-shadow: var(--unself-shadow-pop);
             font-size: var(--unself-font-size-sm); }
    .toast.ok { background: var(--unself-color-success); }
    .toast.bad { background: var(--unself-color-danger); }
    .toast[hidden] { display: none; }

    @media (max-width: 880px) {
      .layout { flex-direction: column; }
      .day-card { width: auto; }
      .cell { min-height: 56px; }
      .time-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="bar">
      <h1>日程</h1>
      <span class="who" id="who">加载中…</span>
      <span class="spacer"></span>
      <button class="btn-primary" id="btn-new" type="button">新增日程</button>
      <p class="status" id="err" role="alert" hidden></p>
    </header>

    <div class="layout">
      <section class="card cal-card">
        <div class="cal-head">
          <button class="btn-icon" id="cal-prev" type="button" title="上个月" aria-label="上个月">‹</button>
          <h2 id="cal-title">—</h2>
          <button class="btn-icon" id="cal-next" type="button" title="下个月" aria-label="下个月">›</button>
          <button class="btn-ghost" id="cal-today" type="button">回到今天</button>
        </div>
        <div class="weekdays">
          <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
        </div>
        <div class="grid" id="grid"></div>
        <p class="hint">单击选择日期 · 双击日期新建当天日程</p>
      </section>

      <aside class="card day-card">
        <div class="day-head">
          <h2 id="day-title">未选择日期</h2>
          <button class="btn-ghost" id="btn-new-day" type="button">+ 新增</button>
        </div>
        <ul class="day-list" id="day-list"></ul>
      </aside>
    </div>
  </main>

  <!-- 新增日程弹窗 -->
  <div class="mask" id="mask" hidden>
    <form class="modal" id="form" novalidate>
      <h2>新增日程</h2>
      <p class="alert" id="form-alert" role="alert" hidden></p>

      <label class="field"><span>标题 <em>*</em></span>
        <input id="f-title" type="text" maxlength="60" placeholder="如：项目会议" autocomplete="off" />
        <span class="ferr" id="err-title"></span>
      </label>

      <label class="field"><span>描述</span>
        <textarea id="f-desc" rows="3" placeholder="补充说明（选填）"></textarea>
      </label>

      <label class="field"><span>地点</span>
        <input id="f-loc" type="text" maxlength="60" placeholder="如：会议室 A（选填）" autocomplete="off" />
      </label>

      <div class="time-row">
        <label class="field"><span>开始时间 <em>*</em></span>
          <input id="f-start" type="datetime-local" />
          <span class="ferr" id="err-start"></span>
        </label>
        <label class="field"><span>结束时间 <em>*</em></span>
          <input id="f-end" type="datetime-local" />
          <span class="ferr" id="err-end"></span>
        </label>
      </div>

      <div class="foot">
        <button class="btn-ghost" id="btn-cancel" type="button">取消</button>
        <button class="btn-primary" id="btn-submit" type="submit">保存</button>
      </div>
    </form>
  </div>

  <div class="toast" id="toast" hidden></div>

  <script type="module">
    import { createModuleSDK, resolveShellOrigin } from './sdk/module-sdk.esm.js';

    // coreOrigin = 壳 origin（workers.dev 形态模块挂自有子域，取自身 origin 会导致握手永不命中，issue 277）
    var sdk = createModuleSDK({ moduleId: 'calendar', coreOrigin: resolveShellOrigin() });

    var WEEKS = ['一', '二', '三', '四', '五', '六', '日'];
    var state = {
      year: new Date().getFullYear(),
      month: new Date().getMonth(),
      selected: null,
      events: []
    };
    var token = '';
    var toastTimer = null;

    function $(id) { return document.getElementById(id); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fail(message) { var e = $('err'); e.textContent = message; e.hidden = false; }

    /** datetime-local 值 -> 带本地时区偏移的 ISO 8601（与后端契约一致，避免服务器按 UTC 误读本地时间） */
    function toIsoLocal(v) {
      var d = new Date(v);
      if (isNaN(d.getTime())) return null;
      var off = -d.getTimezoneOffset();
      var sign = off >= 0 ? '+' : '-';
      var abs = Math.abs(off);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
    }
    /** 后端存的 UTC ISO -> 本地 HH:mm */
    function fmtHM(iso) { var d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    function localInput(d) {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /* ---------- 数据 ---------- */

    function eventsByDate() {
      var map = {};
      for (var i = 0; i < state.events.length; i++) {
        var key = dateKey(new Date(state.events[i].start_time));
        if (!map[key]) map[key] = [];
        map[key].push(state.events[i]);
      }
      return map;
    }

    async function loadEvents() {
      try {
        var res = await fetch('api/events', { headers: { authorization: 'Bearer ' + token } });
        if (res.status === 401) { fail('登录已过期，请刷新页面'); return; }
        if (!res.ok) { fail('日程加载失败，请稍后重试'); return; }
        var body = await res.json();
        state.events = Array.isArray(body.events) ? body.events : [];
        $('err').hidden = true;
      } catch (e) {
        fail('网络不可用，请重试');
      }
    }

    /* ---------- 日历渲染 ---------- */

    function renderCalendar() {
      $('cal-title').textContent = state.year + ' 年 ' + (state.month + 1) + ' 月';
      var grid = $('grid');
      grid.innerHTML = '';

      var map = eventsByDate();
      var todayKey = dateKey(new Date());
      var first = new Date(state.year, state.month, 1);
      var offset = (first.getDay() + 6) % 7; // 周一开头

      for (var i = 0; i < 42; i++) {
        var d = new Date(state.year, state.month, 1 - offset + i);
        var key = dateKey(d);
        var evts = map[key] || [];

        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.date = key;
        if (d.getMonth() !== state.month) cell.classList.add('other');
        if (key === todayKey) cell.classList.add('today');
        if (state.selected === key) cell.classList.add('selected');

        var html = '<span class="num">' + d.getDate() + '</span>';
        for (var j = 0; j < Math.min(evts.length, 3); j++) {
          html += '<span class="evt" title="' + esc(evts[j].title) + '">' + esc(evts[j].title) + '</span>';
        }
        if (evts.length > 3) html += '<span class="more">+' + (evts.length - 3) + ' 条</span>';
        cell.innerHTML = html;

        cell.addEventListener('click', onCellClick);
        grid.appendChild(cell);
      }
      renderDay();
    }

    function onCellClick(e) {
      var cell = e.currentTarget;
      // 只切换样式不重建 DOM：重建会让双击的第二次点击落在新元素上，dblclick 不触发
      state.selected = cell.dataset.date;
      var cells = $('grid').children;
      for (var i = 0; i < cells.length; i++) {
        cells[i].classList.toggle('selected', cells[i].dataset.date === state.selected);
      }
      renderDay();
    }

    function renderDay() {
      var listEl = $('day-list');
      if (!state.selected) {
        $('day-title').textContent = '未选择日期';
        listEl.innerHTML = '<li class="empty">单击日历中的日期查看当日日程</li>';
        return;
      }
      var evts = eventsByDate()[state.selected] || [];
      var d = new Date(state.selected + 'T00:00:00');
      $('day-title').textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周'
        + WEEKS[(d.getDay() + 6) % 7];

      if (!evts.length) {
        listEl.innerHTML = '<li class="empty">当天暂无日程</li>';
        return;
      }
      var html = '';
      for (var i = 0; i < evts.length; i++) {
        var ev = evts[i];
        html += '<li>'
          + '<span class="ev-time">' + esc(fmtHM(ev.start_time)) + ' – ' + esc(fmtHM(ev.end_time)) + '</span>'
          + '<span class="ev-title">' + esc(ev.title) + '</span>'
          + (ev.location ? '<span class="ev-loc">' + esc(ev.location) + '</span>' : '')
          + '</li>';
      }
      listEl.innerHTML = html;
    }

    function focusDate(key) {
      var d = new Date(key + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      state.year = d.getFullYear();
      state.month = d.getMonth();
      state.selected = key;
      renderCalendar();
    }

    function upsertEvent(event) {
      state.events = state.events.filter(function (item) { return item.id !== event.id; });
      state.events.push(event);
      state.events.sort(function (a, b) { return a.start_time.localeCompare(b.start_time); });
    }

    /* ---------- 新增日程弹窗 ---------- */

    function openModal(dateStr) {
      $('form-alert').hidden = true;
      clearErrors();
      $('f-title').value = '';
      $('f-desc').value = '';
      $('f-loc').value = '';

      var start, end;
      if (dateStr) {
        start = new Date(dateStr + 'T09:00');
        end = new Date(dateStr + 'T10:00');
      } else {
        start = new Date();
        start.setMinutes(0, 0, 0);
        start.setHours(start.getHours() + 1);
        end = new Date(start.getTime() + 3600000);
      }
      $('f-start').value = localInput(start);
      $('f-end').value = localInput(end);

      var btn = $('btn-submit');
      btn.disabled = false;
      btn.textContent = '保存';

      $('mask').hidden = false;
      setTimeout(function () { $('f-title').focus(); }, 50);
    }

    function closeModal() { $('mask').hidden = true; }

    function setErr(inputId, errId, msg) {
      $(errId).textContent = msg;
      $(inputId).classList.toggle('invalid', !!msg);
    }

    function clearErrors() {
      setErr('f-title', 'err-title', '');
      setErr('f-start', 'err-start', '');
      setErr('f-end', 'err-end', '');
    }

    function validate() {
      clearErrors();
      var ok = true;
      var title = $('f-title').value.trim();
      var start = $('f-start').value;
      var end = $('f-end').value;

      if (!title) { setErr('f-title', 'err-title', '请填写日程标题'); ok = false; }
      if (!start) { setErr('f-start', 'err-start', '请选择开始时间'); ok = false; }
      if (!end) { setErr('f-end', 'err-end', '请选择结束时间'); ok = false; }
      if (start && end && new Date(end) <= new Date(start)) {
        setErr('f-end', 'err-end', '结束时间必须晚于开始时间'); ok = false;
      }
      return ok;
    }

    var ERROR_TEXT = {
      'invalid event data': '必填字段缺失或数据类型错误，请检查标题和时间',
      'invalid event time': '时间非法，或结束时间不晚于开始时间',
      'failed to create event': '服务器创建日程失败，请稍后重试'
    };

    async function submitEvent(e) {
      e.preventDefault();
      $('form-alert').hidden = true;
      if (!validate()) return;

      var payload = {
        title: $('f-title').value.trim(),
        description: $('f-desc').value.trim(),
        location: $('f-loc').value.trim(),
        start_time: toIsoLocal($('f-start').value),
        end_time: toIsoLocal($('f-end').value)
      };

      var btn = $('btn-submit');
      btn.disabled = true;
      btn.textContent = '保存中…';

      try {
        var res = await fetch('api/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify(payload)
        });
        if (res.status === 401) { showModalError('登录已过期，请刷新页面', 401, ''); return; }
        var body = {};
        try { body = await res.json(); } catch (e2) { body = {}; }
        if (res.ok) {
          var created = body.event;
          if (!created || typeof created.id !== 'string' || typeof created.start_time !== 'string') {
            showModalError('服务器返回的日程数据无效', res.status, 'invalid response');
            return;
          }
          upsertEvent(created);
          focusDate(dateKey(new Date(created.start_time)));
          closeModal();
          toast('ok', '日程已创建');
          return;
        }
        var text = ERROR_TEXT[body.error] || ('请求失败（HTTP ' + res.status + '）');
        showModalError(text, res.status, body.error || '');
      } catch (e) {
        showModalError('网络不可用，请重试', 0, '');
      } finally {
        btn.disabled = false;
        btn.textContent = '保存';
      }
    }

    function showModalError(text, status, error) {
      var detail = status ? '（HTTP ' + status + (error ? ' · ' + error : '') + '）' : '';
      var el = $('form-alert');
      el.textContent = text + detail;
      el.hidden = false;
      toast('bad', '日程创建失败');
    }

    function toast(kind, text) {
      var t = $('toast');
      t.className = 'toast ' + kind;
      t.textContent = text;
      t.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
    }

    /* ---------- 接线 ---------- */

    $('btn-new').addEventListener('click', function () { openModal(null); });
    $('btn-new-day').addEventListener('click', function () { openModal(state.selected || null); });
    $('btn-cancel').addEventListener('click', closeModal);
    $('form').addEventListener('submit', submitEvent);
    $('cal-prev').addEventListener('click', function () {
      var d = new Date(state.year, state.month - 1, 1);
      state.year = d.getFullYear(); state.month = d.getMonth(); renderCalendar();
    });
    $('cal-next').addEventListener('click', function () {
      var d = new Date(state.year, state.month + 1, 1);
      state.year = d.getFullYear(); state.month = d.getMonth(); renderCalendar();
    });
    $('cal-today').addEventListener('click', function () {
      var now = new Date();
      state.year = now.getFullYear(); state.month = now.getMonth(); state.selected = dateKey(now);
      renderCalendar();
    });
    $('grid').addEventListener('dblclick', function (e) {
      var cell = e.target.closest('.cell');
      if (cell) openModal(cell.dataset.date);
    });
    $('mask').addEventListener('click', function (e) { if (e.target === $('mask')) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('mask').hidden) closeModal();
    });

    // 先画空日历（token 未就绪时页面不空白），握手成功后拉数据
    state.selected = dateKey(new Date());
    renderCalendar();

    // 握手超时兜底：壳异常不回 token 时给人话，不永久停在「加载中」
    function tokenWithTimeout(ms) {
      return Promise.race([
        sdk.waitForToken(),
        new Promise(function (resolve, reject) {
          setTimeout(function () { reject(new Error('token timeout')); }, ms);
        }),
      ]);
    }

    sdk.ready();
    try {
      token = await tokenWithTimeout(15000);
    } catch (e) {
      token = '';
      fail('登录初始化超时，请刷新页面重试');
    }

    if (token) {
      var claims = sdk.decodeContext(token);
      // claims 无 email 字段（ModuleTokenClaimsSchema）：身份行只展示 name/sub
      $('who').textContent = claims.name ?? claims.sub;
      await loadEvents();
      renderCalendar();

      // 静默续期：token 更新后跟随刷新本地副本
      sdk.startTokenLoop(token, function (next) { token = next; });
    }
  </script>
</body>
</html>`;
}
