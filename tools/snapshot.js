/* ============================================================
 *  quizbot 结构快照 —— 把页面结构导出给我，我来写精准适配
 *
 *  用法：
 *    1. 打开你的答题页面（对话窗口那个）
 *    2. F12 → Console（控制台）
 *    3. 粘贴本文件全部内容，回车
 *    4. 页面右上角出现一个文本框，点「复制」按钮
 *    5. 把复制到的内容整段发给我
 *
 *  如果想更精准：跑完后它会提示「点击采集」，
 *  你点一下「智能体发的题目气泡」，它会额外采集那个元素的完整祖先链。
 *
 *  只读，不改动页面任何内容。
 * ============================================================ */
(function () {
  'use strict';

  if (window.__qbSnapshotRunning) {
    console.log('快照工具已在运行，看页面右上角的文本框。');
    return;
  }
  window.__qbSnapshotRunning = true;

  var L = [];
  function add(s) { L.push(s === undefined || s === null ? '' : String(s)); }
  function head(t) { add(''); add('===== ' + t + ' ====='); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + ' …[截断,共' + s.length + '字]' : s; }

  function tagOf(el) {
    if (!el || el.nodeType !== 1) return '(非元素)';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (typeof el.className === 'string' ? el.className : '').trim();
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 4).join('.');
    return s;
  }

  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    } catch (e) { return '(取不到)'; }
  }

  function ancestors(el, maxUp) {
    var out = [];
    var n = el, i = 0;
    while (n && n.nodeType === 1 && i < (maxUp || 10)) {
      out.push('  '.repeat(i) + tagOf(n) + '  rect=' + rectOf(n) +
               '  textLen=' + clean(n.textContent).length);
      n = n.parentElement;
      i++;
    }
    return out;
  }

  add('quizbot 结构快照');
  add('时间: ' + new Date().toLocaleString());
  add('版本: v1');

  /* ---------- 1. 环境 ---------- */
  head('1. 环境');
  add('URL: ' + location.href);
  add('标题: ' + document.title);
  add('是否顶层窗口: ' + (window.top === window.self));
  add('视口: ' + window.innerWidth + ' x ' + window.innerHeight);
  add('滚动位置: scrollX=' + (window.scrollX || 0) + ' scrollY=' + (window.scrollY || 0));
  add('文档元素总数: ' + document.querySelectorAll('*').length);
  add('userAgent: ' + navigator.userAgent);

  /* ---------- 2. iframe ---------- */
  head('2. iframe');
  var frames = document.querySelectorAll('iframe,frame');
  add('数量: ' + frames.length);
  Array.prototype.forEach.call(frames, function (f, i) {
    var readable = '否';
    try { if (f.contentDocument && f.contentDocument.body) readable = '是(' + f.contentDocument.querySelectorAll('*').length + '个元素)'; }
    catch (e) { readable = '跨域不可读'; }
    add('#' + i + ' ' + tagOf(f) + ' 可读=' + readable + ' rect=' + rectOf(f));
    add('    src=' + clip(f.getAttribute('src') || '', 200));
  });

  /* ---------- 3. 输入框 ---------- */
  head('3. 所有候选输入框');
  var inputs = document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]');
  add('数量: ' + inputs.length);
  Array.prototype.forEach.call(inputs, function (el, i) {
    var r = el.getBoundingClientRect();
    add('#' + i + ' ' + tagOf(el));
    add('    type=' + (el.getAttribute('type') || '-') +
        ' placeholder=' + JSON.stringify(el.getAttribute('placeholder') || '') +
        ' dataPh=' + JSON.stringify(el.getAttribute('data-placeholder') || ''));
    add('    contenteditable=' + el.getAttribute('contenteditable') +
        ' isContentEditable=' + el.isContentEditable +
        ' rect=' + rectOf(el) + ' 可见=' + (r.width > 0 && r.height > 0));
    add('    祖先链:');
    ancestors(el, 6).forEach(function (l) { add('      ' + l); });
  });

  /* ---------- 4. 候选消息容器 ---------- */
  head('4. 候选消息容器（文本量最大的可滚动区块）');
  var all = document.querySelectorAll('div,section,main,ul,ol,article');
  var cands = [];
  Array.prototype.forEach.call(all, function (el, i) {
    if (i > 8000) return;
    var r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 80) return;
    var t = clean(el.textContent);
    if (t.length < 20) return;
    cands.push({ el: el, len: t.length, r: r, scroll: el.scrollHeight > el.clientHeight + 10, kids: el.children.length, t: t });
  });
  // 按「像不像消息列表」排序，而不是按文字多少 ——
  // 否则几百条会话历史的侧栏会盖过真正的聊天区。
  function chatScore(c) {
    var score = 0;
    var cls = (typeof c.el.className === 'string' ? c.el.className : '');
    var role = String(c.el.getAttribute('role') || '');
    var live = c.el.getAttribute('aria-live');
    if (role === 'log') score += 200;
    if (live) score += 120;
    if (/message|chat|conversation|dialog|bubble|timeline|msg|会话|消息|对话/i.test(cls)) score += 150;
    if (/sidebar|nav|menu|drawer|aside|history|侧边|历史/i.test(cls)) score -= 250;
    if (/^(ASIDE|NAV)$/.test(c.el.tagName)) score -= 250;
    // 子元素签名越一致，越像「一条条消息」
    var sigs3 = {};
    Array.prototype.forEach.call(c.el.children, function (k) {
      var s = tagOf(k).split('.').slice(0, 3).join('.');
      sigs3[s] = (sigs3[s] || 0) + 1;
    });
    var counts = Object.keys(sigs3).map(function (k) { return sigs3[k]; });
    var maxc = counts.length ? Math.max.apply(null, counts) : 0;
    score += Math.min(maxc * 8, 120);
    if (c.scroll) score += 40;
    // 每个子元素平均文字量适中（太长说明是大段文章，太短说明是按钮行）
    var per = c.kids ? c.len / c.kids : c.len;
    if (per >= 8 && per <= 400) score += 30;
    if (c.r.height > 250) score += 15;
    return score;
  }
  cands.forEach(function (c) { c.score = chatScore(c); });
  cands.sort(function (a, b) { return b.score - a.score; });
  add('候选数: ' + cands.length + '，按「像消息列表的程度」排序，取前 10');
  cands.slice(0, 10).forEach(function (c, i) {
    add('');
    add('--- 候选 #' + i + ' ---');
    add('  元素: ' + tagOf(c.el));
    add('  role=' + (c.el.getAttribute('role') || '-') +
        ' ariaLive=' + (c.el.getAttribute('aria-live') || '-') +
        ' 可滚动=' + c.scroll);
    add('  匹配度得分=' + c.score + '  文本长度=' + c.len +
        ' 直接子元素数=' + c.kids + ' rect=' + rectOf(c.el));
    add('  文本开头: ' + clip(c.t, 150));
    // 子元素签名分布 —— 这是判断"消息层级"的关键
    var sigs = {};
    Array.prototype.forEach.call(c.el.children, function (k) {
      var s = tagOf(k).split('.').slice(0, 3).join('.');
      sigs[s] = (sigs[s] || 0) + 1;
    });
    var sigList = Object.keys(sigs).map(function (k) { return k + ' x' + sigs[k]; });
    add('  子元素签名: ' + clip(sigList.join(' | '), 400));
    add('  祖先链:');
    ancestors(c.el, 6).forEach(function (l) { add('    ' + l); });
  });

  /* ---------- 5. 找"像题目"的文字块 ---------- */
  head('5. 最深的文本块（题目文字通常在这里）');
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var texts = [];
  var n, guard = 0;
  while ((n = walker.nextNode())) {
    if (++guard > 60000) break;
    var raw = (n.nodeValue || '').trim();
    if (raw.length < 12) continue;
    var p = n.parentElement;
    if (!p) continue;
    var pr = p.getBoundingClientRect();
    if (pr.width === 0 || pr.height === 0) continue;
    var d = 0, cur = p;
    while (cur) { d++; cur = cur.parentElement; }
    texts.push({ t: raw, d: d, el: p, r: pr });
  }
  texts.sort(function (a, b) { return b.d - a.d; });
  add('文本块数: ' + texts.length + '，列出最深的 12 个');
  texts.slice(0, 12).forEach(function (x, i) {
    add('#' + i + ' 深度' + x.d + ' ' + tagOf(x.el) + ' rect=' + rectOf(x.el));
    add('    内容: ' + clip(clean(x.t), 120));
    add('    祖先链(4层):');
    ancestors(x.el, 4).forEach(function (l) { add('      ' + l); });
  });

  /* ---------- 6. 屏幕采样 ---------- */
  head('6. 屏幕采样点（每个点上是什么元素）');
  var vw = window.innerWidth, vh = window.innerHeight;
  var pts = [
    ['正中', vw / 2, vh / 2], ['中上', vw / 2, vh * 0.25], ['中下', vw / 2, vh * 0.7],
    ['底部中间', vw / 2, vh * 0.92], ['底部偏右', vw * 0.75, vh * 0.92],
    ['左上', vw * 0.15, vh * 0.2], ['右上', vw * 0.85, vh * 0.2]
  ];
  if (typeof document.elementFromPoint === 'function') {
    pts.forEach(function (p) {
      var el = document.elementFromPoint(Math.round(p[1]), Math.round(p[2]));
      if (!el) { add(p[0] + ' -> (无)'); return; }
      add(p[0] + ' (' + Math.round(p[1]) + ',' + Math.round(p[2]) + ') -> ' + tagOf(el) +
          ' textLen=' + clean(el.textContent).length);
      add('    文字: ' + clip(clean(el.textContent), 100));
    });
  } else {
    add('本环境不支持 elementFromPoint');
  }

  /* ---------- 7. 关键容器的 HTML 快照 ---------- */
  head('7. 关键区域 HTML 快照');
  function snapshot(el, label, maxLen) {
    if (!el) return;
    var html = el.outerHTML || '';
    add('');
    add('--- ' + label + ' ---');
    add('元素: ' + tagOf(el) + '  rect=' + rectOf(el) + '  HTML长度=' + html.length);
    add(clip(html, maxLen || 4000));
  }
  if (cands.length) {
    snapshot(cands[0].el, '★ 匹配度最高的容器（很可能是聊天区）', 6000);
    // 它内部最深的那层（真正的消息列表）
    var deepestKids = null, bestScore = -1;
    Array.prototype.forEach.call(cands[0].el.querySelectorAll('*'), function (k, i) {
      if (i > 3000) return;
      if (k.children.length < 2) return;
      var sigs2 = {};
      Array.prototype.forEach.call(k.children, function (c2) {
        sigs2[tagOf(c2).split('.').slice(0, 3).join('.')] = 1;
      });
      var kinds = Object.keys(sigs2).length;
      var score = k.children.length - kinds * 2;
      if (score > bestScore) { bestScore = score; deepestKids = k; }
    });
    snapshot(deepestKids, '推断出的消息列表层（子元素签名最一致的那层）', 6000);
  }
  var editorLike = document.querySelector('[contenteditable="true"],textarea');
  snapshot(editorLike, '输入框', 1500);

  /* ---------- 8. Shadow DOM ---------- */
  head('8. Shadow DOM');
  var hosts = [];
  Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) {
    if (el.shadowRoot) hosts.push(tagOf(el) + ' mode=' + el.shadowRoot.mode);
  });
  add('数量: ' + hosts.length);
  hosts.slice(0, 10).forEach(function (h) { add('  ' + h); });

  add('');
  add('===== 快照结束 =====');

  /* ---------- 输出面板 ---------- */
  var report = L.join('\n');

  var wrap = document.createElement('div');
  wrap.setAttribute('data-quizbot-ui', '1');
  wrap.style.cssText = 'position:fixed;right:16px;top:16px;width:520px;max-height:80vh;z-index:2147483647;' +
    'background:#fff;border:2px solid #2f6fed;border-radius:10px;padding:12px;' +
    'font:12px/1.5 "Microsoft YaHei",sans-serif;color:#222;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;';

  var bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;';

  var title = document.createElement('span');
  title.textContent = '结构快照已生成（' + report.length + ' 字）';
  title.style.cssText = 'font-weight:600;flex:1;';

  function mkBtn(label, fn, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;font-family:inherit;border:1px solid ' +
      (primary ? '#2f6fed' : '#ccc') + ';background:' + (primary ? '#2f6fed' : '#f7f7f7') + ';color:' + (primary ? '#fff' : '#222') + ';';
    b.addEventListener('click', fn);
    return b;
  }

  var ta = document.createElement('textarea');
  ta.value = report;
  ta.style.cssText = 'width:100%;flex:1;min-height:280px;font:11px/1.45 Consolas,monospace;' +
    'border:1px solid #ddd;border-radius:6px;padding:8px;box-sizing:border-box;white-space:pre;';

  var hint = document.createElement('div');
  hint.style.cssText = 'color:#666;font-size:11px;margin-top:6px;';
  hint.textContent = '点「复制」后把内容整段发我。若复制失败，就在框里按 Ctrl+A 再 Ctrl+C。';

  var copyBtn = mkBtn('复制', function () {
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(report).then(function () {
        hint.textContent = '已复制到剪贴板 ✔ 直接粘贴发我即可。';
        hint.style.color = '#0a0';
      }).catch(function () {
        hint.textContent = '复制失败，请在框里 Ctrl+A / Ctrl+C。';
        hint.style.color = '#e33';
      });
      return;
    }
    hint.textContent = ok ? '已复制 ✔ 直接粘贴发我即可。' : '复制失败，请在框里 Ctrl+A / Ctrl+C。';
    hint.style.color = ok ? '#0a0' : '#e33';
  }, true);

  var dlBtn = mkBtn('下载为文件', function () {
    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quizbot-snapshot.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  var pickBtn = mkBtn('点击采集某个气泡', function () {
    hint.textContent = '请点击页面上任意一条消息气泡…';
    hint.style.color = '#2f6fed';
    wrap.style.display = 'none';
    setTimeout(function () {
      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('click', onClick, true);
        wrap.style.display = 'flex';
        var el = e.target;
        head('9. 手动点击采集（用户点了这个元素）');
        add('点击的元素: ' + tagOf(el) + ' rect=' + rectOf(el));
        add('文字: ' + clip(clean(el.textContent), 200));
        add('祖先链:');
        ancestors(el, 12).forEach(function (l) { add('  ' + l); });
        add('');
        add('--- 该元素 outerHTML ---');
        add(clip(el.outerHTML || '', 4000));
        add('');
        add('--- 它的父元素 outerHTML ---');
        add(clip((el.parentElement && el.parentElement.outerHTML) || '', 5000));
        add('');
        add('--- 再上一层 outerHTML ---');
        add(clip((el.parentElement && el.parentElement.parentElement &&
                  el.parentElement.parentElement.outerHTML) || '', 6000));
        ta.value = L.join('\n');
        title.textContent = '已追加点击采集（共 ' + ta.value.length + ' 字）';
        hint.textContent = '采集完成，点「复制」发我。';
        hint.style.color = '#0a0';
        console.log('[quizbot] 已追加点击采集，见右上角文本框');
      }
      document.addEventListener('click', onClick, true);
    }, 50);
  });

  var closeBtn = mkBtn('关闭', function () {
    wrap.remove();
    window.__qbSnapshotRunning = false;
  });

  bar.appendChild(title);
  bar.appendChild(copyBtn);
  bar.appendChild(dlBtn);
  bar.appendChild(pickBtn);
  bar.appendChild(closeBtn);

  wrap.appendChild(bar);
  wrap.appendChild(ta);
  wrap.appendChild(hint);
  document.body.appendChild(wrap);

  console.log('%c quizbot 结构快照已生成 ', 'background:#2f6fed;color:#fff;padding:3px 8px;');
  console.log('共 ' + report.length + ' 字，见页面右上角文本框。点「复制」后发回。');
  window.__qbSnapshotReport = report;
  return report;
})();
