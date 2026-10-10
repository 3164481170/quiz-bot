/* ============================================================
 *  页面结构诊断 —— 找不出问题时长按用这个
 *
 *  用法：
 *    1. 打开你的答题页面（就是那个对话窗口）
 *    2. 按 F12 打开开发者工具，切到「控制台 / Console」
 *    3. 把本文件全部内容复制粘贴进去，回车
 *    4. 把输出结果整段发回给我
 *
 *  它只读不写，不会改动页面任何内容。
 * ============================================================ */
(function () {
  'use strict';

  function line(title) {
    console.log('\n===== ' + title + ' =====');
  }

  console.log('%c quizbot 页面结构诊断 ', 'background:#2f6fed;color:#fff;font-size:14px;padding:4px 8px;');

  // ---------- 1. 是否在 iframe 里 ----------
  line('1. 文档层级');
  console.log('当前是否顶层窗口 (window.top === window.self):', window.top === window.self);
  console.log('当前 URL:', location.href);
  var iframes = document.querySelectorAll('iframe,frame');
  console.log('本页 iframe 数量:', iframes.length);
  Array.prototype.forEach.call(iframes, function (f, i) {
    var info = { '#': i, src: (f.getAttribute('src') || '').slice(0, 120),
                 id: f.id || '', cls: String(f.className || '').slice(0, 60), 可读: false };
    try { if (f.contentDocument && f.contentDocument.body) info.可读 = true; } catch (e) { info.可读 = '跨域'; }
    console.log(info);
  });

  // ---------- 2. 输入框 ----------
  line('2. 所有可能的输入框');
  var inputs = document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"]');
  console.log('候选数量:', inputs.length);
  Array.prototype.forEach.call(inputs, function (el, i) {
    var r = el.getBoundingClientRect();
    console.log({
      '#': i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      cls: String(el.className || '').slice(0, 70),
      placeholder: (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').slice(0, 40),
      contenteditable: el.getAttribute('contenteditable'),
      isContentEditable: el.isContentEditable,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      可见: r.width > 0 && r.height > 0
    });
  });

  // ---------- 3. 文本最长的可滚动容器（消息区通常在这类容器里） ----------
  line('3. 候选消息容器（按文本量排序）');
  var all = document.querySelectorAll('div,section,main,ul,ol,article');
  var cands = [];
  Array.prototype.forEach.call(all, function (el, i) {
    if (i > 6000) return;
    var r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 100) return;
    var text = (el.textContent || '').trim();
    if (text.length < 30) return;
    cands.push({
      el: el, textLen: text.length, rect: r,
      scrollable: el.scrollHeight > el.clientHeight + 10,
      childCount: el.children.length
    });
  });
  cands.sort(function (a, b) { return b.textLen - a.textLen; });
  cands.slice(0, 12).forEach(function (c, i) {
    var el = c.el;
    console.log({
      '#': i,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: String(el.className || '').slice(0, 70),
      role: el.getAttribute('role') || '',
      ariaLive: el.getAttribute('aria-live') || '',
      文本长度: c.textLen,
      子元素数: c.childCount,
      可滚动: c.scrollable,
      rect: [Math.round(c.rect.left), Math.round(c.rect.top), Math.round(c.rect.width), Math.round(c.rect.height)],
      文本开头: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    });
  });

  // ---------- 4. Shadow DOM 检测 ----------
  line('4. Shadow DOM');
  var hosts = [];
  Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) {
    if (el.shadowRoot) hosts.push({ tag: el.tagName.toLowerCase(), id: el.id || '',
                                    cls: String(el.className || '').slice(0, 60), mode: el.shadowRoot.mode });
  });
  console.log('带 shadowRoot 的元素数:', hosts.length);
  hosts.slice(0, 10).forEach(function (h) { console.log(h); });

  // ---------- 5. 页面坐标系里的关键点探测 ----------
  line('5. 屏幕采样：每个取样点上到底是什么元素');
  var vw = window.innerWidth, vh = window.innerHeight;
  console.log('视口尺寸:', vw + ' x ' + vh);
  var samples = [
    ['正中', Math.round(vw / 2), Math.round(vh / 2)],
    ['中上', Math.round(vw / 2), Math.round(vh * 0.3)],
    ['中下', Math.round(vw / 2), Math.round(vh * 0.75)],
    ['底部中间', Math.round(vw / 2), Math.round(vh * 0.9)],
    ['底部偏右', Math.round(vw * 0.75), Math.round(vh * 0.9)]
  ];
  samples.forEach(function (s) {
    var el = document.elementFromPoint(s[1], s[2]);
    if (!el) { console.log(s[0] + ' -> (无元素)'); return; }
    console.log(s[0] + ' -> ' + el.tagName.toLowerCase() +
                (el.id ? '#' + el.id : '') +
                (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') +
                ' | 文本: ' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50));
  });

  // ---------- 6. 最长文本块（可能就是题目所在） ----------
  line('6. 深度最大的文本节点（题目文字通常在这里）');
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var texts = [];
  var n;
  while ((n = walker.nextNode())) {
    var t = (n.nodeValue || '').trim();
    if (t.length < 15) continue;
    var p = n.parentElement;
    if (!p) continue;
    var pr = p.getBoundingClientRect();
    if (pr.width === 0) continue;
    var depth = 0, cur = p;
    while (cur) { depth++; cur = cur.parentElement; }
    texts.push({ t: t, depth: depth, el: p, rect: pr });
  }
  texts.sort(function (a, b) { return b.depth - a.depth || b.t.length - a.t.length; });
  texts.slice(0, 10).forEach(function (x, i) {
    console.log('#' + i + ' 深度' + x.depth + ' | ' +
                x.el.tagName.toLowerCase() +
                (x.el.className && typeof x.el.className === 'string' ? '.' + x.el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') +
                ' | rect=' + [Math.round(x.rect.left), Math.round(x.rect.top), Math.round(x.rect.width), Math.round(x.rect.height)].join(',') +
                ' | ' + x.t.replace(/\s+/g, ' ').slice(0, 70));
  });

  line('诊断完成');
  console.log('%c 请把以上全部输出复制发回 ', 'background:#0a0;color:#fff;padding:3px 8px;');
})();
