// ==UserScript==
// @name         AI 网页答题助手
// @namespace    https://local/quizbot
// @version      1.11.2
// @description  读取网页上的题目 -> 调用你自己配置的 AI API 生成答案 -> 自动填入输入框
// @author       quiz-bot
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

/*
 * ============================ 使用说明 ============================
 * 1. 安装 Tampermonkey（篡改猴），新建脚本，粘贴本文件并保存。
 * 2. 打开答题页面，右下角会出现圆形按钮「AI」，点开面板。
 * 3. 点「设置」，填入你自己的 API（base_url / api_key / model），保存。
 * 4. 点「读取题目」确认抓取正确，再点「AI 作答并填写」。
 *
 * 没有 Tampermonkey 时，也可以把本文件内容整体粘到浏览器控制台（F12）执行；
 * 此时配置存在 localStorage，且要求你的 API 支持浏览器跨域（CORS）调用。
 *
 * ============================ 实现要点 ============================
 * - 写值用「原生 value setter + input/change 事件」，React/Vue 才能感知到。
 * - 单选/多选调用 el.click()，保证框架绑定的事件被触发。
 * - 题干提取：从输入框向上找容器，再剥掉选项行，适配大多数题库页面。
 * - 题目定位用「运行时句柄表」而非 CSS 选择器，避免动态页面选择器失效。
 */

(function () {
  'use strict';

  var VERSION = '1.11.2';
  var TICK = String.fromCharCode(96);
  var FENCE = TICK + TICK + TICK;

  var DEFAULTS = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 2048,
    instructions: '',
    delayMs: 120,
    autoSubmit: false,
    submitText: '提交|交卷|完成|确定',
    maxQuestions: 200,
    panelVisible: true,
    autoRunOnLoad: false,
    includeLowConfidence: true,
    regionRect: null,
    regionFrameUrl: '',
    // ---- 对话模式（和 AI 智能体对话的答题窗口）----
    chatListSelector: '',
    chatInputSelector: '',
    chatAutoReply: false,
    chatSelfSide: 'auto',
    chatCooldownMs: 1500,
    watchdogIntervalMs: 5000,
    // ---- 代码模式（Monaco 编辑器 + 关卡任务）----
    codeAutoRun: false
  };

  /* ------------------------------------------------------------ 配置存储 */

  var hasGM = (typeof GM_setValue === 'function') && (typeof GM_getValue === 'function');

  var Store = {
    get: function (key) {
      var fallback = DEFAULTS[key];
      try {
        if (hasGM) {
          var value = GM_getValue(key, undefined);
          return (value === undefined || value === null) ? fallback : value;
        }
        var raw = window.localStorage.getItem('quizbot.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        if (hasGM) { GM_setValue(key, value); return; }
        window.localStorage.setItem('quizbot.' + key, JSON.stringify(value));
      } catch (e) { /* 隐私模式等场景忽略 */ }
    }
  };

  var CONFIG = (function () {
    var out = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) out[key] = Store.get(key);
    }
    return out;
  })();

  function saveConfig(patch) {
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        CONFIG[key] = patch[key];
        Store.set(key, patch[key]);
      }
    }
  }

  /* ------------------------------------------------------------ HTTP（GM 版可绕过 CORS） */

  function httpPost(url, headers, bodyObj) {
    var body = JSON.stringify(bodyObj);
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: headers,
          data: body,
          timeout: 180000,
          onload: function (res) {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error('HTTP ' + res.status + ': ' + String(res.responseText || '').slice(0, 300)));
          },
          onerror: function () { reject(new Error('网络请求失败（网络不可达或被拦截）')); },
          ontimeout: function () { reject(new Error('请求超时')); }
        });
      });
    }
    return fetch(url, { method: 'POST', headers: headers, body: body }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300));
        return text;
      });
    });
  }

  /* ------------------------------------------------------------ 通用工具 */

  function clean(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  var Q_MARK = /^[\s\u3000]*[（(【\[]?\s*(\d{1,3})\s*[.、．)）\]:：】\]]\s*/;
  var OPT_MARK = /^[\s\u3000]*[（(【\[]?\s*([A-Ha-h])\s*[.、．)）\]:：】\]]\s+/;

  // 脚本自己的面板里也有输入框，绝不能当成题目
  function isOwnUI(el) {
    return !!(el && el.closest && el.closest('[data-quizbot-ui]'));
  }

  // 聊天窗口底部的「输入消息」框不是题目，必须排除，
  // 否则会出现「把 "发送消息" 当成一道填空题」这种误识别。
  // 明确属于「聊天输入框」的提示语 —— 命中即可判定
  var CHAT_INPUT_STRONG = /(发送消息|发送信息|输入消息|说点什么|有什么可以帮|输入问题|开始对话|聊点什么|向我提问|type a message|send a message|ask anything)/i;
  // 泛化词：单独出现不能判定（问卷里的「请输入你的回答」也是这一类）
  var CHAT_INPUT_WEAK = /(请输入|输入|发送|说|提问|聊|message|send|type|ask)/i;

  function nearbySendButton(el) {
    var scope = el.parentElement;
    for (var up = 0; up < 3 && scope; up++) {
      var btns = scope.querySelectorAll('button,[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var label = visibleText(btns[i]) + ' ' +
                    String(btns[i].getAttribute('aria-label') || '') + ' ' +
                    String(btns[i].getAttribute('class') || '');
        if (/发送|send/i.test(label)) return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  // 判定「这是聊天输入框，不是题目」。
  // 必须足够保守，否则会把问卷里的正常填空题也排除掉。
  function looksLikeChatInput(el) {
    var tag = el.tagName.toLowerCase();
    if (tag !== 'textarea' && tag !== 'input') return false;
    var hint = (String(el.getAttribute('placeholder') || '') + ' ' +
                String(el.getAttribute('aria-label') || '') + ' ' +
                String(el.getAttribute('data-placeholder') || '')).trim();
    if (CHAT_INPUT_STRONG.test(hint)) return true;
    // 只有「提示语很短 + 紧挨着发送按钮」才算聊天输入框。
    // 「请输入你的回答」这类较长且有明确题意的不算。
    if (hint.length > 0 && hint.length <= 10 &&
        CHAT_INPUT_WEAK.test(hint) && nearbySendButton(el)) {
      return true;
    }
    return false;
  }

  /* ---------- 跨 iframe 支持 ----------
     很多平台（例如扣子）把整个答题界面放在同源 iframe 里。
     顶层文档只有空壳，必须穿透进 iframe 才能读到题目和输入框。
     这些工具函数让所有查找/读写都能跨 frame 工作。 */

  function winOf(el) {
    if (!el) return window;
    try {
      if (el.ownerDocument && el.ownerDocument.defaultView) return el.ownerDocument.defaultView;
    } catch (e) { /* 忽略 */ }
    return window;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // 必须用元素自己所在文档的 window，否则跨 iframe 时会读错样式
    var win = winOf(el);
    var style = null;
    try { style = win.getComputedStyle(el); } catch (e) { style = null; }
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
    }
    return true;
  }

  // 顶层文档 + 所有「同源可读」的 iframe 文档（递归），带各自相对顶层的偏移
  function allDocs() {
    var out = [];
    var seen = [];
    (function walk(doc, label, dx, dy, depth) {
      if (!doc || depth > 6 || seen.indexOf(doc) >= 0) return;
      seen.push(doc);
      out.push({ doc: doc, label: label, dx: dx, dy: dy });
      var frames;
      try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return; }
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var inner = null;
        try { inner = f.contentDocument; } catch (e) { inner = null; }
        if (!inner || !inner.body) continue;      // 跨域或未加载
        var r;
        try { r = f.getBoundingClientRect(); } catch (e) { continue; }
        walk(inner, label + '/iframe[' + i + ']', dx + r.left, dy + r.top, depth + 1);
      }
    })(document, 'top', 0, 0, 0);
    return out;
  }

  // 某个文档的视口原点在「顶层视口」里的偏移
  function docOffset(doc) {
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      if (docs[i].doc === doc) return { x: docs[i].dx, y: docs[i].dy };
    }
    return { x: 0, y: 0 };
  }

  // 在所有文档里查选择器，返回第一个命中的可见元素
  function queryAllDocs(selector, requireVisible) {
    if (!selector) return null;
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var el = null;
      try { el = docs[i].doc.querySelector(selector); } catch (e) { el = null; }
      if (!el) continue;
      if (requireVisible && !isVisible(el)) continue;
      return el;
    }
    return null;
  }

  // 在所有文档里查选择器，收集全部命中
  function queryAllDocsList(selector, requireVisible) {
    var out = [];
    if (!selector) return out;
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var list = [];
      try { list = docs[i].doc.querySelectorAll(selector); } catch (e) { list = []; }
      for (var j = 0; j < list.length; j++) {
        if (requireVisible && !isVisible(list[j])) continue;
        out.push(list[j]);
      }
    }
    return out;
  }

  // 元素在「顶层视口」里的位置（跨 frame 累加偏移），用于与框选区域比较
  function absoluteRect(el) {
    var r = el.getBoundingClientRect();
    var off = docOffset(el.ownerDocument || document);
    return {
      left: r.left + off.x, top: r.top + off.y,
      width: r.width, height: r.height,
      right: r.left + off.x + r.width, bottom: r.top + off.y + r.height
    };
  }



  // innerText 依赖布局，在部分环境（未渲染、无头、某些框架）下为空或不可用，
  // 所以一律回退到 textContent，否则会「看着有文字却读不到」。
  function visibleText(el) {
    if (!el) return '';
    var text = '';
    try { text = el.innerText; } catch (e) { text = ''; }
    if (!text) text = el.textContent;
    return clean(text);
  }

  function labelFor(input) {
    if (input.id) {
      try {
        var esc = (window.CSS && window.CSS.escape) ? window.CSS.escape(input.id) : input.id;
        var sel = 'label[for="' + esc + '"]';
        var root = input.getRootNode ? input.getRootNode() : document;
        var lab = root.querySelector(sel);
        if (lab) return lab;
        lab = document.querySelector(sel);
        if (lab) return lab;
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return (input.closest && input.closest('label')) || null;
  }

  function parseLooseJson(text) {
    var out = String(text || '').trim();
    if (!out) throw new Error('模型返回为空');
    while (out.indexOf(FENCE) === 0) out = out.slice(3).trim();
    if (out.slice(-3) === FENCE) out = out.slice(0, -3).trim();
    if (out.toLowerCase().indexOf('json') === 0) out = out.slice(4).trim();
    try { return JSON.parse(out); } catch (e) { /* 继续尝试 */ }
    var start = out.indexOf('{');
    var end = out.lastIndexOf('}');
    if (start >= 0 && end > start) {
      var blob = out.slice(start, end + 1);
      try { return JSON.parse(blob); } catch (e1) {
        try { return JSON.parse(blob.replace(/,\s*([}\]])/g, '$1')); } catch (e2) { /* 失败 */ }
      }
    }
    throw new Error('无法解析模型返回的 JSON：' + out.slice(0, 200));
  }

  /* ------------------------------------------------------------ 题目提取 */

  var HANDLES = Object.create(null);   // 运行时句柄表：handle -> 元素
  var LAST_QUESTIONS = [];   // 上一次提取到的题目

  function collectDocs() {
    var docs = [{ doc: document, label: 'top' }];
    var frames = document.querySelectorAll('iframe,frame');
    for (var i = 0; i < frames.length; i++) {
      try {
        var inner = frames[i].contentDocument;
        if (inner && inner.body) docs.push({ doc: inner, label: 'iframe[' + i + ']' });
      } catch (e) { /* 跨域 iframe 读不到，跳过 */ }
    }
    return docs;
  }

  function inputKind(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'text';
    if (tag === 'select') return 'select';
    var type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'radio') return 'single';
    if (type === 'checkbox') return 'multiple';
    if (['hidden', 'submit', 'button', 'reset', 'file', 'image'].indexOf(type) >= 0) return null;
    return 'text';
  }

  function optionTextFor(input) {
    var lab = labelFor(input);
    if (lab) {
      var t = clean(lab.innerText || lab.textContent);
      if (t) return t;
    }
    var node = input.nextSibling;
    var acc = '';
    var hops = 0;
    while (node && hops < 4) {
      if (node.nodeType === 3) acc += node.textContent;
      else if (node.nodeType === 1) {
        var txt = clean(node.innerText || node.textContent);
        if (txt) acc += ' ' + txt;
        hops++;
      }
      if (acc.trim().length > 2) break;
      node = node.nextSibling;
    }
    if (!acc.trim() && input.parentElement) {
      var clone = input.parentElement.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,script,style').forEach(function (n) { n.remove(); });
      acc = clean(clone.innerText || clone.textContent);
    }
    return clean(acc).slice(0, 400);
  }

  function stemFrom(node) {
    var current = node;
    var best = '';
    for (var up = 0; up < 7 && current && current !== document.body; up++) {
      var clone = current.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,script,style,button,svg').forEach(function (n) { n.remove(); });
      var text = clean(clone.innerText || clone.textContent);
      if (text.length >= 4) {
        var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var filtered = lines.filter(function (line) { return !OPT_MARK.test(line); });
        if (filtered.length) {
          var joined = filtered.join('\n');
          var hasNumber = Q_MARK.test(joined);
          if (hasNumber && (best === '' || joined.length < best.length)) { best = joined; break; }
          if (best === '') best = joined;
        }
      }
      current = current.parentElement;
    }
    return best.replace(Q_MARK, '').trim().slice(0, 4000);
  }

  function registerHandle(el, handle) {
    HANDLES[handle] = el;
    try { el.setAttribute('data-qb-handle', handle); } catch (e) { /* 某些元素只读 */ }
  }

  function readQuestions() {
    HANDLES = [];
    var questions = [];
    var docs = collectDocs();
    var seen = [];

    function already(el) { return seen.indexOf(el) >= 0; }

    // ---- 1) radio / checkbox 分组 ----
    docs.forEach(function (item) {
      var all = item.doc.querySelectorAll('input,textarea,select');
      var groups = Object.create(null);
      var order = [];
      Array.prototype.forEach.call(all, function (el) {
        var kind = inputKind(el);
        if (kind !== 'single' && kind !== 'multiple') return;
        if (!isVisible(el) || el.disabled || isOwnUI(el)) return;
        var key = el.name || ('__anon_' + questions.length + '_' + (el.closest('fieldset,li,tr,div,p') ?
          (el.closest('fieldset,li,tr,div,p').className || el.closest('fieldset,li,tr,div,p').tagName) : 'x'));
        if (!groups[key]) { groups[key] = { kind: kind, els: [] }; order.push(key); }
        groups[key].els.push(el);
      });
      order.forEach(function (key) {
        var group = groups[key];
        var first = group.els[0];
        if (!first || already(first)) return;
        var options = group.els.map(function (el, i) {
          seen.push(el);
          var handle = 'q' + questions.length + '_o' + i;
          registerHandle(el, handle);
          var text = optionTextFor(el);
          var marker = text.match(OPT_MARK);
          var ownValue = String(el.getAttribute('value') || '');
          return {
            index: i,
            key: marker ? marker[1].toUpperCase() : (ownValue || String.fromCharCode(65 + i)),
            text: text.replace(OPT_MARK, '').trim(),
            value: ownValue,
            handle: handle
          };
        });
        var container = first.closest('fieldset,li,tr,.question,.item,.topic,.subject,div,p') || first.parentElement;
        var stem = stemFrom(container || first);
        if (!stem && container && container.previousElementSibling) {
          stem = clean(container.previousElementSibling.innerText || container.previousElementSibling.textContent);
        }
        questions.push({
          index: questions.length + 1,
          type: group.kind,
          stem: stem || '(题干未识别)',
          options: options,
          handle: null
        });
      });
    });

    // ---- 2) 文本输入 ----
    docs.forEach(function (item) {
      var all = item.doc.querySelectorAll('input,textarea');
      Array.prototype.forEach.call(all, function (el) {
        if (inputKind(el) !== 'text' || !isVisible(el) || el.disabled || isOwnUI(el) || already(el)) return;
        if (looksLikeChatInput(el)) return;   // 聊天输入框不是题目
        seen.push(el);
        var handle = 'q' + questions.length + '_t';
        registerHandle(el, handle);
        var placeholder = String(el.getAttribute('placeholder') || '');
        var aria = String(el.getAttribute('aria-label') || '');
        var lab = labelFor(el);
        var stem = lab ? clean(lab.innerText || lab.textContent) : '';
        if (!stem) {
          var container = el.closest('div,li,td,p,section,fieldset');
          if (container) {
            var clone = container.cloneNode(true);
            clone.querySelectorAll('input,textarea,select,script,style,button').forEach(function (n) { n.remove(); });
            stem = clean(clone.innerText || clone.textContent).split('\n').filter(Boolean).join('\n');
          }
        }
        questions.push({
          index: questions.length + 1,
          type: 'text',
          stem: stem || placeholder || aria || '(题干未识别)',
          options: [],
          handle: handle,
          placeholder: placeholder,
          multiline: el.tagName.toLowerCase() === 'textarea',
          maxlength: el.getAttribute('maxlength') ? parseInt(el.getAttribute('maxlength'), 10) : null
        });
      });
    });

    // ---- 3) 下拉框 ----
    docs.forEach(function (item) {
      var all = item.doc.querySelectorAll('select');
      Array.prototype.forEach.call(all, function (el) {
        if (!isVisible(el) || el.disabled || isOwnUI(el) || already(el)) return;
        seen.push(el);
        var handle = 'q' + questions.length + '_s';
        registerHandle(el, handle);
        var options = Array.prototype.map.call(el.options, function (opt, i) {
          return { index: i, key: String(opt.value), text: clean(opt.text), value: String(opt.value), handle: handle };
        });
        var container = el.closest('div,li,td,p,section,fieldset');
        var stem = '';
        if (container) {
          var clone = container.cloneNode(true);
          clone.querySelectorAll('input,select,textarea,script,style,button').forEach(function (n) { n.remove(); });
          stem = clean(clone.innerText || clone.textContent).split('\n').filter(Boolean).join('\n');
        }
        questions.push({
          index: questions.length + 1, type: 'select', stem: stem || '(题干未识别)',
          options: options, handle: handle
        });
      });
    });

    return questions.slice(0, Number(CONFIG.maxQuestions) || 200);
  }

  /* ------------------------------------------------------------ 调用 AI */

  function buildPrompt(questions) {
    var lines = [];
    lines.push('【题目清单】共 ' + questions.length + ' 题');
    questions.forEach(function (q) {
      var kind = { single: '单选题', multiple: '多选题', text: '填空/简答题', select: '下拉选择' }[q.type] || '题目';
      lines.push('');
      lines.push('[' + q.index + '] (' + kind + ') ' + String(q.stem || '').trim());
      (q.options || []).forEach(function (opt) {
        lines.push('    ' + (opt.key || opt.value) + '. ' + opt.text);
      });
      if (q.type === 'text') {
        var extra = [];
        if (q.placeholder) extra.push('输入提示: ' + q.placeholder);
        if (q.maxlength) extra.push('字数上限: ' + q.maxlength);
        if (q.multiline) extra.push('多行输入');
        if (extra.length) lines.push('    （' + extra.join('；') + '）');
      }
    });
    if (CONFIG.instructions) {
      lines.push('');
      lines.push('【额外要求】');
      lines.push(String(CONFIG.instructions));
    }
    lines.push('');
    lines.push('请按题目序号作答，只输出规定的 JSON。');
    return lines.join('\n');
  }

  var SYSTEM_PROMPT = [
    '你是一个严谨的答题助手。你会收到一个网页上的题目清单，需要逐题给出答案。',
    '',
    '要求：',
    '1. 严格按顺序作答，每题都必须给出答案，不要跳过。',
    '2. 单选题 answer 填单个选项字母（如 "A"）；多选题填字母数组（如 ["A","C"]）；',
    '   判断题填 "对" 或 "错"；填空题/简答题直接填答案文本。',
    '3. 只输出 JSON，不要输出任何解释性文字、不要用 Markdown 代码块包裹。',
    '4. 如果题目信息不足或你不确定，仍要给出最可能的答案，并把 confidence 设为 0~1 之间的较低值。',
    '5. 不要编造题目里不存在的选项字母。',
    '',
    '输出格式（严格遵守）：',
    '{"answers":[{"index":1,"answer":"A","confidence":0.95,"reason":"简短理由"}]}'
  ].join('\n');

  function callModel(questions) {
    var messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(questions) }
    ];
    if (CONFIG.provider === 'anthropic') {
      return httpPost(CONFIG.baseUrl.replace(/\/+$/, '') + '/messages', {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }, {
        model: CONFIG.model,
        max_tokens: Number(CONFIG.maxTokens) || 2048,
        temperature: Number(CONFIG.temperature),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(questions) }]
      }).then(function (text) {
        var data = JSON.parse(text);
        return (data.content || []).map(function (b) { return b.text || ''; }).join('');
      });
    }
    return httpPost(CONFIG.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CONFIG.apiKey
    }, {
      model: CONFIG.model,
      messages: messages,
      temperature: Number(CONFIG.temperature),
      max_tokens: Number(CONFIG.maxTokens) || 2048
    }).then(function (text) {
      var data = JSON.parse(text);
      var choices = data.choices || [];
      if (!choices.length) throw new Error('接口返回里没有 choices');
      var content = choices[0].message ? choices[0].message.content : choices[0].text;
      if (Object.prototype.toString.call(content) === '[object Array]') {
        content = content.map(function (p) { return p.text || ''; }).join('');
      }
      return String(content || '');
    });
  }

  function parseAnswers(raw) {
    var parsed = parseLooseJson(raw);
    var items = Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : (parsed.answers || []);
    var out = {};
    items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var idx = parseInt(item.index, 10);
      if (isNaN(idx)) return;
      out[idx] = {
        answer: item.answer,
        confidence: parseFloat(item.confidence === undefined ? 0.8 : item.confidence) || 0.8,
        reason: String(item.reason || '').slice(0, 300)
      };
    });
    return out;
  }

  /* ------------------------------------------------------------ 填写答案 */

  function lettersOf(answer) {
    if (answer === undefined || answer === null) return [];
    if (Object.prototype.toString.call(answer) === '[object Array]') {
      var all = [];
      answer.forEach(function (a) { lettersOf(a).forEach(function (l) { all.push(l); }); });
      return all;
    }
    var found = String(answer).match(/[A-Ha-h]/g);
    if (!found) return [];
    var out = [];
    found.forEach(function (ch) {
      var up = ch.toUpperCase();
      if (out.indexOf(up) < 0) out.push(up);
    });
    return out;
  }

  function textOf(answer) {
    if (answer === undefined || answer === null) return '';
    if (Object.prototype.toString.call(answer) === '[object Array]') return answer.join('');
    return String(answer);
  }

  // 用原生 setter 写值，React / Vue 才能监听到。
  // 必须用「元素自己文档」的原型 —— 跨 iframe 时用顶层原型会被框架当成
  // 未经 setter 的赋值而忽略。
  function setNativeValue(el, value) {
    var win = winOf(el);
    var proto = null;
    try {
      proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
                                        : win.HTMLInputElement.prototype;
    } catch (e) { proto = null; }
    var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // 注意：事件必须用「元素自己所在文档」的构造函数创建。
  // 跨 iframe 时用顶层 window 的 MouseEvent/Event 会因跨 realm 而不被框架识别。
  function fireEvents(el, types) {
    var win = winOf(el);
    types.forEach(function (type) {
      var ev;
      try {
        if (type === 'click') {
          ev = new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win });
        } else {
          ev = new win.Event(type, { bubbles: true, cancelable: true });
        }
      } catch (e) {
        ev = document.createEvent('Event');
        ev.initEvent(type, true, true);
      }
      el.dispatchEvent(ev);
    });
  }

  function fillOne(question, entry) {
    if (!entry) return { ok: false, reason: '模型没有给出答案' };
    var answer = entry.answer;

    if (question.type === 'single' || question.type === 'multiple') {
      var wanted = lettersOf(answer);
      var raw = textOf(answer).trim();
      if (!wanted.length && !raw) return { ok: false, reason: '答案为空' };
      var hit = 0;
      question.options.forEach(function (opt) {
        var el = HANDLES[opt.handle];
        if (!el) return;
        var keyUp = String(opt.key).toUpperCase();
        var text = clean(opt.text);
        var isWanted;
        if (wanted.length) {
          isWanted = wanted.indexOf(keyUp) >= 0;
        } else {
          // 选项不是 A/B/C 形式（判断题的 T/F、是/否、1/2 等），改用文字或值匹配
          isWanted = (keyUp === raw.toUpperCase()) ||
                     (String(opt.value).toUpperCase() === raw.toUpperCase()) ||
                     (text === raw) ||
                     (raw.length >= 2 && text && text.indexOf(raw) >= 0);
        }
        if (isWanted) {
          if (!el.checked) el.click();
          hit++;                       // 已经选中也算命中，保证重复填写幂等
        } else if (el.checked && question.type === 'single') {
          el.click();
        }
      });
      return hit ? { ok: true, hit: hit } : { ok: false, reason: '没有匹配到选项（答案: ' + raw + '）' };
    }

    if (question.type === 'select') {
      var el2 = HANDLES[question.handle];
      if (!el2) return { ok: false, reason: '找不到下拉框' };
      var value = textOf(answer);
      var target = null;
      var letters = lettersOf(answer);
      for (var i = 0; i < el2.options.length; i++) {
        var opt = el2.options[i];
        if (opt.value === value || clean(opt.text) === clean(value)) { target = opt; break; }
      }
      if (!target && letters.length) {
        for (var j = 0; j < el2.options.length; j++) {
          var t = clean(el2.options[j].text).toUpperCase();
          if (t.indexOf(letters[0]) === 0) { target = el2.options[j]; break; }
        }
      }
      if (!target && value) {
        for (var k = 0; k < el2.options.length; k++) {
          if (clean(el2.options[k].text).indexOf(value) >= 0) { target = el2.options[k]; break; }
        }
      }
      if (!target) return { ok: false, reason: '下拉框里没有匹配的选项' };
      el2.value = target.value;
      fireEvents(el2, ['input', 'change']);
      return { ok: true };
    }

    var el3 = HANDLES[question.handle];
    if (!el3) return { ok: false, reason: '找不到输入框' };
    var text = textOf(answer);
    if (question.maxlength && text.length > question.maxlength) text = text.slice(0, question.maxlength);
    try { el3.focus(); } catch (e) { /* 忽略 */ }
    setNativeValue(el3, text);
    fireEvents(el3, ['input', 'change', 'blur', 'keyup']);
    return { ok: true };
  }

  /* ------------------------------------------------------------ 界面 */

  var LOG_LINES = [];
  var PANEL = null;
  var LOG_BOX = null;

  function log(message, kind) {
    var stamp = new Date().toTimeString().slice(0, 8);
    LOG_LINES.push('[' + stamp + '] ' + message);
    if (LOG_LINES.length > 300) LOG_LINES.shift();
    try { console.log('[quizbot]', message); } catch (e) { /* 忽略 */ }
    if (LOG_BOX) {
      LOG_BOX.textContent = LOG_LINES.slice(-40).join('\n');
      LOG_BOX.scrollTop = LOG_BOX.scrollHeight;
    }
    if (kind === 'error' && PANEL) flash(PANEL.querySelector('#qb-status'), message, '#e33');
  }

  function flash(el, text, color) {
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '#333';
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (key === 'style') node.style.cssText = props[key];
      else if (key === 'text') node.textContent = props[key];
      else if (key === 'html') node.innerHTML = props[key];
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), props[key]);
      else node.setAttribute(key, props[key]);
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function buildPanel() {
    var status = el('div', { id: 'qb-status', style: 'font-size:12px;color:#555;margin:6px 0;min-height:16px;', text: '就绪' });

    var btnRead = el('button', { style: BTN, onclick: function () { doRead(); } }, []);
    btnRead.textContent = '读取题目';
    var btnRun = el('button', { style: BTN + 'background:#2f6fed;color:#fff;border-color:#2f6fed;', onclick: function () { doRun(); } }, []);
    btnRun.textContent = 'AI 作答并填写';
    var btnFill = el('button', { style: BTN, onclick: function () { doFillOnly(); } }, []);
    btnFill.textContent = '仅按上次答案填写';
    var btnClear = el('button', { style: BTN, onclick: function () { LOG_LINES = []; if (LOG_BOX) LOG_BOX.textContent = ''; } }, []);
    btnClear.textContent = '清空日志';
    var btnCfg = el('button', { style: BTN, onclick: function () { toggleConfig(); } }, []);
    btnCfg.textContent = '设置';
    var btnClose = el('button', { style: BTN + 'float:right;', onclick: function () { PANEL.style.display = 'none'; } }, []);
    btnClose.textContent = '收起';

    // ---- 对话模式按钮（答题界面是聊天窗口时用这组）----
    var btnChatPreview = el('button', { style: BTN, onclick: function () { chatPreview(); } }, []);
    btnChatPreview.textContent = '① 预览对话';
    var btnChatPickList = el('button', { style: BTN, onclick: function () {
      log('请点击页面上「消息列表」所在的区域（按 Esc 取消）…');
      pickElement(function (node) {
        CHAT.listEl = node;
        var p = cssPathOf(node);
        saveConfig({ chatListSelector: p });
        log('已指定消息区域：' + p.slice(0, 70));
        chatPreview();
      });
    } }, []);
    btnChatPickList.textContent = '指定消息区域';
    var btnChatPickInput = el('button', { style: BTN, onclick: function () {
      log('请点击页面上的「聊天输入框」（按 Esc 取消）…');
      pickElement(function (node) {
        CHAT.inputEl = node;
        saveConfig({ chatInputSelector: cssPathOf(node) });
        log('已指定输入框');
      });
    } }, []);
    btnChatPickInput.textContent = '指定输入框';
    var btnChatOnce = el('button', { style: BTN, onclick: function () { chatAnswerLatest(true); } }, []);
    btnChatOnce.textContent = '② 回答最新一条';
    var btnChatToggle = el('button', { style: BTN, onclick: function () { toggleChatWatch(); } }, []);
    btnChatToggle.textContent = '③ 自动应答 开/关';

    // ---- 识别不出来时用的两把「兜底武器」----
    var btnLearn = el('button', { style: BTN + 'background:#fff3d6;border-color:#e0b34a;', onclick: function () {
      learnFromClick();
    } }, []);
    btnLearn.textContent = '点一条消息学会它';
    var btnRegionPick = el('button', { style: BTN + 'background:#fff3d6;border-color:#e0b34a;', onclick: function () {
      pickRect(function (rect) { useRegion(rect); });
    } }, []);
    btnRegionPick.textContent = '框选题目区域';
    var btnRegionAnswer = el('button', { style: BTN, onclick: function () { regionAnswerLatest(true); } }, []);
    btnRegionAnswer.textContent = '区域模式：答最新';
    var btnRegionAuto = el('button', { style: BTN, onclick: function () {
      if (REGION.watching) regionStopWatch(); else regionStartWatch();
    } }, []);
    btnRegionAuto.textContent = '区域模式：自动应答';

    // ---- 代码模式按钮（Monaco 编辑器 + 关卡任务）----
    var btnCodeRead = el('button', { style: BTN, onclick: function () { codePreview(); } }, []);
    btnCodeRead.textContent = '① 读取任务';
    var btnCodeRun = el('button', { style: BTN + 'background:#2f6fed;color:#fff;border-color:#2f6fed;', onclick: function () { codeDoTask(true); } }, []);
    btnCodeRun.textContent = '② 生成并填入代码';
    var btnCodeRunNow = el('button', { style: BTN, onclick: function () { clickRunButton(); } }, []);
    btnCodeRunNow.textContent = '③ 点启动运行';
    var btnCodeAuto = el('button', { style: BTN, onclick: function () { if (CODE.watching) codeStopWatch(); else codeStartWatch(); } }, []);
    btnCodeAuto.textContent = '④ 自动：切关就填';

    // 结构快照：把页面结构导出给作者写精准规则
    var btnSnapshot = el('button', {
      style: BTN + 'background:#e8f5e9;border-color:#4caf50;',
      onclick: function () { snapshotWithClickCapture(); }
    }, []);
    btnSnapshot.textContent = '📋 导出结构快照（发给作者）';

    // 一键重置：清掉历史保存的（可能已经错误的）选择器与框选区域
    var btnReset = el('button', {
      style: BTN + 'background:#fdecea;border-color:#e57373;',
      onclick: function () {
        saveConfig({ chatListSelector: '', chatInputSelector: '', regionRect: null, regionFrameUrl: '' });
        CHAT.listEl = null;
        CHAT.inputEl = null;
        CHAT.lastHash = '';
        REGION.rect = null;
        REGION.lastText = '';
        chatStopWatch(true);
        CHAT.watching = false;
        if (REGION.observer) { REGION.observer.disconnect(); REGION.observer = null; }
        REGION.watching = false;
        clearAnswerLog();                          // 清空「已作答」记录与列表
        log('已重置：清除了保存的消息区域/输入框/框选范围，请重新点「① 预览对话」');
        setStatus('已重置，请重新识别', '#0a0');
      }
    }, []);
    btnReset.textContent = '🔄 重置识别';


    // ---- 答题记录区 ----
    ANSWER_LOG_BOX = el('pre', {
      style: 'background:#1b2430;color:#8fd4ff;font-size:11px;line-height:1.5;padding:8px;' +
             'border-radius:6px;max-height:170px;overflow:auto;margin:6px 0 0;' +
             'white-space:pre-wrap;word-break:break-all;'
    }, []);
    var btnLogToggle = el('button', {
      style: BTN + 'background:#e3f2fd;border-color:#42a5f5;',
      onclick: function () {
        var box = PANEL.querySelector('#qb-answerlog');
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        if (box.style.display !== 'none') refreshAnswerLogView();
      }
    }, []);
    btnLogToggle.textContent = '📋 答题记录';
    var btnLogExport = el('button', {
      style: BTN,
      onclick: function () {
        try {
          var lines = ['# 答题记录', '', '导出时间：' + new Date().toLocaleString(), ''];
          for (var i = ANSWER_LOG.length - 1; i >= 0; i--) {
            var r0 = ANSWER_LOG[i];
            var st = r0.status === 'answered' ? '已作答' :
                     (r0.status === 'skipped' ? '跳过' : '失败');
            lines.push('## [' + st + '] ' + new Date(r0.time).toLocaleString());
            lines.push('');
            lines.push('题目：');
            lines.push(String(r0.text || '').trim());
            lines.push('');
            if (r0.answer) lines.push('答案：' + r0.answer);
            if (r0.reason) lines.push('说明：' + r0.reason);
            lines.push('');
            lines.push('---');
            lines.push('');
          }
          var blob = new Blob([lines.join(String.fromCharCode(10))],
                              { type: 'text/markdown;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'quizbot-answerlog.md';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        } catch (e) { log('导出失败: ' + e.message, 'error'); }
      }
    }, []);
    btnLogExport.textContent = '📤 导出记录';

    var answerLogWrap = el('div', {
      id: 'qb-answerlog',
      style: 'display:none;border-top:1px solid #eee;margin-top:8px;padding-top:8px;'
    }, [ANSWER_LOG_BOX]);

    LOG_BOX = el('pre', {
      style: 'background:#111;color:#9f9;font-size:11px;line-height:1.45;padding:8px;border-radius:6px;' +
             'max-height:200px;overflow:auto;margin:8px 0 0;white-space:pre-wrap;word-break:break-all;'
    }, []);

    var configBox = el('div', { id: 'qb-config', style: 'display:none;border-top:1px solid #eee;margin-top:8px;padding-top:8px;' }, []);

    PANEL = el('div', {
      'data-quizbot-ui': '1',
      // 高度/宽度都限制在视口内并允许内部滚动 —— 小屏或系统缩放时内容不再被截断
      style: 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;' +
             'width:340px;max-width:calc(100vw - 32px);' +
             'max-height:calc(100vh - 32px);overflow-y:auto;overflow-x:hidden;' +
             'box-sizing:border-box;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;' +
             'border:1px solid #d0d0d0;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);' +
             'padding:12px;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#222;'
    }, [
      el('div', { style: 'font-weight:600;margin-bottom:4px;' }, [
        el('span', { text: 'AI 网页答题助手 v' + VERSION }),
        btnClose
      ]),
      el('div', { style: 'color:#888;font-size:11px;margin-bottom:6px;', text: '读取题目 → 调用你的 API → 自动填写' }),
      el('div', { style: 'color:#888;font-size:11px;margin:2px 0 4px;', text: '【对话模式】答题界面是聊天窗口时用这组' }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' }, [btnChatPreview, btnChatOnce, btnChatToggle]),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;' }, [btnChatPickList, btnChatPickInput]),
      el('div', { style: 'color:#b8860b;font-size:11px;margin:8px 0 4px;', text: '【识别不出来时】用下面这两把兜底武器' }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' }, [btnLearn, btnRegionPick]),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;' }, [btnRegionAnswer, btnRegionAuto]),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;' }, [btnSnapshot, btnReset]),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;' }, [btnLogToggle, btnLogExport]),
      el('div', { style: 'color:#888;font-size:11px;margin:8px 0 4px;', text: '【代码模式】编程关卡（Monaco 编辑器）用这组' }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' }, [btnCodeRead, btnCodeRun]),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;' }, [btnCodeRunNow, btnCodeAuto]),
      answerLogWrap,
      el('div', { style: 'color:#888;font-size:11px;margin:8px 0 4px;', text: '【表单模式】答题界面是问卷/试卷时用这组' }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' }, [btnRead, btnRun, btnFill, btnCfg, btnClear]),
      status,
      configBox,
      LOG_BOX
    ]);

    document.body.appendChild(PANEL);
    if (!CONFIG.panelVisible) PANEL.style.display = 'none';

    // 收起后用于重新打开的圆形按钮
    var fab = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;right:16px;bottom:16px;width:46px;height:46px;border-radius:50%;' +
             'background:#2f6fed;color:#fff;display:none;align-items:center;justify-content:center;' +
             'cursor:pointer;z-index:2147483647;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25);',
      text: 'AI',
      onclick: function () { PANEL.style.display = 'block'; fab.style.display = 'none'; }
    }, []);
    document.body.appendChild(fab);

    btnClose.addEventListener('click', function () {
      PANEL.style.display = 'none';
      fab.style.display = 'flex';
      saveConfig({ panelVisible: false });
    });

    buildConfigForm(configBox, fab);
    return { panel: PANEL, fab: fab, status: status };
  }

  var BTN = 'padding:5px 10px;font-size:12px;border:1px solid #ccc;border-radius:6px;' +
            'background:#f7f7f7;cursor:pointer;font-family:inherit;';

  var btnSaveExtra = null;   // 由 buildConfigForm 赋值，点「保存设置」时一并调用

  function field(labelText, inputEl, hint) {
    return el('label', { style: 'display:block;margin:6px 0;font-size:12px;' }, [
      el('span', { style: 'color:#555;', text: labelText }),
      inputEl,
      hint ? el('span', { style: 'color:#999;font-size:11px;display:block;', text: hint }) : el('span', {}, [])
    ]);
  }

  function textInput(key, type) {
    var input = el('input', { type: type || 'text', style: INPUT }, []);
    input.value = CONFIG[key] === undefined || CONFIG[key] === null ? '' : CONFIG[key];
    input.setAttribute('data-cfg', key);
    return input;
  }

  var INPUT = 'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid #ccc;' +
              'border-radius:5px;font-size:12px;font-family:inherit;margin-top:2px;';

  function buildConfigForm(box, fab) {
    box.innerHTML = '';
    box.appendChild(el('div', { style: 'font-weight:600;margin-bottom:4px;', text: 'API 设置' }));

    var selProvider = el('select', { style: INPUT, 'data-cfg': 'provider' }, []);
    ['openai', 'anthropic'].forEach(function (p) {
      var opt = el('option', { value: p }, []);
      opt.textContent = p === 'openai' ? 'OpenAI 兼容（多数中转/国产模型选这个）' : 'Anthropic 兼容';
      if (CONFIG.provider === p) opt.selected = true;
      selProvider.appendChild(opt);
    });

    var inBase = textInput('baseUrl');
    var inKey = textInput('apiKey', 'password');
    var inModel = textInput('model');
    var inTemp = textInput('temperature', 'number');
    var inMax = textInput('maxTokens', 'number');
    var inInstr = el('textarea', { style: INPUT + 'height:56px;', 'data-cfg': 'instructions' }, []);
    inInstr.value = CONFIG.instructions || '';

    var inSubmit = textInput('submitText');
    var chkSubmit = el('input', { type: 'checkbox', 'data-cfg': 'autoSubmit' }, []);
    chkSubmit.checked = !!CONFIG.autoSubmit;
    var chkLow = el('input', { type: 'checkbox', 'data-cfg': 'includeLowConfidence' }, []);
    chkLow.checked = !!CONFIG.includeLowConfidence;
    var chkAuto = el('input', { type: 'checkbox', 'data-cfg': 'autoRunOnLoad' }, []);
    chkAuto.checked = !!CONFIG.autoRunOnLoad;

    box.appendChild(field('接口类型', selProvider));
    box.appendChild(field('Base URL', inBase, '例如 https://api.openai.com/v1（末尾不要带 /chat/completions）'));
    box.appendChild(field('API Key', inKey, '只保存在本地浏览器，不会上传到任何第三方'));
    box.appendChild(field('模型名', inModel));
    box.appendChild(field('temperature', inTemp));
    box.appendChild(field('max_tokens', inMax));
    box.appendChild(field('额外要求（可选）', inInstr, '例如：答案请用中文；多选题宁缺毋滥'));
    box.appendChild(field('自动提交按钮文字（正则）', inSubmit, '留空则不自动提交'));
    box.appendChild(field('自动提交', chkSubmit));
    box.appendChild(field('低置信度也填写', chkLow));
    box.appendChild(field('打开页面自动读取题目', chkAuto));

    box.appendChild(el('div', { style: 'border-top:1px solid #eee;margin:10px 0 6px;padding-top:8px;font-weight:600;', text: '对话模式' }));

    var selSide = el('select', { style: INPUT }, []);
    [['auto', '自动判断（推荐）'], ['right', '我的消息在右侧'], ['left', '我的消息在左侧']].forEach(function (pair) {
      var opt = el('option', { value: pair[0] }, []);
      opt.textContent = pair[1];
      if (String(CONFIG.chatSelfSide) === pair[0]) opt.selected = true;
      selSide.appendChild(opt);
    });
    var inCool = textInput('chatCooldownMs', 'number');
    var chkChatAuto = el('input', { type: 'checkbox' }, []);
    chkChatAuto.checked = !!CONFIG.chatAutoReply;

    box.appendChild(field('我的消息位置', selSide, '自动判断失误时手动指定，用于区分「谁发的」'));
    box.appendChild(field('回复延迟（毫秒）', inCool, '检测到新消息后等多久再回复'));
    box.appendChild(field('打开页面自动开启应答', chkChatAuto));

    var chkCodeRun = el('input', { type: 'checkbox' }, []);
    chkCodeRun.checked = !!CONFIG.codeAutoRun;
    box.appendChild(field('代码模式：填入后自动点「启动运行」', chkCodeRun, '仅对 Monaco 编辑器的编程关卡生效'));

    btnSaveExtra = function () {
      saveConfig({
        chatSelfSide: selSide.value,
        chatCooldownMs: parseInt(inCool.value, 10) || 1500,
        codeAutoRun: chkCodeRun.checked
      });
      if (chkChatAuto.checked && !CHAT.watching) setTimeout(chatStartWatch, 300);
      if (!chkChatAuto.checked && CHAT.watching) chatStopWatch();
    };

    var btnSave = el('button', { style: BTN + 'background:#2f6fed;color:#fff;border-color:#2f6fed;width:100%;margin-top:6px;' }, []);
    btnSave.textContent = '保存设置';
    btnSave.addEventListener('click', function () {
      saveConfig({
        provider: selProvider.value,
        baseUrl: inBase.value.trim(),
        apiKey: inKey.value.trim(),
        model: inModel.value.trim(),
        temperature: parseFloat(inTemp.value) || 0.2,
        maxTokens: parseInt(inMax.value, 10) || 2048,
        instructions: inInstr.value,
        submitText: inSubmit.value,
        autoSubmit: chkSubmit.checked,
        includeLowConfidence: chkLow.checked,
        autoRunOnLoad: chkAuto.checked
      });
      log('设置已保存');
      flash(PANEL.querySelector('#qb-status'), '设置已保存', '#0a0');
    });
    box.appendChild(btnSave);

    var btnTest = el('button', { style: BTN + 'width:100%;margin-top:6px;' }, []);
    btnTest.textContent = '测试连接';
    btnTest.addEventListener('click', function () {
      var probe = [{ index: 1, type: 'single', stem: '1+1 等于几？', options: [
        { key: 'A', text: '1', handle: 'x' }, { key: 'B', text: '2', handle: 'y' }] }];
      flash(PANEL.querySelector('#qb-status'), '测试中…', '#666');
      callModel(probe).then(function (raw) {
        var parsed = parseAnswers(raw);
        log('连接成功，模型返回: ' + JSON.stringify(parsed[1] || raw.slice(0, 120)));
        flash(PANEL.querySelector('#qb-status'), '连接成功 ✔', '#0a0');
      }).catch(function (err) {
        log('连接失败: ' + err.message, 'error');
      });
    });
    box.appendChild(btnTest);
  }

  // 可视化拾取页面元素：用来手动指定「消息区域」和「输入框」
  function pickElement(onPick) {
    var box = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2f6fed;' +
             'background:rgba(47,111,237,.12);border-radius:3px;will-change:transform;'
    }, []);
    var tip = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;' +
             'background:#2f6fed;color:#fff;padding:9px 16px;border-radius:8px;' +
             'font:13px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;',
      text: '移动鼠标到目标区域后点击；按 Esc 取消'
    }, []);
    document.body.appendChild(box);
    document.body.appendChild(tip);

    var current = null;
    var rafPending = false;
    var lastTarget = null;

    function paint() {
      rafPending = false;
      if (!lastTarget) return;
      var r = lastTarget.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    }

    // 每次 mousemove 都读几何 + 写样式会疯狂触发重排/重绘，
    // 在大页面上直接把页面拖死。这里用 requestAnimationFrame 节流，
    // 且只有目标元素真的变了才重新测量。
    function onMove(e) {
      var t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (t.closest && t.closest('[data-quizbot-ui]')) return;
      if (t === lastTarget) return;
      // 极端深的节点（比如整页根容器）测量代价高，且用户不会想选它
      var depthCheck = t;
      var levels = 0;
      while (depthCheck && depthCheck !== document.body && levels < 200) { depthCheck = depthCheck.parentElement; levels++; }
      if (levels >= 200) return;
      if (t === document.body || t === document.documentElement) return;
      lastTarget = t;
      current = t;
      if (!rafPending) {
        rafPending = true;
        (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(paint);
      }
    }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      cleanup();
      onPick(current);
    }
    function onKey(e) {
      if (e.key === 'Escape') { cleanup(); log('已取消选择'); }
    }
    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function toggleConfig() {
    var box = PANEL.querySelector('#qb-config');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  }

  /* ------------------------------------------------------------ 主流程 */

  var LAST_ANSWERS = {};
  var BUSY = false;

  function setStatus(text, color) {
    if (PANEL) flash(PANEL.querySelector('#qb-status'), text, color);
  }

  function doRead() {
    var questions = readQuestions();
    LAST_QUESTIONS = questions;
    if (!questions.length) {
      log('没有识别到题目。可能这个页面的题目在跨域 iframe 里，或结构比较特殊。', 'error');
      setStatus('未识别到题目', '#e33');
      return questions;
    }
    log('识别到 ' + questions.length + ' 道题：');
    questions.forEach(function (q) {
      var kind = { single: '单选', multiple: '多选', text: '填空', select: '下拉' }[q.type] || '?';
      log('  [' + q.index + '](' + kind + ') ' + String(q.stem).replace(/\n/g, ' ').slice(0, 70));
      (q.options || []).slice(0, 8).forEach(function (o) {
        log('        ' + o.key + '. ' + String(o.text).slice(0, 50));
      });
    });
    setStatus('已识别 ' + questions.length + ' 题', '#0a0');
    return questions;
  }

  function applyAnswers(questions, answers) {
    var okCount = 0;
    var fails = [];
    questions.forEach(function (q) {
      var entry = answers[q.index];
      if (!entry) { fails.push('[' + q.index + '] 模型没给答案'); return; }
      if (!CONFIG.includeLowConfidence && entry.confidence < 0.5) {
        fails.push('[' + q.index + '] 置信度低(' + entry.confidence + ')，已跳过');
        return;
      }
      var result = fillOne(q, entry);
      if (result.ok) {
        okCount++;
        log('  已填 [' + q.index + '] -> ' + JSON.stringify(entry.answer) +
            '  (' + entry.confidence + ')' + (entry.reason ? ' ' + entry.reason.slice(0, 40) : ''));
      } else {
        fails.push('[' + q.index + '] ' + result.reason);
      }
    });
    return { okCount: okCount, fails: fails };
  }

  function doFillOnly() {
    if (!LAST_QUESTIONS.length) {
      log('请先点「读取题目」', 'error');
      return { okCount: 0, fails: ['尚未读取题目'] };
    }
    var res = applyAnswers(LAST_QUESTIONS, LAST_ANSWERS);
    log('填写完成：成功 ' + res.okCount + ' 题' + (res.fails.length ? '，失败 ' + res.fails.length + ' 题' : ''));
    res.fails.forEach(function (f) { log('  ' + f, 'error'); });
    setStatus('已填写 ' + res.okCount + ' 题', res.fails.length ? '#e80' : '#0a0');
    return res;
  }

  // 返回 Promise，resolve 为 { okCount, fails, total }，便于外部脚本/自动化调用
  function doRun() {
    if (BUSY) { log('正在处理中，请稍候…'); return Promise.resolve(null); }
    if (!CONFIG.baseUrl || !CONFIG.model) {
      log('请先在「设置」里填写 Base URL 和模型名', 'error');
      toggleConfig();
      return Promise.resolve(null);
    }
    BUSY = true;
    setStatus('读取题目…', '#666');
    var questions = doRead();
    if (!questions.length) { BUSY = false; return Promise.resolve(null); }

    setStatus('请求 AI 作答…', '#666');
    log('正在请求 ' + CONFIG.model + ' …');
    var started = Date.now();
    return callModel(questions).then(function (raw) {
      var answers = parseAnswers(raw);
      LAST_ANSWERS = answers;
      log('AI 返回 ' + Object.keys(answers).length + ' 条答案，耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
      setStatus('填写中…', '#666');
      var res = applyAnswers(questions, answers);
      log('填写完成：成功 ' + res.okCount + '/' + questions.length + ' 题');
      res.fails.forEach(function (f) { log('  ' + f, 'error'); });
      setStatus('已填写 ' + res.okCount + '/' + questions.length + ' 题', res.fails.length ? '#e80' : '#0a0');
      res.total = questions.length;
      if (CONFIG.autoSubmit) trySubmit();
      return res;
    }).catch(function (err) {
      log('出错: ' + err.message, 'error');
      setStatus('出错，详见日志', '#e33');
      return { okCount: 0, fails: [err.message], total: questions.length };
    }).then(function (value) {
      BUSY = false;
      return value;
    });
  }

  function trySubmit() {
    var pattern = String(CONFIG.submitText || '').trim();
    if (!pattern) return;
    var re;
    try { re = new RegExp(pattern); } catch (e) { re = new RegExp('提交|交卷|完成|确定'); }
    var candidates = document.querySelectorAll('button,a,input[type=submit],div[role=button],span');
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      if (!isVisible(node)) continue;
      var label = clean(node.innerText || node.value || node.textContent);
      if (label && label.length <= 12 && re.test(label)) {
        log('点击提交按钮: ' + label);
        node.click();
        return;
      }
    }
    log('没有找到匹配「' + pattern + '」的提交按钮，请手动提交', 'error');
  }

  /* ------------------------------------------------------------ 对话模式 */
  // 适用场景：答题界面是一个「和 AI 智能体对话」的聊天窗口 —— 智能体发题，你回复答案。

  var SELF_HINTS = ['self', 'mine', 'fromme', 'isme', 'outgoing', 'sent', 'right', 'human', 'user', 'questioner'];
  var OTHER_HINTS = ['other', 'them', 'fromthem', 'incoming', 'received', 'receive', 'left',
                     'ai', 'bot', 'assistant', 'robot', 'agent', 'system', 'reply', 'answer'];

  var CHAT = {
    listEl: null,
    inputEl: null,
    observer: null,
    watching: false,
    lastHash: '',
    busy: false,
    timer: null,
    baseline: Object.create(null),   // 开启自动应答前的历史题目（不重复作答）
    busySince: 0,                    // busy 置位时间，用于超时自恢复
    pendingAgain: false,             // 处理期间又来了新题，忙完立刻补一次
    failures: 0,
    watchdog: null,                  // 定时兜底，防止请求挂住后永久卡死
    lastHandledAt: 0,                // 上次处理完成的时刻（仅用于抑制抖动）
    timeouts: 0,                     // 连续超时次数（用于退避）
    retryAfter: 0                    // 退避截止时间
  };

  function cssPathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w\-]*$/.test(el.id)) return '#' + el.id;
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 8; depth++) {
      if (node.id && /^[A-Za-z][\w\-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      var part = node.tagName.toLowerCase();
      var cls = (typeof node.className === 'string' ? node.className : '').trim();
      var usedClass = false;
      if (cls && cls.length < 60) {
        var tokens = cls.split(/\s+/).filter(function (t) { return /^[A-Za-z][\w\-]*$/.test(t); });
        if (tokens.length) {
          part += '.' + tokens.slice(0, 2).join('.');
          usedClass = true;
        }
      }
      if (!usedClass) {
        var parent = node.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      // 命中语义 class 就停下，继续往上会引入易变的下标
      if (usedClass && /message|chat|conversation|dialog|bubble|timeline|list|msg|input|editor|content|send/i.test(cls)) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function querySafe(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function classTokens(el) {
    var raw = (typeof el.className === 'string' ? el.className : '') + ' ' +
              String(el.getAttribute('data-role') || '') + ' ' +
              String(el.getAttribute('data-author') || '') + ' ' +
              String(el.getAttribute('data-testid') || '') + ' ' +
              String(el.getAttribute('aria-label') || '');
    return raw.toLowerCase().split(/[\s_\-]+/).filter(Boolean);
  }

  /* --- 布局读取的缓存层 ---
     每次 getBoundingClientRect / getComputedStyle 都会强制浏览器同步重排（forced reflow），
     在真实页面上调用几千次足以让主线程冻结。所有几何读取都必须经过这里，同一帧内只算一次。 */
  var LAYOUT_CACHE = null;
  var LAYOUT_BUDGET = { rects: 4000, ms: 1200 };   // 单帧预算，超了就收手

  function newLayoutCache() {
    return { rects: new WeakMap(), visible: new WeakMap(), rectCalls: 0, styleCalls: 0,
             startedAt: Date.now(), overBudget: false };
  }

  // 预算用尽时返回 true —— 调用方应尽快结束当前这轮识别
  function layoutBudgetExceeded() {
    if (!LAYOUT_CACHE) return false;
    if (LAYOUT_CACHE.overBudget) return true;
    if (LAYOUT_CACHE.rectCalls > LAYOUT_BUDGET.rects ||
        (Date.now() - LAYOUT_CACHE.startedAt) > LAYOUT_BUDGET.ms) {
      LAYOUT_CACHE.overBudget = true;
      return true;
    }
    return false;
  }

  function beginLayoutFrame() {
    LAYOUT_CACHE = newLayoutCache();
    return LAYOUT_CACHE;
  }

  function endLayoutFrame() {
    var stats = LAYOUT_CACHE;
    LAYOUT_CACHE = null;
    return stats;
  }

  function rectOf(el) {
    if (!LAYOUT_CACHE) {
      var rr = el.getBoundingClientRect();
      return { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom,
               width: rr.width, height: rr.height, x: rr.left, y: rr.top };
    }
    var hit = LAYOUT_CACHE.rects.get(el);
    if (hit) return hit;
    LAYOUT_CACHE.rectCalls++;
    var rect = el.getBoundingClientRect();
    // 转成普通对象，避免持有 live DOMRect
    var plain = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                  width: rect.width, height: rect.height, x: rect.left, y: rect.top };
    LAYOUT_CACHE.rects.set(el, plain);
    return plain;
  }

  function visibleCached(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!LAYOUT_CACHE) return isVisible(el);
    var hit = LAYOUT_CACHE.visible.get(el);
    if (hit !== undefined) return hit;
    LAYOUT_CACHE.styleCalls++;
    var result = isVisible(el);   // isVisible 内部已按元素所在文档取样式
    LAYOUT_CACHE.visible.set(el, result);
    return result;
  }

  /* --- 在给定根节点里找出「每一层消息」所在的那个层级 --- */
  function textDensity(el) {
    var total = clean(el.textContent).length;
    if (!total) return 0;
    var direct = 0;
    Array.prototype.forEach.call(el.childNodes, function (n) {
      if (n.nodeType === 3) direct += clean(n.textContent).length;
    });
    Array.prototype.forEach.call(el.children, function (c) {
      if (!c.children.length) direct += clean(c.textContent).length;
    });
    return direct / total;
  }

  // 只在「根节点的前 4 层」里找消息层，避免对整个页面做全子树递归。
  // 用 textContent（不触发布局）而不是 innerText（每次都要算整棵子树布局）。
  function findMessageLevel(root) {
    var candidates = [];
    var queue = [{ el: root, depth: 0 }];
    var visited = 0;
    var MAX_VISIT = 400;              // 硬上限，任何页面都不会跑爆

    while (queue.length && visited < MAX_VISIT) {
      if (layoutBudgetExceeded()) break;   // 安全阀：绝不把主线程拖死
      var item = queue.shift();
      var parent = item.el;
      var depth = item.depth;
      visited++;
      if (!parent || !parent.children) continue;

      var kids = [];
      for (var i = 0; i < parent.children.length; i++) {
        var c = parent.children[i];
        if (isOwnUI(c)) continue;
        if (!visibleCached(c)) continue;
        if (!clean(c.textContent).length) continue;
        kids.push(c);
      }

      if (kids.length) {
        var sum = 0;
        for (var k = 0; k < kids.length; k++) sum += textDensity(kids[k]);
        var avg = sum / kids.length;
        var hasSendish = /发送|输入|send|message|textarea|contenteditable/i.test(
          String(parent.className || '') + ' ' + String(parent.getAttribute('role') || '') + ' ' +
          String(parent.getAttribute('aria-live') || ''));
        // 真正的消息层：兄弟节点多、每条都比较「叶子化」、且尺寸相近
        var sameSize = 0;
        if (kids.length >= 2) {
          var h0 = rectOf(kids[0]).height;
          for (var s = 1; s < kids.length; s++) {
            if (Math.abs(rectOf(kids[s]).height - h0) < Math.max(12, h0 * 0.5)) sameSize++;
          }
          sameSize = sameSize / (kids.length - 1);
        }
        candidates.push({
          parent: parent,
          kids: kids,
          depth: depth,
          score: (kids.length >= 2 ? 1 : 0.35) * kids.length * (0.3 + avg) +
                 sameSize * 8 + (hasSendish ? 5 : 0)
        });
      }

      if (depth < 4) {
        for (var j = 0; j < parent.children.length; j++) {
          queue.push({ el: parent.children[j], depth: depth + 1 });
        }
      }
    }
    if (!candidates.length) return null;
    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates[0];
  }

  /* --- 判断一条消息是不是「我发的」 --- */
  function bubbleOf(node, listRect) {
    var maxWidth = listRect.width * 0.85;
    var found = null;
    var queue = [{ el: node, depth: 0 }];
    while (queue.length && !found) {
      var item = queue.shift();
      var el = item.el;
      if (!el || item.depth > 4) continue;
      var rect = rectOf(el);
      if (rect.width > 0 && rect.width <= maxWidth && clean(el.textContent).length > 0) {
        found = el;
        break;
      }
      for (var i = 0; i < el.children.length; i++) {
        queue.push({ el: el.children[i], depth: item.depth + 1 });
      }
    }
    return found || node;
  }

  function isSelfMessage(node, listRect) {
    var override = String(CONFIG.chatSelfSide || 'auto');
    if (override === 'right') return true;
    if (override === 'left') return false;

    var tokens = classTokens(node);
    var selfHit = tokens.some(function (t) { return SELF_HINTS.indexOf(t) >= 0; });
    var otherHit = tokens.some(function (t) { return OTHER_HINTS.indexOf(t) >= 0; });
    if (selfHit && !otherHit) return true;
    if (otherHit && !selfHit) return false;

    // class 看不出来就看位置：靠右的通常是「我」，靠左的是「对方」
    if (!listRect.width) return false;
    var rect = rectOf(bubbleOf(node, listRect));
    var center = (rect.left + rect.width / 2 - listRect.left) / listRect.width;
    if (center > 0.62) return true;
    if (center < 0.38) return false;

    // 几何也落在中间地带（例如装了 flex 但气泡满宽）时，
    // 用「行内对齐方式」再判断一次：右对齐=我，左对齐=对方
    var row = node;
    for (var up = 0; up < 4 && row && row !== CHAT.listEl; up++) {
      var cs = null;
      try { cs = window.getComputedStyle(row); } catch (e) { cs = null; }
      if (cs) {
        var justify = String(cs.justifyContent || '');
        var align = String(cs.textAlign || '');
        if (justify === 'flex-end' || align === 'right') return true;
        if (justify === 'flex-start' || align === 'left') return false;
      }
      row = row.parentElement;
    }
    return false;
  }

  /* --- 提取消息列表 --- */
  function chatListRect() {
    return CHAT.listEl ? rectOf(CHAT.listEl) : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  function extractMessages() {
    if (!CHAT.listEl) return [];
    beginLayoutFrame();
    try {
      var level = findMessageLevel(CHAT.listEl);
      if (!level) return [];
      var listRect = chatListRect();
      var out = [];
      level.kids.forEach(function (node) {
        var text = clean(node.textContent);
        if (!text) return;
        out.push({ el: node, text: text, self: isSelfMessage(node, listRect) });
      });
      return out;
    } finally {
      endLayoutFrame();
    }
  }

  /* --- 自动探测消息列表 / 输入框 --- */
  // 关键改进：不再遍历页面上每个 div（那既慢又会选中侧边栏会话列表），
  // 而是从「聊天输入框」出发自下而上找消息区 —— 输入框上方最近的、
  // 能滚动、且包含多段文本的容器，就是聊天区。
  // 判断 el 是否属于「输入区」——里面主要是输入控件/按钮，而不是消息内容。
  // 这样就能排除紧贴在输入框上方、容易被误认为消息区的 .chat-input 之类容器。
  function isInsideInputArea(el, input) {
    if (!el || !input) return false;
    var controls = el.querySelectorAll('textarea,input,button,[contenteditable="true"],[role="button"]');
    var texts = [];
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.contains(input)) continue;                 // 输入框本身所在的子树跳过
      if (c.querySelector('textarea,input,[contenteditable="true"]')) continue;
      var t = clean(c.textContent);
      if (t) texts.push(t);
    }
    // 没有任何「像样的文本内容」，且全是控件 → 这是输入区
    var hasRealText = texts.some(function (t) { return t.length > 30; });
    return !hasRealText && controls.length > 0;
  }

  function scoreAsChatList(el) {
    if (!el || el.nodeType !== 1 || isOwnUI(el)) return null;
    var rect = absoluteRect(el);
    if (rect.width < 180 || rect.height < 100) return null;

    var level = findMessageLevel(el);
    if (!level || !level.kids.length) return null;

    var score = level.score;
    // 消息条数是最强的信号：真正的聊天区会有多条消息
    score += Math.min(level.kids.length, 40) * 5;
    // 每条消息都应该有一定长度，否则可能只是按钮/标签列表
    var longEnough = 0;
    for (var i = 0; i < level.kids.length; i++) {
      if (clean(level.kids[i].textContent).length > 20) longEnough++;
    }
    if (level.kids.length && longEnough / level.kids.length < 0.5) score -= 40;
    var role = String(el.getAttribute('role') || '');
    var live = el.getAttribute('aria-live');
    var cls = String(el.className || '');

    if (role === 'log') score += 40;
    if (live) score += 25;
    if (/message|chat|conversation|dialog|timeline|msg|bubble|会话|消息|对话/i.test(cls)) score += 45;
    // 消息区通常是可滚动的
    if (el.scrollHeight > el.clientHeight + 10) score += 25;
    // 侧边栏/导航列表不是消息区，扣分
    if (/sidebar|nav|menu|list-group|drawer|aside|history|会话列表|侧边/i.test(cls)) score -= 80;
    if (/nav|aside/i.test(el.tagName)) score -= 80;

    // 面包屑 / 标题栏 / 工具栏 / 页签 —— 这些绝不是消息区。
    // （典型症状：识别到 2 条消息，内容是「商店 / 学习教育 / ...」）
    var roleAttr = String(el.getAttribute('role') || '');
    if (/breadcrumb|toolbar|header|titlebar|tabbar|tab-bar|navbar|topbar/i.test(cls) ||
        /breadcrumb|toolbar|banner/i.test(roleAttr) ||
        /breadcrumb|tabbar/i.test(el.tagName)) {
      score -= 300;
    }
    // 整行只有极少文字、却横向铺满 —— 典型的面包屑/标题
    var textLen = clean(el.textContent).length;
    if (textLen > 0 && textLen < 80 && rect.height < 90 && rect.width > rect.height * 4) {
      score -= 120;
    }
    // 消息区一般比较「高」，但过窄的列表（会话历史）要被压下去
    var ratio = rect.height / Math.max(rect.width, 1);
    if (ratio < 0.35) score -= 30;
    if (rect.height > 300) score += 15;

    return { el: el, score: score, count: level.kids.length, level: level };
  }

  function autoDetectChatList() {
    beginLayoutFrame();
    try {
      var input = CHAT.inputEl || (function () {
        var got = autoDetectChatInput();
        return got ? got.el : null;
      })();
      var candidates = [];

      if (input) {
        // 从输入框往上走，把祖先依次作为候选。
        // 注意：离输入框近的祖先可能只是「输入区」，真正装消息的是再上一层，
        // 所以用「这一层能识别出多少条消息」作为主要权重，距离只作微调。
        var node = input.parentElement;
        for (var up = 0; up < 6 && node && node !== document.body; up++) {
          // 跳过「只装着输入框本身」的窄容器（例如 .chat-input）：它不是消息区
          if (!isInsideInputArea(node, input)) {
            var scored = scoreAsChatList(node);
            if (scored) {
              // 消息条数是主要信号，距离只是很弱的微调（避免选中紧贴输入框的输入区）
              scored.score += Math.min(scored.count, 40) * 6 - up * 2;
              candidates.push(scored);
            }
          }
          node = node.parentElement;
        }
      }

      // 兜底：只扫描少量高置信度选择器，不再全页遍历。
      // 关键：跨所有同源文档扫描 —— 聊天区很可能在 iframe 里。
      if (!candidates.length) {
        var hints = queryAllDocsList(
          '[role="log"],[aria-live],[class*="message"],[class*="chat"],[class*="conversation"],[class*="dialog"]',
          false);
        var seenCand = [];
        for (var i = 0; i < hints.length && i < 120; i++) {
          if (seenCand.indexOf(hints[i]) >= 0) continue;
          seenCand.push(hints[i]);
          var got2 = scoreAsChatList(hints[i]);
          if (got2) candidates.push(got2);
        }
      }

      if (!candidates.length) return null;
      candidates.sort(function (a, b) { return b.score - a.score; });
      var winner = candidates[0];
      // 置信度过低就不要硬猜，交给用户手动指定
      if (winner.score < 10) return null;
      return winner;
    } finally {
      endLayoutFrame();
    }
  }

  function autoDetectChatInput() {
    // 跨所有同源文档查找（扣子等平台把输入框放在 iframe 里）
    var nodes = queryAllDocsList(
      'textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],input[type="text"]',
      false);
    var listRect = CHAT.listEl ? absoluteRect(CHAT.listEl) : { left: 0, top: 0, width: 0, height: 0 };
    var best = null;
    Array.prototype.forEach.call(nodes, function (el) {
      if (isOwnUI(el) || !visibleCached(el) || el.disabled || el.readOnly) return;
      var rect = absoluteRect(el);
      var score = 0;
      if (isEditableDiv(el)) score += 40;
      if (el.tagName.toLowerCase() === 'textarea') score += 35;
      var hint = String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '');
      if (CHAT_INPUT_STRONG.test(hint)) score += 30;
      if (/发送|send/i.test(String(el.parentElement ? el.parentElement.innerHTML : '').slice(0, 2000))) score += 15;
      if (listRect.width && rect.top >= listRect.top + listRect.height * 0.5) score += 25;
      if (rect.width > 150) score += 10;
      if (!best || score > best.score) best = { el: el, score: score };
    });
    return best;
  }

  // 探测输入框时也要有布局帧
  function detectInputFramed() {
    beginLayoutFrame();
    try { return autoDetectChatInput(); } finally { endLayoutFrame(); }
  }

  // 校验一个「消息区」是否真的像消息区。
  // 用来否决历史遗留下来的错误选择（例如之前误选了面包屑并保存下来）。
  function looksLikeRealChatList(el) {
    if (!el || !el.isConnected) return false;
    var rect = absoluteRect(el);
    if (rect.width < 150 || rect.height < 80) return false;      // 太扁/太小 → 不是
    var cls = String(el.className || '') + ' ' + String(el.getAttribute('role') || '') + ' ' +
              String(el.getAttribute('aria-label') || '');
    // 面包屑/标题栏/工具栏直接否决
    if (/breadcrumb|toolbar|header|titlebar|tabbar|navbar|topbar/i.test(cls) ||
        /breadcrumb|toolbar|banner/i.test(String(el.getAttribute('role') || ''))) return false;
    var level = findMessageLevel(el);
    if (!level || !level.kids.length) return false;
    // 至少要有 1 条「像消息」的子项：有一定文字量
    var good = 0;
    for (var i = 0; i < level.kids.length; i++) {
      if (clean(level.kids[i].textContent).length >= 8) good++;
    }
    if (!good) return false;
    // 整块的总文字量太小 → 更像面包屑而不是聊天记录
    if (clean(el.textContent).length < 20) return false;
    return true;
  }

  // 从 scoreAsChatList 命中的容器往下钻，找到「真正的消息列表那一层」。
  // 例如顶层的 body 命中了，但真正的消息在 iframe 内的 .chat-list 里。
  function narrowToMessageLevel(el, level) {
    if (!el) return null;
    if (level && level.parent === el && level.kids && level.kids.length) {
      // 命中层本身就是消息层，但若它的父节点正好只装着它一个，
      // 说明往上一层更"干净"，这里保持不变即可。
      return el;
    }
    // 在所有同源文档里，找 el 内部「含多条消息」的最内层容器
    var docs = allDocs();
    var best = null, bestCount = -1;
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d].doc;
      var inside = false;
      try { inside = doc === el.ownerDocument || el.contains(doc.body); } catch (e) { inside = false; }
      if (!inside) continue;
      var scope = (doc === el.ownerDocument) ? el : doc.body;
      if (!scope) continue;
      var cands = [];
      try { cands = scope.querySelectorAll('div,ul,ol,section,main'); } catch (e) { continue; }
      for (var i = 0; i < cands.length && i < 3000; i++) {
        var c = cands[i];
        if (isOwnUI(c)) continue;
        var lvl = findMessageLevel(c);
        if (!lvl || lvl.parent !== c) continue;
        if (lvl.kids.length < 2) continue;
        // 越深、消息越多、越"叶子化"越好
        var good = 0;
        for (var k = 0; k < lvl.kids.length; k++) {
          if (clean(lvl.kids[k].textContent).length >= 8) good++;
        }
        if (good < 2) continue;
        var score = good * 10 + lvl.kids.length;
        if (score > bestCount) { bestCount = score; best = c; }
      }
    }
    return best;
  }

  function ensureChatTargets(autoPick) {
    if (!CHAT.listEl || !CHAT.listEl.isConnected) {
      var saved = queryAllDocs(CONFIG.chatListSelector, false);     // 跨 iframe 查找
      if (saved) {
        if (looksLikeRealChatList(saved)) {
          CHAT.listEl = saved;
        } else {
          // 历史选择已经失效（典型：误选了面包屑）。丢弃它并重新自动识别。
          log('已保存的消息区域看起来不是聊天区（内容太少或像标题栏），重新自动识别…');
          saveConfig({ chatListSelector: '' });
          CHAT.listEl = null;
        }
      }
      if (!CHAT.listEl && autoPick) {
        var found = autoDetectChatList();
        if (found) {
          // 命中的外层容器（例如 body / #root）不是真正的消息列表，
          // 往下钻到实际承载消息的那一层，让 listEl 指得更准。
          var real = narrowToMessageLevel(found.el, found.level);
          CHAT.listEl = real || found.el;
          saveConfig({ chatListSelector: cssPathOf(CHAT.listEl) });
          var cnt = extractMessages().length;
          log('已自动识别消息区域（' + cnt + ' 条消息）');
        }
      }
    }
    if (!CHAT.inputEl || !CHAT.inputEl.isConnected) {
      CHAT.inputEl = queryAllDocs(CONFIG.chatInputSelector, false);   // 跨 iframe 查找
      if (!CHAT.inputEl && autoPick) {
        var got = detectInputFramed();
        if (got) {
          CHAT.inputEl = got.el;
          saveConfig({ chatInputSelector: cssPathOf(got.el) });
          log('已自动识别输入框');
        }
      }
    }
    return !!(CHAT.listEl && CHAT.inputEl);
  }

  /* --- 预览识别结果（用来确认到底读没读到）--- */
  function chatPreview() {
    if (!ensureChatTargets(true)) {
      log('没能识别出消息区域或输入框，请点「指定消息区域」手动选择。', 'error');
      return [];
    }
    var messages = extractMessages();
    log('识别到 ' + messages.length + ' 条消息：');
    messages.forEach(function (m, i) {
      var tag = looksLikeFeedback(m.text) ? '批改反馈'
              : (looksLikeQuestion(m.text) ? '题目' : '其他');
      log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '/' + tag + '] ' +
          m.text.replace(/\n/g, ' ').slice(0, 80));
    });
    var picked = pickPendingQuestion(messages);
    if (picked.msg) {
      log('→ 消息列表中待回答的（' + picked.why + '）：「' +
          picked.msg.text.replace(/\n/g, ' ').slice(0, 80) + '」');
    } else {
      log('→ 消息列表：' + picked.why);
    }

    // 内容驱动的结论 —— 这才是实际作答时使用的判据
    var byContent = findLatestPendingQuestion(true);
    if (byContent.text) {
      log('→ 实际将作答（' + byContent.reason + '）：「' +
          byContent.text.replace(/\n/g, ' ').slice(0, 90) + '」');
      if (byContent.previouslyAnswered && byContent.previousRecord) {
        var pr = byContent.previousRecord;
        log('   ⚠ 这道题以前出现过（本次是第 ' + ((pr.count || 1) + 1) + ' 次），上次答案：' +
            (pr.answer || '(无)') + '，时间：' + new Date(pr.time).toLocaleString());
      } else {
        log('   ✓ 这是一道新题');
      }
      setStatus('待答题目已就绪', '#0a0');
    } else {
      log('→ ' + byContent.reason, 'error');
      setStatus('没有待答题目', '#888');
    }

    if (ANSWER_LOG.length) {
      var done = ANSWER_LOG.filter(function (r) { return r.status === 'answered'; }).length;
      var skipped = ANSWER_LOG.filter(function (r) { return r.status === 'skipped'; }).length;
      var failed = ANSWER_LOG.filter(function (r) { return r.status === 'failed'; }).length;
      log('→ 已答 ' + done + ' 题，跳过 ' + skipped + ' 题，失败 ' + failed +
          ' 次（点「📋 答题记录」查看详情）');
    }
    return messages;
  }

  /* --- 写入输入框 --- */
  // 不能只信 el.isContentEditable：在部分浏览器/框架（以及未渲染的节点）上它并不可靠，
  // 误判会导致对 div 调用 input 的 value setter 而抛错。
  function isEditableDiv(el) {
    if (!el) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') return false;
    if (el.isContentEditable === true) return true;
    var attr = el.getAttribute ? el.getAttribute('contenteditable') : null;
    return attr === '' || attr === 'true' || attr === 'plaintext-only';
  }

  function setNativeValue2(el, value) {
    var tag = el.tagName;
    if (tag !== 'TEXTAREA' && tag !== 'INPUT') {
      // 不是原生输入控件（例如 contenteditable 的 div），直接写文本
      el.textContent = value;
      return;
    }
    var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function clearChatInput(el) {
    el.focus();
    if (isEditableDiv(el)) {
      var win = winOf(el);
      var doc = el.ownerDocument || document;
      try {
        var range = doc.createRange();
        range.selectNodeContents(el);
        var sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        doc.execCommand('delete', false, null);
      } catch (e) {
        el.textContent = '';
      }
      if (clean(el.textContent)) el.textContent = '';
      fireEvents(el, ['input', 'change']);
    } else {
      setNativeValue2(el, '');
      fireEvents(el, ['input', 'change']);
    }
  }

  function typeIntoChatInput(el, text) {
    clearChatInput(el);
    if (isEditableDiv(el)) {
      el.focus();
      // 富文本输入框统一用 execCommand 插入，React 等框架才能感知
      var win2 = winOf(el);
      var doc2 = el.ownerDocument || document;
      var ok = false;
      try { ok = doc2.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || !clean(el.textContent)) {
        // 回退：插入文本节点并派发 input
        var node = doc2.createTextNode(text);
        el.appendChild(node);
        try {
          el.dispatchEvent(new win2.InputEvent('input', {
            bubbles: true, cancelable: false, inputType: 'insertText', data: text
          }));
        } catch (e2) {
          fireEvents(el, ['input', 'change']);
        }
      }
      fireEvents(el, ['change', 'keyup']);
    } else {
      setNativeValue2(el, text);
      fireEvents(el, ['input', 'change']);
    }
    return clean(isEditableDiv(el) ? el.textContent : el.value);
  }

  function findSendButton(inputEl) {
    beginLayoutFrame();
    try { return findSendButtonInner(inputEl); } finally { endLayoutFrame(); }
  }

  function findSendButtonInner(inputEl) {
    var matches = [];
    var scope = inputEl.parentElement;
    for (var up = 0; up < 4 && scope; up++) {
      var btns = scope.querySelectorAll('button,[role="button"],a');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (isOwnUI(b) || !visibleCached(b)) continue;
        var label = visibleText(b) ||
                    clean(b.getAttribute('aria-label') || '') ||
                    clean(b.getAttribute('title') || '');
        var cls = String(b.getAttribute('class') || '');
        var exact = /^(发送|发送消息|提交|交卷|Send|Submit)$/i.test(label);
        var loose = /发送|send|submit/i.test(label + ' ' + cls);
        if (exact || loose) {
          var rect = rectOf(b);
          // 发送按钮通常在最右/最下，用它来在多个候选里挑最像的那个
          matches.push({ el: b, score: (exact ? 100 : 0) + rect.left + rect.top / 10 });
        }
      }
      scope = scope.parentElement;
    }
    if (!matches.length) return null;
    matches.sort(function (a, b) { return b.score - a.score; });
    return matches[0].el;
  }

  function pressEnter(el) {
    var win = winOf(el);
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                 bubbles: true, cancelable: true, composed: true };
    try {
      el.dispatchEvent(new win.KeyboardEvent('keydown', opts));
      el.dispatchEvent(new win.KeyboardEvent('keypress', opts));
      el.dispatchEvent(new win.KeyboardEvent('keyup', opts));
    } catch (e) {
      fireEvents(el, ['keydown', 'keypress', 'keyup']);
    }
  }

  function sendChatInput(inputEl) {
    var btn = findSendButton(inputEl);
    if (btn) { btn.click(); return 'button'; }
    pressEnter(inputEl);
    return 'enter';
  }

  /* --- 让模型回答「一段对话消息」 --  */
  var CHAT_SYSTEM_PROMPT = [
    '你是一个答题助手，需要替用户回复一个对话窗口里的提问。',
    '',
    '我会给你对方发来的消息内容。请你：',
    '1. 判断这条消息里是否包含需要作答的题目。',
    '2. 如果包含，给出可以直接发送出去的回复正文。',
    '3. 如果只是寒暄、通知或无需作答的内容，就跳过。',
    '',
    '回复要求：',
    '- 直接给答案，不要写「答案是」「我认为」这类套话。',
    '- 选择题只给选项字母（可附极简说明）；判断题答「正确」或「错误」。',
    '- 简答题简明扼要，不要长篇大论。',
    '- 有多道小题时按顺序逐条回答，每条另起一行并用 1. 2. 3. 编号。',
    '- 不要解释你在做什么，不要输出任何前后缀。',
    '',
    '只输出 JSON：',
    '{"skip": false, "answer": "回复正文"}',
    '若不需要回复，输出：{"skip": true, "answer": ""}'
  ].join('\n');

  // 统一的一轮对话调用：system + user → 文本。对话模式与代码模式共用。
  function callModelRaw(systemPrompt, user) {
    if (CONFIG.provider === 'anthropic') {
      return httpPost(CONFIG.baseUrl.replace(/\/+$/, '') + '/messages', {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }, {
        model: CONFIG.model,
        max_tokens: Number(CONFIG.maxTokens) || 2048,
        temperature: Number(CONFIG.temperature),
        system: systemPrompt,
        messages: [{ role: 'user', content: user }]
      }).then(function (text) {
        var data = JSON.parse(text);
        return (data.content || []).map(function (b) { return b.text || ''; }).join('');
      });
    }
    return httpPost(CONFIG.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CONFIG.apiKey
    }, {
      model: CONFIG.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: user }],
      temperature: Number(CONFIG.temperature),
      max_tokens: Number(CONFIG.maxTokens) || 2048
    }).then(function (text) {
      var data = JSON.parse(text);
      var choices = data.choices || [];
      if (!choices.length) throw new Error('接口返回里没有 choices');
      var content = choices[0].message ? choices[0].message.content : choices[0].text;
      if (Object.prototype.toString.call(content) === '[object Array]') {
        content = content.map(function (p) { return p.text || ''; }).join('');
      }
      var out = String(content || '');
      if (!out.trim()) {
        // 常见原因：max_tokens 太小，额度耗在思考上，正文为空
        var fr = choices[0].finish_reason || (choices[0].message && choices[0].message.finish_reason);
        throw new Error('模型返回为空' + (fr ? '（finish_reason=' + fr + '）' : '') +
          '：多半是 max_tokens 太小，请在「设置」里调大后重试');
      }
      return out;
    });
  }

  // 对话模式：把对方消息包成 user，沿用统一的 system 提示词
  function callModelForChat(messageText) {
    var NL = String.fromCharCode(10);
    var user = '对方发来的消息：' + NL + messageText + NL + NL + '请按上述要求给出回复 JSON。';
    return callModelRaw(CHAT_SYSTEM_PROMPT, user);
  }

  /* ------------------------------------------------------------ 代码模式
     适用于「Monaco 编辑器 + 关卡任务」的编程练习界面（如 Byte Goose）。
     这类页面和答题完全不同：
       · 题目是「任务目标」文字，不是选项
       · 答案是整段 Java 代码，不是字母
       · 编辑器是 Monaco 自绘的，textarea 只是输入代理，
         直接改 textarea.value 不会进入它的模型
     所以单独做一套：读任务 → 让模型产出完整代码 → 多策略写入并回读校验。 */

  var CODE = {
    busy: false,
    watching: false,
    watchers: [],
    timer: null,
    lastTaskHash: "",
    lastCode: "",
    lastFillHow: ""
  };

  function getMonacoGlobal() {
    try {
      if (window.monaco && window.monaco.editor) return window.monaco;
    } catch (e) { /* 某些页面禁止访问 */ }
    return null;
  }

  function inTraceArea(node) {
    var n = node;
    for (var i = 0; n && i < 10; i++) {
      var cls = String(n.className || '');
      if (/(code-trace|trace-line|trace-box|execution-view|step-view)/i.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function findMonacoRoot() {
    var docs = allDocs();
    var fallback = null;
    for (var i = 0; i < docs.length; i++) {
      var list = [];
      try { list = docs[i].doc.querySelectorAll(".monaco-editor"); } catch (e) { list = []; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        // 「逐行执行视图」里也可能塞一个 .monaco-editor 做只读镜像，
        // 它属于回溯面板，不是用户编辑的那个，必须排除。
        if (inTraceArea(el)) continue;
        // 真编辑器一定有隐藏 textarea（Monaco 的输入代理），优先认它
        var hasInput = false;
        try { hasInput = !!el.querySelector("textarea.inputarea, textarea"); } catch (e) { hasInput = false; }
        if (hasInput) return el;
        if (!fallback) fallback = el;
      }
    }
    return fallback;
  }

  function findCodeTextarea() {
    var root = findMonacoRoot();
    if (!root) return null;
    var ta = null;
    try { ta = root.querySelector("textarea.inputarea"); } catch (e) { ta = null; }
    if (!ta) { try { ta = root.querySelector("textarea"); } catch (e) { ta = null; } }
    return ta;
  }

  function findRunButton() {
    var words = ["启动运行", "运行代码", "执行代码", "运行", "执行"];
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var btns = [];
      try { btns = docs[i].doc.querySelectorAll("button,[role=button]"); } catch (e) { btns = []; }
      for (var j = 0; j < btns.length; j++) {
        var btn = btns[j];
        if (isOwnUI(btn)) continue;
        var t = clean(btn.textContent);
        if (!t || t.length > 8) continue;
        for (var k = 0; k < words.length; k++) {
          if (t === words[k]) return btn;
        }
      }
    }
    return null;
  }

  function findBlockByPrefix(prefix, maxLen) {
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var nodes = [];
      try { nodes = docs[i].doc.querySelectorAll("section,div,aside,pre"); } catch (e) { nodes = []; }
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (isOwnUI(node)) continue;
        var t = clean(node.textContent);
        if (!t || t.length > (maxLen || 600)) continue;
        if (t.indexOf(prefix) === 0) return node;
      }
    }
    return null;
  }

  function readEditorCode() {
    var m = getMonacoGlobal();
    if (m) {
      var eds = [];
      try { eds = m.editor.getEditors ? m.editor.getEditors() : []; } catch (e) { eds = []; }
      for (var i = 0; i < eds.length; i++) {
        try { return String(eds[i].getValue()); } catch (e) { /* 下一个 */ }
      }
      var models = [];
      try { models = m.editor.getModels ? m.editor.getModels() : []; } catch (e) { models = []; }
      for (var j = 0; j < models.length; j++) {
        try { return String(models[j].getValue()); } catch (e) { /* 下一个 */ }
      }
    }
    // 兜底：读 Monaco 自己渲染出来的 .view-line。
    // 关键是必须限定在 .monaco-editor 内部 —— 页面旁边常有一个「逐行执行视图 /
    // 代码回溯」面板，里面也是同样的行文本，但它是**上一次运行的结果**，
    // 不是编辑器真值。拿它做写入校验会得出「明明写进去了却报失败」。
    // 行数不做限制：单行代码（如 me.setEnergy(4);）本身就是合法内容。
    var root = findMonacoRoot();
    if (root) {
      var lines = [];
      try { lines = root.querySelectorAll(".view-line"); } catch (e) { lines = []; }
      // 只认不在回溯面板里的行
      lines = Array.prototype.slice.call(lines).filter(function (n) { return !inTraceArea(n); });
      if (lines.length) {
        var out = [];
        for (var k = 0; k < lines.length; k++) out.push(clean(lines[k].textContent));
        return out.join(String.fromCharCode(10));
      }
    }
    return "";
  }

  function normalizeCode(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/\r\n/g, String.fromCharCode(10))
      .replace(/[ \t]+$/gm, "")
      .trim();
  }

  function readCodeTask() {
    var docs = allDocs();
    var goal = "";
    var title = "";
    var apiText = "";

    for (var i = 0; i < docs.length && !goal; i++) {
      var panel = null;
      try { panel = docs[i].doc.querySelector(".story-panel"); } catch (e) { panel = null; }
      if (panel) {
        goal = clean(panel.textContent)
          .replace(/^任务目标\s*/, "")
          .replace(/^💡\s*Tips\s*/i, "")
          .trim();
      }
    }
    if (!goal) {
      var node = findBlockByPrefix("任务目标", 500);
      if (node) {
        goal = clean(node.textContent)
          .replace(/^任务目标\s*/, "")
          .replace(/^💡\s*Tips\s*/i, "")
          .trim();
      }
    }
    if (!goal) {
      var cur = findBlockByPrefix("当前任务", 400);
      if (cur) goal = clean(cur.textContent).replace(/^当前任务\s*/, "").trim();
    }

    for (var k = 0; k < docs.length && !title; k++) {
      var active = null;
      try { active = docs[k].doc.querySelector(".level-item.active"); } catch (e) { active = null; }
      if (!active) {
        try { active = docs[k].doc.querySelector(".assignment-item-button.active"); } catch (e2) { active = null; }
      }
      if (active) {
        var copy = null;
        try { copy = active.querySelector(".assignment-item-copy"); } catch (e3) { copy = null; }
        title = clean(copy ? copy.textContent : active.textContent);
      }
    }

    for (var m = 0; m < docs.length && !apiText; m++) {
      var apiNode = null;
      try { apiNode = docs[m].doc.querySelector(".api-panel"); } catch (e) { apiNode = null; }
      if (apiNode) {
        apiText = clean(apiNode.textContent).replace(/^可用\s*API\s*/i, "").slice(0, 1200);
      }
    }
    if (!apiText) {
      var fb = findBlockByPrefix("可用 API", 1200);
      if (fb) apiText = clean(fb.textContent).replace(/^可用\s*API\s*/i, "").slice(0, 1200);
    }

    // 「需要修复 / 教学策略」是平台的硬性约束（例如只允许变量、判断、循环、
    // 数组、集合和教学 API，不许用线程、文件、网络、反射）。不把它给模型，
    // 模型会写出被判定的代码，白白浪费一轮。
    var rules = "";
    var rulePrefixes = ["需要修复", "教学策略", "限制", "规则"];
    for (var q = 0; q < rulePrefixes.length && !rules; q++) {
      var rn = findBlockByPrefix(rulePrefixes[q], 800);
      if (rn) {
        rules = clean(rn.textContent)
          .replace(/^需要修复\s*/, "")
          .replace(/^教学策略[:：]\s*/, "")
          .slice(0, 800);
      }
    }

    // 太短的多半不是任务文本（公告、占位符等），不要拿去请求模型
    if (goal.length < 6) goal = '';

    return {
      title: title,
      goal: goal,
      api: apiText,
      rules: rules,
      code: readEditorCode(),
      hasEditor: !!findMonacoRoot()
    };
  }

  function pressKey(el, key, keyCode, mods) {
    var w = winOf(el);
    var opts = {
      key: key,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      ctrlKey: !!(mods && mods.ctrlKey),
      shiftKey: !!(mods && mods.shiftKey),
      altKey: !!(mods && mods.altKey)
    };
    var types = ["keydown", "keypress", "keyup"];
    for (var i = 0; i < types.length; i++) {
      try { el.dispatchEvent(new w.KeyboardEvent(types[i], opts)); } catch (e) { /* 忽略 */ }
    }
  }

  function fillViaMonaco(code) {
    var m = getMonacoGlobal();
    if (!m) return false;
    var eds = [];
    try { eds = m.editor.getEditors ? m.editor.getEditors() : []; } catch (e) { eds = []; }
    for (var i = 0; i < eds.length; i++) {
      try { eds[i].setValue(code); return true; } catch (e) { /* 下一个 */ }
    }
    var models = [];
    try { models = m.editor.getModels ? m.editor.getModels() : []; } catch (e) { models = []; }
    for (var j = 0; j < models.length; j++) {
      try { models[j].setValue(code); return true; } catch (e) { /* 下一个 */ }
    }
    return false;
  }

  function fillViaSelectAll(code) {
    var ta = findCodeTextarea();
    if (!ta) return false;
    var doc = ta.ownerDocument || document;
    try { ta.focus(); } catch (e) { /* 忽略 */ }
    pressKey(ta, "a", 65, { ctrlKey: true });
    var ok = false;
    try { ok = doc.execCommand("insertText", false, code); } catch (e) { ok = false; }
    if (!ok) {
      try {
        if (typeof ta.setRangeText === "function") {
          ta.setRangeText(code, 0, ta.value.length, "end");
          fireEvents(ta, ["input", "change"]);
          ok = true;
        }
      } catch (e2) { ok = false; }
    }
    return ok;
  }

  function fillViaPaste(code) {
    var ta = findCodeTextarea();
    if (!ta) return false;
    var w = winOf(ta);
    try { ta.focus(); } catch (e) { /* 忽略 */ }
    pressKey(ta, "a", 65, { ctrlKey: true });
    var dt = null;
    try { dt = new w.DataTransfer(); } catch (e) { dt = null; }
    if (!dt) return false;
    try { dt.setData("text/plain", code); } catch (e) { return false; }
    var ev = null;
    try {
      ev = new w.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    } catch (e) { ev = null; }
    if (!ev) return false;
    try { ta.dispatchEvent(ev); return true; } catch (e) { return false; }
  }

  function fillViaNative(code) {
    var ta = findCodeTextarea();
    if (!ta) return false;
    try { ta.focus(); } catch (e) { /* 忽略 */ }
    pressKey(ta, "a", 65, { ctrlKey: true });
    setNativeValue2(ta, code);
    fireEvents(ta, ["input", "change"]);
    return true;
  }

  function fillEditorCode(code) {
    var want = normalizeCode(code);
    var attempts = [
      { name: "Monaco 接口", fn: fillViaMonaco },
      { name: "全选替换", fn: fillViaSelectAll },
      { name: "粘贴事件", fn: fillViaPaste },
      { name: "原生赋值", fn: fillViaNative }
    ];
    var lastGot = "";
    for (var i = 0; i < attempts.length; i++) {
      try { attempts[i].fn(code); } catch (e) { /* 换下一种 */ }
      // 有的平台是异步重绘，同步读会拿到上一帧；所以这里只判"相等"，
      // 真正的复检交给 verifyFilled() 延迟一拍再做。
      var got = normalizeCode(readEditorCode());
      lastGot = got;
      if (got && got === want) {
        return { ok: true, how: attempts[i].name, got: got };
      }
    }
    return { ok: false, how: "", got: lastGot };
  }

  // 写入之后的延迟复检：给 Monaco 一两帧时间重绘，再读一次。
  // 只要最终读到的与目标一致就算成功（这一步能把"同步读到的旧值"救回来）。
  function verifyFilled(code, how) {
    var want = normalizeCode(code);
    return new Promise(function (resolve) {
      var tries = 0;
      function tick() {
        tries++;
        var got = normalizeCode(readEditorCode());
        if (got && got === want) {
          resolve({ ok: true, how: how, got: got, verifyTries: tries });
          return;
        }
        if (tries >= 6) {
          resolve({ ok: false, how: how, got: got, verifyTries: tries });
          return;
        }
        setTimeout(tick, 120);
      }
      setTimeout(tick, 120);
    });
  }

  // 「命令行输出」面板：平台运行/提交的结果都打在这里
  function readConsoleOutput() {
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var nodes = [];
      try { nodes = docs[i].doc.querySelectorAll(".panel-title, h1, h2, h3, div"); } catch (e) { nodes = []; }
      for (var j = 0; j < nodes.length; j++) {
        var t = clean(nodes[j].textContent);
        if (t.indexOf("命令行输出") !== 0) continue;
        var box = nodes[j].parentElement;
        if (!box) continue;
        return clean(box.textContent).replace(/^命令行输出\s*/, "");
      }
    }
    return "";
  }

  // 平台的自定义状态码：598 常见于网关限流/超时（nginx limit_req / 上游超时）。
  // 编程练习2 有提交配额，自由练习没有，所以同一个脚本在自由练习能跑、
  // 在作业模式里会报 598。
  var RUN_ERROR_MARK = /(Request failed with status code \d{3}|status code 598|error:|Exception|编译失败|运行失败|超时)/;

  function checkRunResult() {
    var out = readConsoleOutput();
    if (!out) return { ok: null, text: "" };
    if (!RUN_ERROR_MARK.test(out)) return { ok: true, text: out };
    var m598 = out.match(/status code (\d{3})/);
    var code = m598 ? m598[1] : "";
    if (code === "598") {
      // 实测结论：598 是学校 VPN/WAF（深信服 webproxy）的拦截码，
      // 触发条件是请求体里出现「函数调用 + 分号」这种代码特征，
      // 与频率、配额无关 —— 空代码能过，任何真代码都被拦。
      // 手动点「启动运行」同样 598，所以不是脚本的问题。
      log("运行被平台的网关防火墙拦截：598 Forbidden", "error");
      log("这不是代码写错。同一次请求手动点「启动运行」也会 598。", "warn");
      log("触发原因：网关对请求体里的代码内容做特征拦截（如 me.moveForward();）", "warn");
      log("能做的：换网络（手机热点）或等网关规则调整；代码已正确填入，可手动复制到平台外运行。", "warn");
    } else if (code) {
      log("运行失败：HTTP " + code, "error");
    } else {
      log("运行失败：" + out.slice(0, 120), "error");
    }
    return { ok: false, text: out, code: code };
  }

  function clickRunButton() {
    var btn = findRunButton();
    if (!btn) { log("没找到「启动运行」按钮", "error"); return false; }
    log("点击「" + clean(btn.textContent) + "」");
    try { btn.click(); } catch (e) {
      log("点击失败：" + e.message, "error");
      return false;
    }
    // 一秒后看结果面板，把 598 这类平台侧错误明确说出来
    setTimeout(function () {
      var res = checkRunResult();
      if (res.ok === true) log("运行结果：" + res.text.slice(0, 80));
    }, 1200);
    return true;
  }

  function codePreview() {
    var t = readCodeTask();
    log("—— 代码模式 ——");
    log("Monaco 编辑器：" + (t.hasEditor ? "已找到" : "未找到（页面可能还没加载完）"));
    if (t.title) log("关卡：" + t.title);
    log("任务目标（" + t.goal.length + " 字）：「" + t.goal.replace(/\n/g, " ").slice(0, 100) + "」");
    if (t.api) log("可用 API：「" + t.api.replace(/\n/g, " ").slice(0, 90) + "」");
    if (t.rules) log("平台限制：「" + t.rules.replace(/\n/g, " ").slice(0, 90) + "」");
    if (t.code) {
      log("编辑器当前代码（" + t.code.length + " 字）：「" + t.code.replace(/\n/g, " / ").slice(0, 100) + "」");
    } else {
      log("编辑器当前代码：读不到（可先点一下代码区再试）");
    }
    log("「启动运行」按钮：" + (findRunButton() ? "已找到" : "未找到"));
    setStatus(t.goal ? "任务已读取" : "没找到任务目标", t.goal ? "#0a0" : "#e33");
    return t;
  }

  /* ---- 内置答案库 ----
     由 tools/scrape-levels.mjs 抓取并离线生成，随脚本一起分发。
     命中就直接插入，不联网、不调模型，切关即填。 */
  var BUILTIN_ANSWERS = (typeof window !== 'undefined' && window.__QUIZBOT_ANSWERS__) || [
/* __BUILTIN_START__ */
  {
    "index": 1,
    "title": "点亮训练室",
    "goal": "代码修复局的训练室刚刚重启。给机器人设置能量，然后让它走到蓝色终端。设置不少于 4 点能量，并让机器人前进 4 格到达终点。",
    "api": "me.moveForward()\n必须使用: for",
    "must": "for",
    "code": "me.setEnergy(4);\nfor (int i = 0; i < 4; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 2,
    "title": "变量命名检查",
    "goal": "训练室要求用有意义的变量名保存移动距离，让代码更容易读懂。使用 moveCount 变量保存移动次数，并让机器人到达终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: moveCount",
    "must": "moveCount",
    "code": "int moveCount = 4;\nme.setEnergy(moveCount);\nfor (int i = 0; i < moveCount; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 3,
    "title": "数据类型闸门",
    "goal": "控制台返回了状态值。请用 int、boolean 和 String 保存信息，再决定是否启动机器人。使用基本数据类型保存状态，条件满足时移动到终端。",
    "api": "boolean\nString\nstatus.equals(\"online\")\n必须使用: boolean",
    "must": "boolean",
    "code": "int energy = 4;\nboolean ready = true;\nString status = \"online\";\nif (status.equals(\"online\") && ready) {\n    me.setEnergy(energy);\n    for (int i = 0; i < energy; i++) {\n        me.moveForward();\n    }\n}"
  },
  {
    "index": 4,
    "title": "运算符能量表",
    "goal": "能源站给出基础能量和补偿能量。请用运算符计算最终移动距离。使用表达式算出 4 步能量，并移动到终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: +",
    "must": "+",
    "code": "int base = 2;\nint bonus = 3;\nint distance = base + bonus - 1;\nme.setEnergy(distance);\nfor (int i = 0; i < distance; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 5,
    "title": "避开仓库墙",
    "goal": "物流仓库的通道出现障碍。机器人需要在前方有墙时转向，否则继续前进。使用 frontIsWall() 判断墙壁，绕过障碍到达终点。",
    "api": "me.turnRight()\nme.turnLeft()\nme.moveForward()\n必须使用: if",
    "must": "if",
    "code": "for (int i = 0; i < 8; i++) {\n    if (me.frontIsWall()) {\n        me.turnRight();\n    } else {\n        me.moveForward();\n    }\n}"
  },
  {
    "index": 6,
    "title": "颜色 switch 分拣",
    "goal": "分拣中心把包裹颜色作为字符串返回。请用 switch 判断颜色并送到对应区域。读取红色包裹，使用 switch 分支，把它送到红色投递点。",
    "api": "switch (color)\ncase \"red\"\nbreak\n必须使用: switch",
    "must": "switch",
    "code": "String color = me.scanColor();\nswitch (color) {\n    case \"red\":\n        me.pick();\n        me.moveForward();\n        me.drop();\n        break;\n    default:\n        break;\n}"
  },
  {
    "index": 7,
    "title": "循环搬运",
    "goal": "循环工厂需要机器人把包裹搬到投递点。重复动作比一行一行硬写更可靠。拾取包裹，使用循环移动到投递点，并放下包裹。",
    "api": "me.drop()\nme.moveForward()\nme.turnLeft()\nme.turnRight()\n必须使用: for",
    "must": "for",
    "code": "me.pick();\nfor (int i = 0; i < 4; i++) {\n    me.moveForward();\n}\nme.drop();"
  },
  {
    "index": 8,
    "title": "直到终端前",
    "goal": "循环工厂的巡检通道很长，机器人需要一直前进，直到前方出现终端墙。使用 while 和 frontIsWall()，让机器人停在绿色终端格。",
    "api": "me.moveForward()\n必须使用: while",
    "must": "while",
    "code": "while (!me.frontIsWall()) {\n    me.moveForward();\n}"
  },
  {
    "index": 9,
    "title": "跳过第一次巡检",
    "goal": "巡检机器人第一轮只做系统自检，不移动；到达终端后如果前方是墙就停止循环。使用 continue 跳过第一次循环，使用 break 在终点前停止。",
    "api": "break\nme.frontIsWall()\nme.moveForward()\n必须使用: continue",
    "must": "continue",
    "code": "for (int i = 0; i < 8; i++) {\n    if (i == 0) {\n        continue;\n    }\n    if (me.frontIsWall()) {\n        break;\n    }\n    me.moveForward();\n}"
  },
  {
    "index": 10,
    "title": "日志巡检",
    "goal": "维修小队需要在关键步骤留下日志，方便教师讲解程序执行顺序。使用 me.log(...) 记录开始和结束，并移动到终端。",
    "api": "字符串拼接 +\nfor 循环\n必须使用: log",
    "must": "log",
    "code": "me.log(\"开始巡检\");\nfor (int i = 0; i < 4; i++) {\n    me.log(\"第 \" + (i + 1) + \" 步\");\n    me.moveForward();\n}\nme.log(\"巡检结束\");"
  },
  {
    "index": 11,
    "title": "颜色分拣",
    "goal": "物流仓库开始按颜色分拣。机器人需要读取包裹颜色，并把红色包裹送到红色投递点。使用 scanColor() 读取颜色，判断 red 后投递到红色区域。",
    "api": "color.equals(\"red\")\nme.pick()\nme.drop()\nme.moveForward()\n必须使用: String",
    "must": "String",
    "code": "String color = me.scanColor();\nif (color.equals(\"red\")) {\n    me.pick();\n    for (int i = 0; i < 3; i++) {\n        me.moveForward();\n    }\n    me.drop();\n}"
  },
  {
    "index": 12,
    "title": "数组路线",
    "goal": "地图终端给出一串路线参数。机器人需要按数组里的步数分段移动和转向。使用 int[] 保存路线，按 2、2 的步数走到终端。",
    "api": "for (int steps : route)\nme.frontIsWall()\nme.turnRight()\nme.moveForward()\n必须使用: int[]",
    "must": "int[]",
    "code": "int[] route = {2, 2};\nfor (int steps : route) {\n    for (int i = 0; i < steps; i++) {\n        me.moveForward();\n    }\n    me.turnRight();\n}"
  },
  {
    "index": 13,
    "title": "能量预算",
    "goal": "维修小队的电量有限。请用变量计算需要移动的次数，不要把每一步都写死。用变量保存移动次数，并让机器人刚好到达终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: int",
    "must": "int",
    "code": "int distance = 4;\nme.setEnergy(distance);\nfor (int i = 0; i < distance; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 14,
    "title": "错误保护",
    "goal": "仓库终端要求机器人移动前先检测前方，否则会撞墙。这个关卡适合课堂讲解运行失败原因。每次移动前先判断墙壁，安全到达终点。",
    "api": "me.turnRight()\nme.moveForward()\n必须使用: if",
    "must": "if",
    "code": "for (int i = 0; i < 8; i++) {\n    if (me.frontIsWall()) {\n        me.turnRight();\n    }\n    me.moveForward();\n}"
  },
  {
    "index": 15,
    "title": "方法返回值",
    "goal": "系统提供了一个 EnergyPlan 对象。请调用它的方法获取步数并执行计划。创建 EnergyPlan 对象，调用 steps() 和 apply(...) 完成移动。",
    "api": "plan.steps()\nplan.apply(me)\n必须使用: steps()",
    "must": "steps()",
    "code": "EnergyPlan plan = new EnergyPlan(4);\nint steps = plan.steps();\nplan.apply(me);"
  },
  {
    "index": 16,
    "title": "封装的能量计划",
    "goal": "EnergyPlan 内部用 private 保存步数，外部不能直接改字段，只能通过公开方法读取和执行。通过公开方法 steps() 和 apply(me) 使用封装对象。",
    "api": "public steps()\npublic apply(me)\n必须使用: EnergyPlan",
    "must": "EnergyPlan",
    "code": "EnergyPlan plan = new EnergyPlan(4);\nint steps = plan.steps();\nplan.apply(me);"
  },
  {
    "index": 17,
    "title": "抽象任务步骤",
    "goal": "MoveStep 继承抽象类 MissionStep，并实现 run(me) 方法。学生先使用这个对象理解抽象类的调用方式。用 MissionStep 类型接收 MoveStep 对象，并执行 run(me)。",
    "api": "class MoveStep extends MissionStep\nstep.run(me)\n必须使用: MissionStep",
    "must": "MissionStep",
    "code": "MissionStep step = new MoveStep(4);\nstep.run(me);"
  },
  {
    "index": 18,
    "title": "接口命令",
    "goal": "RobotCommand 是统一命令接口，ForwardCommand 是它的实现类。用接口类型保存实现类对象，并执行 run(me)。",
    "api": "class ForwardCommand implements RobotCommand\ncommand.run(me)\n必须使用: RobotCommand",
    "must": "RobotCommand",
    "code": "RobotCommand command = new ForwardCommand(4);\ncommand.run(me);"
  },
  {
    "index": 19,
    "title": "多态路线",
    "goal": "同一个 RobotCommand 数组里可以放不同命令对象，运行时会执行各自的 run(me)。使用接口数组保存前进和转向命令，组合出一条折线路线。",
    "api": "new ForwardCommand(2)\nnew TurnRightCommand()\n多态 run(me)\n必须使用: RobotCommand[]",
    "must": "RobotCommand[]",
    "code": "RobotCommand[] commands = {\n    new ForwardCommand(2),\n    new TurnRightCommand(),\n    new ForwardCommand(2)\n};\nfor (RobotCommand command : commands) {\n    command.run(me);\n}"
  },
  {
    "index": 20,
    "title": "集合任务队列",
    "goal": "调度中心把命令放入 List 队列，机器人按顺序执行每个命令。使用 ArrayList 保存 RobotCommand，并依次执行。",
    "api": "commands.add(...)\n增强 for 循环\n必须使用: ArrayList",
    "must": "ArrayList",
    "code": "ArrayList<RobotCommand> commands = new ArrayList<>();\ncommands.add(new ForwardCommand(2));\ncommands.add(new TurnRightCommand());\ncommands.add(new ForwardCommand(2));\nfor (RobotCommand command : commands) {\n    command.run(me);\n}"
  }
/* __BUILTIN_END__ */
  ];

  function normalizeTitle(s) {
    return String(s || '').replace(/[\s\u00a0]+/g, '').toLowerCase();
  }

  // 匹配只信「题面」。关卡标题在不同视图下会带 "1-1"、"GAME · v1 · 5 分"
  // 之类的包装，一旦用模糊匹配就会把不相干的题吃掉，所以标题只做全等兜底。
  var BUILTIN_GOAL_MIN = 20;   // 题面短于这个长度时不做包含匹配，太容易误中

  function goalOverlap(a, b) {
    if (!a || !b) return 0;
    var s = Math.min(a.length, b.length);
    var l = Math.max(a.length, b.length);
    if (l === 0) return 0;
    if (a.indexOf(b) < 0 && b.indexOf(a) < 0) return 0;
    return s / l;
  }

  function findBuiltinAnswer(task) {
    if (!BUILTIN_ANSWERS.length) return null;
    var wantTitle = normalizeTitle(task.title);
    var wantGoal = normalizeTitle(task.goal);
    var i;

    // 1) 题面完全一致（最可靠）
    if (wantGoal) {
      for (i = 0; i < BUILTIN_ANSWERS.length; i++) {
        if (normalizeTitle(BUILTIN_ANSWERS[i].goal) === wantGoal) return BUILTIN_ANSWERS[i];
      }
    }

    // 2) 题面高度重叠（页面可能追加提示语）
    if (wantGoal.length >= BUILTIN_GOAL_MIN) {
      var best = null, bestScore = 0;
      for (i = 0; i < BUILTIN_ANSWERS.length; i++) {
        var score = goalOverlap(wantGoal, normalizeTitle(BUILTIN_ANSWERS[i].goal));
        if (score >= 0.85 && score > bestScore) { best = BUILTIN_ANSWERS[i]; bestScore = score; }
      }
      if (best) return best;
    }

    // 3) 标题完全一致（去掉 "1-1" 前缀、去掉 "GAME · v1 · 5 分" 后缀后比较）
    if (wantTitle) {
      for (i = 0; i < BUILTIN_ANSWERS.length; i++) {
        if (normalizeTitle(BUILTIN_ANSWERS[i].title) === wantTitle) return BUILTIN_ANSWERS[i];
      }
      var core = wantTitle.replace(/^\d+[-.]\d+/, "").replace(/game.*$/, "");
      if (core.length >= 4) {
        for (i = 0; i < BUILTIN_ANSWERS.length; i++) {
          if (normalizeTitle(BUILTIN_ANSWERS[i].title) === core) return BUILTIN_ANSWERS[i];
        }
      }
    }

    return null;
  }

  function codeDoTask(force) {
    if (CODE.busy) { log("代码模式正在处理…"); return Promise.resolve(null); }
    var task = readCodeTask();
    // 内置答案优先：有就不用联网，也不用等模型
    var builtin = findBuiltinAnswer(task);
    if (!task.goal) {
      log("没找到任务目标：请确认页面停在编程关卡（右侧应有「任务目标」）", "error");
      setStatus("没找到任务目标", "#e33");
      return Promise.resolve(null);
    }
    if (!task.hasEditor) {
      log("没找到 Monaco 编辑器：请等页面加载完，或先点一下代码区", "error");
      setStatus("没找到编辑器", "#e33");
      return Promise.resolve(null);
    }
    var hash = hashText((task.title || "") + "|" + task.goal);
    if (!force && hash === CODE.lastTaskHash) return Promise.resolve(null);

    if (builtin) {
      CODE.busy = true;
      try {
        var bres = fillEditorCode(builtin.code);
        if (bres.ok) {
          CODE.lastTaskHash = hash;
          CODE.lastCode = builtin.code;
          CODE.lastFillHow = bres.how + "/内置";
          log("命中内置答案：" + (builtin.title || task.title || "") + "（" + bres.how + "）");
          setStatus("已填入内置答案", "#0a0");
          if (CONFIG.codeAutoRun) setTimeout(clickRunButton, 400);
          return Promise.resolve({ ok: true, code: builtin.code, how: CODE.lastFillHow, builtin: true });
        }
        log("内置答案没能写进编辑器，改用 AI 现写", "warn");
      } finally {
        CODE.busy = false;
      }
    }

    if (!CONFIG.baseUrl || !CONFIG.model) {
      log("没命中内置答案，且未配置 API。请在「设置」里填写 Base URL 和模型名", "error");
      setStatus("无内置答案且未配置 API", "#e33");
      return Promise.resolve(null);
    }

    CODE.busy = true;
    setStatus("请求 AI 写代码…", "#666");
    log("任务（" + task.goal.length + " 字）：「" + task.goal.replace(/\n/g, " ").slice(0, 90) + "」");

    return callModelForCode(task.goal, task.code, task.api, task.rules).then(function (raw) {
      var data = parseLooseJson(raw);
      var code = String(data.code === undefined ? "" : data.code).trim();
      if (!code) throw new Error("模型没有返回 code 字段");
      var lineCount = code.split(String.fromCharCode(10)).length;
      log("AI 代码（" + lineCount + " 行）" + (data.explain ? "：" + data.explain : ""));
      var res = fillEditorCode(code);
      var settle = res.ok ? Promise.resolve(res) : verifyFilled(code, res.how);
      return settle.then(function (fin) {
        if (fin.ok) {
          CODE.lastTaskHash = hash;
          CODE.lastCode = code;
          CODE.lastFillHow = fin.how || "延迟复检";
          markHandled(task.goal, { status: "answered", answer: code.slice(0, 120) });
          log("已写入编辑器（方式：" + CODE.lastFillHow + "）");
          setStatus("代码已填入", "#0a0");
          if (CONFIG.codeAutoRun) setTimeout(clickRunButton, 400);
          return { ok: true, code: code, how: CODE.lastFillHow };
        }
        // 确实写不进去：如实报失败，不假装成功
        log("代码没写进编辑器，读回的是：「" + String(fin.got || "").slice(0, 60) + "」", "error");
        log("先手动点一下代码区，再点「② 生成并填入代码」重试", "error");
        setStatus("写入编辑器失败", "#e33");
        addFailureRecord(task.goal, "写入编辑器失败");
        return { ok: false, code: code, got: fin.got };
      });
    }).catch(function (err) {
      log("出错: " + err.message, "error");
      setStatus("出错，详见日志", "#e33");
      addFailureRecord(task.goal, err.message);
      return null;
    }).then(function (v) {
      CODE.busy = false;
      return v;
    });
  }

  function codeSchedule() {
    if (!CODE.watching) return;
    if (CODE.timer) clearTimeout(CODE.timer);
    CODE.timer = setTimeout(function () {
      CODE.timer = null;
      if (!CODE.watching) return;
      codeDoTask(false);
    }, 900);
  }

  function codeStartWatch() {
    if (CODE.watching) return true;
    if (!findMonacoRoot()) {
      log("没找到 Monaco 编辑器，无法开启代码模式自动填充", "error");
      return false;
    }
    var docs = allDocs();
    var obs = [];
    for (var i = 0; i < docs.length; i++) {
      var body = docs[i].doc.body;
      if (!body) continue;
      try {
        var w = docs[i].doc.defaultView || window;
        var o = new w.MutationObserver(function () { codeSchedule(); });
        o.observe(body, { childList: true, subtree: true, characterData: true });
        obs.push(o);
      } catch (e) { /* 跳过该文档 */ }
    }
    if (!obs.length) { log("没能挂上监听（页面结构异常）", "error"); return false; }
    CODE.watchers = obs;
    CODE.watching = true;
    var t0 = readCodeTask();
    CODE.lastTaskHash = hashText((t0.title || "") + "|" + t0.goal);
    log("已开启代码模式自动填充：切到新关卡会自动生成代码");
    setStatus("代码模式自动已开启", "#0a0");
    return true;
  }

  function codeStopWatch() {
    if (CODE.timer) { clearTimeout(CODE.timer); CODE.timer = null; }
    var list = CODE.watchers || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].disconnect(); } catch (e) { /* 忽略 */ }
    }
    CODE.watchers = [];
    if (!CODE.watching) return;
    CODE.watching = false;
    log("已停止代码模式自动填充");
    setStatus("代码模式自动已停止", "#888");
  }
  var CODE_SYSTEM_PROMPT = [
    "你是 Java 编程助手，需要根据关卡任务写出能通过编译与判定的完整代码。",
    "",
    "【最重要的一条】",
    "编辑器里给的骨架含有 /* TODO */ 之类的占位注释，它们只是提示，「不是代码」。",
    "你必须把它们替换成真实的值或语句。绝对不允许把 /* TODO */ 原样留在提交的代码里，",
    "那会导致 illegal start of expression 编译错误。",
    "例如：int moveCount = /* TODO */;  →  int moveCount = 4;",
    "",
    "要求：",
    "1. 输出能直接编译的完整 Java 代码，所有占位符都要落实成具体值。",
    "2. 只能使用「可用 API」里列出的方法，不要编造不存在的方法名。",
    "3. 保持骨架的结构与变量名：外层（如 public class Main / main 方法）原样保留，",
    "   只在骨架里填内容；不要重写类名、方法签名，不要加新的 import。",
    "4. 代码必须放在 JSON 的 code 字段里，换行写 \\n 转义。",
    "5. 只输出 JSON，不要输出解释性文字，不要用 Markdown 代码块包裹。",
    "",
    "输出格式（严格遵守）：",
    "{\"code\":\"完整代码\",\"explain\":\"一句话思路\"}"
  ].join(String.fromCharCode(10));

  function callModelForCode(goal, currentCode, apiText, rules) {
    var NL = String.fromCharCode(10);
    var parts = [];
    parts.push("【关卡任务】");
    parts.push(goal);
    if (apiText) { parts.push(""); parts.push("【可用 API】"); parts.push(apiText); }
    if (rules) { parts.push(""); parts.push("【平台限制（必须遵守，否则判定失败）】"); parts.push(rules); }
    if (currentCode) {
      parts.push("");
      parts.push("【编辑器里的当前代码（骨架，含 /* TODO */ 占位，请补全后整段返回）】");
      parts.push(currentCode);
      if (/TODO/.test(currentCode)) {
        parts.push("");
        parts.push("注意：上面的 /* TODO */ 必须在结果里换成真实值，不要保留。");
      }
    }
    if (CONFIG.instructions) {
      parts.push("");
      parts.push("【额外要求】");
      parts.push(String(CONFIG.instructions));
    }
    parts.push("");
    parts.push("请输出 JSON。");
    return callModelRaw(CODE_SYSTEM_PROMPT, parts.join(NL));
  }
  /* ---------- 按「内容」找最新题目（不依赖 DOM 层级） ----------
     结构驱动的做法（先找"消息列表"那一层，再取最后一条）在真实平台上很不稳：
     消息区可能虚拟滚动、只渲染可视项、或把新旧消息放在不同容器里，
     于是常常"只识别到 1 条"，而且还是已经答过的旧题。
     这里改为纯内容驱动：扫描所有文本块，挑出「像题目且不是批改反馈」的最后一条。 */

  /* ---------- 答题记录 ----------
     不只记 hash，还记下题面、答案、时间、状态，方便在面板里查看与导出。
     状态：answered=已作答 / skipped=模型判断无需作答 / failed=出错未发送

     记录会**持久化**到 Tampermonkey 存储（无 GM 时退化为 localStorage），
     关闭浏览器、刷新页面后依然保留。 */

  var handledHashes = Object.create(null);   // hash -> 记录对象
  var ANSWER_LOG = [];                        // 按时间顺序的完整记录
  var ANSWER_LOG_STORE_KEY = 'answerLog';
  var ANSWER_LOG_MAX = 500;                   // 持久化上限，避免存储无限膨胀

  function loadAnswerLog() {
    try {
      var raw = Store.get(ANSWER_LOG_STORE_KEY);
      if (!raw || typeof raw !== 'object' || !raw.length) return;
      ANSWER_LOG = raw.filter(function (r) {
        return r && typeof r === 'object' && r.hash && r.time;
      });
      handledHashes = Object.create(null);
      for (var i = 0; i < ANSWER_LOG.length; i++) {
        var rec = ANSWER_LOG[i];
        // 只有「已作答/跳过」的才进 handledHashes；失败记录不阻止重试
        if (rec.status !== 'failed') handledHashes[rec.hash] = rec;
      }
    } catch (e) { /* 存储损坏时忽略，避免影响主流程 */ }
  }

  function saveAnswerLog() {
    try {
      var slim = ANSWER_LOG.slice(-ANSWER_LOG_MAX).map(function (r) {
        return {
          hash: r.hash,
          time: r.time,
          // 题面太长会撑爆存储，截断保存；完整内容仍可在导出时看到近期记录
          text: String(r.text || '').slice(0, 240),
          answer: String(r.answer || '').slice(0, 200),
          status: r.status,
          confidence: r.confidence,
          reason: String(r.reason || '').slice(0, 160),
          count: r.count || 1
        };
      });
      Store.set(ANSWER_LOG_STORE_KEY, slim);
    } catch (e) { /* 存储不可用时静默失败，不影响答题 */ }
  }

  function markHandled(text, extra) {
    var h = hashText(text);
    var info = extra || {};
    var prev = handledHashes[h];
    var record = {
      hash: h,
      time: Date.now(),
      text: String(text || ''),
      answer: info.answer === undefined ? '' : String(info.answer),
      status: info.status || 'answered',
      confidence: info.confidence === undefined ? null : info.confidence,
      reason: info.reason || '',
      // 记录这道题历史上出现过几次（含本次）
      count: prev && prev.count ? prev.count + 1 : 2,
      firstSeen: prev && prev.firstSeen ? prev.firstSeen : Date.now()
    };
    handledHashes[h] = record;

    // 同一题重复登记则覆盖（保留出现次数），不重复追加
    var existing = -1;
    for (var i = 0; i < ANSWER_LOG.length; i++) {
      if (ANSWER_LOG[i].hash === h) { existing = i; break; }
    }
    if (existing >= 0) ANSWER_LOG[existing] = record;
    else ANSWER_LOG.push(record);

    if (ANSWER_LOG.length > ANSWER_LOG_MAX + 100) {
      ANSWER_LOG = ANSWER_LOG.slice(-ANSWER_LOG_MAX);
    }
    saveAnswerLog();
    refreshAnswerLogView();
    return h;
  }

  function isHandled(text) {
    return !!handledHashes[hashText(text)];
  }

  // 失败记录：只用于展示，不阻止后续重试
  function addFailureRecord(text, reason) {
    var h = 'fail:' + hashText(String(text || '')) + ':' + Date.now();
    ANSWER_LOG.push({
      hash: h,
      time: Date.now(),
      text: String(text || ''),
      answer: '',
      status: 'failed',
      confidence: null,
      reason: String(reason || '').slice(0, 120)
    });
    if (ANSWER_LOG.length > ANSWER_LOG_MAX + 100) {
      ANSWER_LOG = ANSWER_LOG.slice(-ANSWER_LOG_MAX);
    }
    saveAnswerLog();
    refreshAnswerLogView();
  }

  function clearAnswerLog() {
    handledHashes = Object.create(null);
    ANSWER_LOG = [];
    saveAnswerLog();
    refreshAnswerLogView();
  }

  // 把题面压成一行便于列表显示
  function shortTitle(text, limit) {
    var t = clean(text).replace(/\s+/g, ' ');
    // 去掉常见的知识点前缀，让题面更醒目
    t = t.replace(/^考查知识点[:：][^【]*/, '').trim();
    var max = limit || 46;
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  var ANSWER_LOG_BOX = null;

  function refreshAnswerLogView() {
    if (!ANSWER_LOG_BOX) return;
    if (!ANSWER_LOG.length) {
      ANSWER_LOG_BOX.textContent = '（还没有作答记录）';
      return;
    }
    var lines = [];
    for (var i = ANSWER_LOG.length - 1; i >= 0; i--) {
      var r = ANSWER_LOG[i];
      var stamp = new Date(r.time).toTimeString().slice(0, 8);
      var mark = r.status === 'answered' ? '✔' : (r.status === 'skipped' ? '○' : '✗');
      var tail = r.status === 'answered'
        ? ('→ ' + (r.answer || '').slice(0, 24))
        : (r.status === 'skipped' ? '→ 无需作答' : '→ 出错未发送');
      var times = (r.count && r.count > 1) ? ('  ⟲ 第 ' + r.count + ' 次出现') : '';
      lines.push(mark + ' [' + stamp + '] ' + shortTitle(r.text) + times + '\n      ' + tail);
    }
    ANSWER_LOG_BOX.textContent = lines.join('\n') + '\n\n共 ' + ANSWER_LOG.length + ' 条记录';
    ANSWER_LOG_BOX.scrollTop = 0;
  }

  // 收集「最内层的文本块」：带位置，按文档顺序
  function collectTextBlocks() {
    var out = [];
    var docs = allDocs();
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d].doc;
      var scope = doc.body;
      if (!scope) continue;
      var all;
      try {
        all = scope.querySelectorAll('div,p,span,li,section,article,td,pre,blockquote');
      } catch (e) { continue; }
      for (var i = 0; i < all.length && i < 6000; i++) {
        var el = all[i];
        if (isOwnUI(el) || isControlEl(el)) continue;
        // Monaco 编辑器、逐行执行视图、可用 API 面板里的文本都不是题目
        if (inCodeArea(el)) continue;
        // 只取「直接含文字」的块，避免父容器把整段会话重复算进来
        var direct = '';
        for (var c = 0; c < el.childNodes.length; c++) {
          if (el.childNodes[c].nodeType === 3) direct += el.childNodes[c].nodeValue;
        }
        var text = clean(el.textContent);
        if (text.length < 8) continue;
        var r;
        try { r = absoluteRect(el); } catch (e2) { continue; }
        if (!r.width || !r.height) continue;
        out.push({ el: el, text: text, hasDirect: clean(direct).length > 0, top: r.top, left: r.left });
      }
    }
    return out;
  }


  // 找最新的一道待答题目（手动「回答最新一条」用）
  function findLatestPendingQuestion(force) {
    var blocks = collectTextBlocks();

    // 先只保留「像题目、且不像批改反馈」的块
    var qs = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!looksLikeQuestion(b.text)) continue;
      if (looksLikeFeedback(b.text) && !/[\u3010]/.test(b.text)) continue;
      qs.push(b);
    }
    if (!qs.length) return { text: '', reason: '没有找到像题目的内容' };

    // 去掉互相包含的重复（父容器会把子块的文字重复算一遍），保留最内层
    var inner = [];
    for (var a = 0; a < qs.length; a++) {
      var isAncestor = false;
      for (var b2 = 0; b2 < qs.length; b2++) {
        if (a === b2) continue;
        if (qs[a].el.contains(qs[b2].el)) { isAncestor = true; break; }
      }
      if (!isAncestor) inner.push(qs[a]);
    }
    if (!inner.length) inner = qs;

    // 按位置从上到下排序，最后一条 = 最新的一道题
    inner.sort(function (p, q) { return (p.top - q.top) || (p.left - q.left); });

    // 只看「最新那一道」，不回退到更早的题。
    // 注意：这里**不**因为「答过」就拒绝 —— 记录归记录，是否作答由调用方决定。
    var latest = inner[inner.length - 1];
    if (!latest) return { text: '', reason: '没有找到题目' };
    var prev = handledHashes[hashText(latest.text)];
    return {
      text: latest.text,
      reason: prev ? '页面中最新的一道题（此前已答过）' : '页面中最新的一道题',
      previouslyAnswered: !!prev,
      previousRecord: prev || null
    };
  }

  /* ---------- 判断一条消息是「题目」还是「批改反馈」 ----------
     批改反馈长这样：
       你的回答是：a正确答案：A你的答题结果是：回答正确本题得分：2错因分析：无反馈：…
     它绝不是要回答的对象。此前只按「最后一条对方消息」来选，就会选到它。 */

  var FEEDBACK_MARK = /(你的回答是|正确答案[:：]|你的答题结果|本题得分|错因分析|^s*反馈[:：]|回答正确|回答错误|答案解析[:：]|你的得分)/;

  // 编程关卡里的代码骨架、API 列表、执行日志都带这些特征。
  // 它们很容易被误判成「填空题」（`int moveCount` 这类行会被当成题面），
  // 结果整段代码被当答案发给模型，还占掉表单模式。这里统一排除。
  var CODE_SMELL = new RegExp(
    '(int|double|boolean|String|void|for|while|if|else|return)\\s*\\(' +
    '|;\\s*($|\\n)' +
    '|\\{\\s*(//|$)' +
    '|//\\s*(TODO|设置|前进)' +
    '|/\\*.*\\*/' +
    '|me\\.\\w+\\s*\\(' +
    '|(int|double|boolean)\\s+\\w+\\s*[=;]' +
    '|error:|cannot find symbol'
  );

  function looksLikeCode(text) {
    if (!text) return false;
    var t = String(text);
    if (t.length > 600) return true;                 // 超长文本基本不可能是题目
    // 关键：单个 "int a = 7" 这种出现在正常选择题里的片段不能算代码，
    // 必须凑齐多个结构性特征（分号/花括号/注释/方法调用）才判为代码。
    var signals = 0;
    if (/;\s*(\/\/.*)?$/m.test(t)) signals++;            // 行尾分号
    if (/\{/.test(t) && /\}/.test(t)) signals++;           // 成对花括号
    if (/\/\/|\/\*/.test(t)) signals++;                    // 注释
    if (/\bme\.\w+\s*\(/.test(t)) signals++;              // 关卡 API 调用
    if (/\b(for|while|if)\s*\(/.test(t) && /[;{}]/.test(t)) signals++;  // 语句块
    if (/error:/.test(t)) signals += 2;                      // 编译报错
    return signals >= 2;
  }

  function inCodeArea(el) {
    var n = el;
    for (var i = 0; n && i < 8; i++) {
      var cls = String(n.className || '');
      if (/(monaco|code-trace|trace-line|api-panel|editor-panel|code-column|story-panel|result-panel|game-info|editor-value)/i.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }

  // 题目通常带有这些标记
  var QUESTION_MARK = new RegExp(
    '(\\u3010(\\u5355\\u9009|\\u591A\\u9009|\\u5224\\u65AD|\\u586B\\u7A7A|\\u7B80\\u7B54|\\u95EE\\u7B54)\\u9898\\u3011' +   // 【单选题】
    '|\\u7b2c\\s*[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341\\d]{1,4}\\s*\\u9898' +  // 第N题
    '|^\\s*\\d{1,3}\\s*[.\\u3001\\uFF0E)\\uFF09]' +                        // 1. / 1、
    ')');

  // 选项行：A: / A. / A、 / A） 至少两个才认为是在列选项
  var OPTION_LINE = new RegExp(
    '(^|[\\s\\u3000])' +                 // 行首或空白
    '([A-Da-d])\\s*' +                    // 选项字母
    '[.\\u3001\\uFF0E:\\uFF1A)\\uFF09]' +   // 分隔符 . 、 ． : ： ) ）
    '\\s*\\S', 'g');

  function looksLikeFeedback(text) {
    if (!text) return false;
    return FEEDBACK_MARK.test(text);
  }

  function looksLikeQuestion(text) {
    if (!text) return false;
    var t = String(text).trim();
    if (t.length < 6) return false;
    // 代码骨架 / API 列表 / 执行日志不是题目
    if (looksLikeCode(t)) return false;
    // 含有题型标记或题号 → 是题目
    if (QUESTION_MARK.test(t)) return true;
    // 统计选项行数量：≥2 个（如 A: … B: …）→ 是题目
    var opts = t.match(OPTION_LINE);
    if (opts && opts.length >= 2) return true;
    // 以问号结尾且有一定长度 → 是题目
    if (/[？?]s*$/.test(t) && t.length >= 8) return true;
    return false;
  }

  // 从消息列表里挑出「待回答的那一道题」
  function pickPendingQuestion(messages) {
    // 1) 首选：最后一条「看起来是题目」的消息（不限制谁发的 ——
    //    用户自己的回答（如 "a"、"A"）不会像题目，所以这样更稳）
    for (var i = messages.length - 1; i >= 0; i--) {
      if (looksLikeQuestion(messages[i].text)) {
        return { msg: messages[i], index: i, why: '含题目标记' };
      }
    }
    // 2) 退化：最后一条「对方发的、且不像批改反馈」的消息
    for (var j = messages.length - 1; j >= 0; j--) {
      if (!messages[j].self && !looksLikeFeedback(messages[j].text)) {
        return { msg: messages[j], index: j, why: '对方消息（非反馈）' };
      }
    }
    // 3) 都不满足：如果最后一条只是反馈，明确报告"没有待答题目"
    for (var k = messages.length - 1; k >= 0; k--) {
      if (looksLikeFeedback(messages[k].text)) {
        return { msg: null, index: -1, why: '最后一条是批改反馈，没有待答题目' };
      }
    }
    return { msg: null, index: -1, why: '没有找到可作答的题目' };
  }

  function hashText(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  /* --- 回答最新一条「对方」消息 --- */
  // 一次作答允许的最长时间。超过就强制释放 busy ——
  // 否则一旦某次请求挂住（网络卡顿、接口不返回），busy 会永久为 true，
  // 之后所有题目都被「正在处理上一条消息」挡掉，表现为自动应答莫名中断。
  var ANSWER_TIMEOUT_MS = 90000;

  function chatAnswerLatest(force) {
    // 编程关卡里没有「聊天题目」，走代码模式。否则会把代码骨架当填空题发出去。
    if (findMonacoRoot() && readCodeTask().goal) {
      log('检测到编程关卡，改走代码模式', 'warn');
      return codeDoTask(force);
    }
    if (CHAT.busy) {
      var held = Date.now() - (CHAT.busySince || 0);
      if (held < ANSWER_TIMEOUT_MS) {
        log('正在处理上一条消息…（已 ' + Math.round(held / 1000) + 's）');
        CHAT.pendingAgain = true;      // 记下来：空了之后立刻补一次
        return Promise.resolve(null);
      }
      log('上一次作答卡住超过 ' + Math.round(ANSWER_TIMEOUT_MS / 1000) + 's，强制恢复', 'error');
      CHAT.busy = false;
    }
    if (!CONFIG.baseUrl || !CONFIG.model) {
      log('请先在「设置」里填写 Base URL 和模型名', 'error');
      return Promise.resolve(null);
    }
    if (!ensureChatTargets(true)) {
      log('没能识别出消息区域或输入框，请点「指定消息区域」手动选择。', 'error');
      return Promise.resolve(null);
    }

    // 内容驱动：每次只处理**最新的一道题**（平台每次只出一道）。
    // findLatestPendingQuestion 内部已排除「批改反馈」和「已作答过的题」。
    var byContent = findLatestPendingQuestion(force);
    var targetText = byContent.text;
    var how = byContent.reason;

    // 内容驱动失败时，退回结构驱动（消息列表）
    if (!targetText) {
      var messages = extractMessages();
      var picked = pickPendingQuestion(messages);
      if (picked.msg) {
        targetText = picked.msg.text;
        how = picked.why + '（消息列表）';
      }
    }

    if (!targetText) {
      log('没有待回答的题目：' + how, 'error');
      setStatus('没有待答题目', '#888');
      return Promise.resolve(null);
    }

    var target = { text: targetText };
    var hash = hashText(target.text);

    // 只拦「同一条消息刚处理完又立刻被触发」这种抖动，
    // 不拦「这道题以前答过」—— 那种情况照常作答，并在记录里体现。
    if (!force && hash === CHAT.lastHash) {
      var since = Date.now() - (CHAT.lastHandledAt || 0);
      if (since < 3000) {
        return Promise.resolve(null);     // 3 秒内的同一题重复触发，忽略
      }
    }
    CHAT.pendingAgain = false;

    CHAT.busy = true;
    CHAT.busySince = Date.now();
    setStatus('请求 AI 作答…', '#666');

    // 明确告知这道题是否出现过，以及当时的答案
    var prevRec = handledHashes[hash];
    if (prevRec) {
      log('⚠ 这道题以前出现过（本次是第 ' + ((prevRec.count || 1) + 1) + ' 次），上次答案：' +
          (prevRec.answer || '(无)') +
          '，时间：' + new Date(prevRec.time).toLocaleString());
    }
    log('最新题面（' + target.text.length + ' 字）：「' + target.text.replace(/\n/g, ' ').slice(0, 80) + '」');

    var started = Date.now();
    return callModelForChat(target.text).then(function (raw) {
      var data = parseLooseJson(raw);
      if (data.skip) {
        log('模型判断这条无需作答，已跳过');
        CHAT.lastHash = hash;
        CHAT.lastHandledAt = Date.now();
        markHandled(target.text, { status: 'skipped', reason: data.reason || '' });
        setStatus('已跳过（无需作答）', '#888');
        return { skipped: true };
      }
      var answer = String(data.answer === undefined ? '' : data.answer).trim();
      if (!answer) {
        log('模型没有给出可发送的答案', 'error');
        markHandled(target.text, { status: 'failed', reason: '模型未给出答案' });
        setStatus('模型未给出答案', '#e33');
        return null;
      }
      log('AI 答案（' + ((Date.now() - started) / 1000).toFixed(1) + 's）：' +
          answer.replace(/\n/g, ' ').slice(0, 100));

      var typed = typeIntoChatInput(CHAT.inputEl, answer);
      if (!typed) {
        log('答案没能写入输入框，请点「指定输入框」重新选择。', 'error');
        setStatus('写入输入框失败', '#e33');
        return null;
      }
      return new Promise(function (resolve) {
        setTimeout(function () {
          var sentHow = sendChatInput(CHAT.inputEl);
          CHAT.lastHash = hash;
          CHAT.lastHandledAt = Date.now();
          markHandled(target.text, {     // 登记为已作答，并留下可查记录
            status: 'answered',
            answer: answer,
            confidence: data.confidence,
            reason: data.reason || ''
          });
          CHAT.timeouts = 0;         // 成功即重置超时计数
          CHAT.retryAfter = 0;
          log('已发送（方式：' + (sentHow === 'button' ? '点击发送按钮' : '回车键') + '）');
          setStatus('已回复 1 条', '#0a0');
          resolve({ sent: true, answer: answer });
        }, 350);
      });
    }).catch(function (err) {
      log('出错: ' + err.message + '（不登记为已答，稍后会自动重试）', 'error');
      setStatus('出错，稍后重试', '#e33');
      // 关键：出错时**不**进 handledHashes，让监听器下一轮能重新处理这道题。
      // 但要留一条失败记录，方便回看哪些题没答上。
      addFailureRecord(target.text, err.message);
      CHAT.failures = (CHAT.failures || 0) + 1;
      return null;
    }).then(function (value) {
      CHAT.busy = false;
      CHAT.busySince = 0;
      // 处理期间又来了新题 → 立刻补一次，避免「只答了最后一道」
      if (CHAT.pendingAgain) {
        CHAT.pendingAgain = false;
        setTimeout(function () {
          if (CHAT.watching) chatAnswerLatest(false);
        }, 260);
      }
      return value;
    });
  }

  /* --- 自动应答：监听新内容 ---
     注意：不能只监听「消息列表」那个节点。真实页面上新消息可能渲染到别的容器里，
     而且我们识别的列表节点也未必永远正确 —— 只盯一个节点会导致「开了自动应答却毫无反应」。
     这里改为监听所有同源文档的 body，任何变化都轮询式地重新判断「有没有新的待答题目」。 */
  var WATCHERS = [];

  function chatStartWatch() {
    // 输入框是刚需；消息列表容错（内容驱动不依赖它）
    if (!CHAT.inputEl || !CHAT.inputEl.isConnected) {
      if (!ensureChatTargets(true) || !CHAT.inputEl) {
        log('没能找到输入框，请先点「指定输入框」。', 'error');
        return false;
      }
    }
    chatStopWatch(true);   // 先清掉旧的监听，避免重复

    var pending = null;
    function onAnyChange() {
      if (pending) clearTimeout(pending);
      pending = setTimeout(function () {
        if (!CHAT.watching) return;
        // 若正忙，chatAnswerLatest 内部会记下 pendingAgain，忙完自动补一次
        chatAnswerLatest(false);
      }, Math.max(400, Number(CONFIG.chatCooldownMs) || 1500));
    }

    // 在所有同源文档上装监听（含 iframe）
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var body = docs[i].doc.body;
      if (!body) continue;
      var obs = null;
      try {
        var win = docs[i].doc.defaultView || window;
        obs = new win.MutationObserver(onAnyChange);
        obs.observe(body, { childList: true, subtree: true, characterData: true });
      } catch (e) { obs = null; }
      if (obs) WATCHERS.push(obs);
    }
    if (!WATCHERS.length) {
      log('没能挂上任何监听（页面结构异常）。', 'error');
      return false;
    }

    CHAT.watching = true;
    CHAT.failures = 0;
    CHAT.pendingAgain = false;
    CHAT.timeouts = 0;
    CHAT.retryAfter = 0;
    startWatchdog();
    saveConfig({ chatAutoReply: true });
    log('已开启自动应答：监听 ' + WATCHERS.length + ' 个文档，出现新题目即自动作答');
    setStatus('自动应答已开启', '#0a0');
    // 立即检查一次：可能开启时页面上就已经有待答题目
    onAnyChange();
    return true;
  }

  // 看门狗：即使页面再无任何变化，也能发现「busy 卡死」并自恢复。
  // 没有它的话，一次挂住的请求就会让自动应答永久停止响应。
  function startWatchdog() {
    stopWatchdog();
    CHAT.watchdog = setInterval(function () {
      if (!CHAT.watching) { stopWatchdog(); return; }
      if (!CHAT.busy) {
        // 空闲时也顺手检查一次：可能之前的变化被合并/错过了
        if (CHAT.retryAfter && Date.now() < CHAT.retryAfter) return;   // 退避中
        CHAT.retryAfter = 0;
        chatAnswerLatest(false);
        return;
      }
      var held = Date.now() - (CHAT.busySince || 0);
      if (held > ANSWER_TIMEOUT_MS) {
        CHAT.busy = false;
        CHAT.busySince = 0;
        CHAT.timeouts = (CHAT.timeouts || 0) + 1;
        // 同一道题反复超时说明接口/网络有问题，重试要退避，别把浏览器打死
        CHAT.retryAfter = Date.now() + Math.min(60000, 3000 * CHAT.timeouts);
        if (CHAT.timeouts >= 5) {
          log('看门狗：连续 ' + CHAT.timeouts + ' 次作答超时，暂停 60 秒后重试', 'error');
          setStatus('接口多次超时，暂停重试', '#e33');
        } else {
          log('看门狗：作答卡住 ' + Math.round(held / 1000) + 's，已恢复（第 ' +
              CHAT.timeouts + ' 次）', 'error');
          setStatus('上次作答超时，已恢复', '#e80');
        }
      }
    }, Number(CONFIG.watchdogIntervalMs) || 5000);
  }

  function stopWatchdog() {
    if (CHAT.watchdog) {
      clearInterval(CHAT.watchdog);
      CHAT.watchdog = null;
    }
  }

  function chatStopWatch(quiet) {
    stopWatchdog();
    for (var i = 0; i < WATCHERS.length; i++) {
      try { WATCHERS[i].disconnect(); } catch (e) { /* 忽略 */ }
    }
    WATCHERS = [];
    if (CHAT.observer) { try { CHAT.observer.disconnect(); } catch (e) { } CHAT.observer = null; }
    CHAT.watching = false;
    if (!quiet) {
      saveConfig({ chatAutoReply: false });
      log('已停止自动应答');
      setStatus('自动应答已停止', '#888');
    }
  }

  function toggleChatWatch() {
    if (CHAT.watching) chatStopWatch();
    else chatStartWatch();
  }

  /* ------------------------------------------------------------ 区域模式 / 点击学习 */
  // 当「自动猜 DOM」不灵时，用这两条不依赖结构的路子：
  //   1) 点击学习：点一下任意一条消息气泡，据此推断整个消息列表（记住它的"长相"）
  //   2) 框选区域：拖一个矩形框住题目区，纯按几何位置取文字 —— 对任何 DOM 都成立
  // 另外脚本现在会在所有 frame 里运行（含 iframe），所以对话区在 iframe 里也能工作。

  var REGION = { rect: null, lastText: '', watching: false, observer: null, timer: null };
  var LEARN = { sig: null, count: 0 };

  function intersects(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function signatureOf(el) {
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName + (cls ? '.' + cls : '');
  }

  /* ---------- 方法一：点击学习 ---------- */
  // 用户点一下任意一条消息，我们从它往上找「有多个同类兄弟」的那一层。
  // 比全页猜测精确得多，而且能记住消息的"长相"，之后只认这类节点。
  function learnListFrom(node) {
    var cur = node;
    for (var up = 0; up < 8 && cur && cur.parentElement; up++) {
      var parent = cur.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      var sig = signatureOf(cur);
      var similar = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (signatureOf(parent.children[i]) === sig) similar++;
      }
      if (similar >= 2) {
        return { parent: parent, sig: sig, count: similar };
      }
      cur = parent;
    }
    // 退一步：至少把它自己所在的那一层当消息区
    if (node.parentElement) {
      return { parent: node.parentElement, sig: signatureOf(node), count: 1 };
    }
    return null;
  }

  function learnFromClick() {
    log('请点击任意一条「对方发来的消息气泡」（按 Esc 取消）…');
    var tip = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;' +
             'background:#2f6fed;color:#fff;padding:9px 16px;border-radius:8px;' +
             'font:13px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;',
      text: '点击任意一条消息气泡（按 Esc 取消）'
    }, []);
    document.body.appendChild(tip);

    function cleanup() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
    }
    function onClick(e) {
      var t = e.target;
      if (t && t.closest && t.closest('[data-quizbot-ui]')) return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      var learned = learnListFrom(t);
      if (!learned) {
        log('没能从你点击的位置推断出消息列表，请改用「框选题目区域」', 'error');
        return;
      }
      CHAT.listEl = learned.parent;
      LEARN.sig = learned.sig;
      LEARN.count = learned.count;
      saveConfig({ chatListSelector: cssPathOf(learned.parent) });

      var msgs = extractMessages();
      log('已学习：消息容器 ' + cssPathOf(learned.parent).slice(0, 60));
      log('识别到 ' + msgs.length + ' 条消息，其中同类节点 ' + learned.count + ' 个');
      msgs.forEach(function (m, i) {
        log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' +
            m.text.replace(/\n/g, ' ').slice(0, 70));
      });
      if (!msgs.length) log('容器选对了但没解析出消息，请改用「框选题目区域」', 'error');
      setStatus(msgs.length ? ('已学习，识别到 ' + msgs.length + ' 条') : '已学习但未解析出消息',
                msgs.length ? '#0a0' : '#e80');
    }
    function onKey(e) {
      if (e.key === 'Escape') { cleanup(); log('已取消学习'); }
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  /* ---------- 方法二：框选区域 ---------- */
  // 完全按几何位置取文字，不看任何 class / 层级。
  // 只要文字是真实 DOM 文本（不是 canvas 画出来的），就一定能读到。
  function pickRect(onDone) {
    var mask = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483645;' +
             'cursor:crosshair;background:rgba(20,30,50,.28);'
    }, []);
    var box = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;border:2px solid #2f6fed;background:rgba(47,111,237,.18);' +
             'z-index:2147483646;pointer-events:none;display:none;border-radius:2px;'
    }, []);
    var tip = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;' +
             'background:#2f6fed;color:#fff;padding:9px 16px;border-radius:8px;' +
             'font:13px/1.5 "Microsoft YaHei",sans-serif;pointer-events:none;',
      text: '按住左键拖出一个框，框住题目/消息文字；按 Esc 取消'
    }, []);
    document.body.appendChild(mask);
    document.body.appendChild(box);
    document.body.appendChild(tip);

    var sx = 0, sy = 0, dragging = false;
    function onDown(e) {
      dragging = true; sx = e.clientX; sy = e.clientY;
      box.style.display = 'block';
      box.style.left = sx + 'px'; box.style.top = sy + 'px';
      box.style.width = '0px'; box.style.height = '0px';
      e.preventDefault(); e.stopPropagation();
    }
    function onMove(e) {
      if (!dragging) return;
      box.style.left = Math.min(sx, e.clientX) + 'px';
      box.style.top = Math.min(sy, e.clientY) + 'px';
      box.style.width = Math.abs(e.clientX - sx) + 'px';
      box.style.height = Math.abs(e.clientY - sy) + 'px';
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      var rect = { left: Math.min(sx, e.clientX), top: Math.min(sy, e.clientY),
                   width: Math.abs(e.clientX - sx), height: Math.abs(e.clientY - sy),
                   right: 0, bottom: 0 };
      rect.right = rect.left + rect.width;
      rect.bottom = rect.top + rect.height;
      cleanup();
      if (rect.width < 40 || rect.height < 30) { log('框选太小，已取消', 'error'); return; }
      onDone(rect);
    }
    function onKey(e) { if (e.key === 'Escape') { cleanup(); log('已取消框选'); } }
    function cleanup() {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('keydown', onKey, true);
      [mask, box, tip].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('keydown', onKey, true);
  }

  // 读取元素的文字，但剥掉其中「交互控件」子树的文案。
  // 否则一个包着输入框+发送按钮的容器，会把「发送」当成题目内容读进来。
  function textExcludingControls(node) {
    var hasControl = node.querySelector &&
      node.querySelector('button,input,textarea,select,option,[role="button"],[contenteditable="true"]');
    if (!hasControl) return clean(node.textContent);
    var clone = node.cloneNode(true);
    var drop = clone.querySelectorAll
      ? clone.querySelectorAll('button,input,textarea,select,option,[role="button"],[contenteditable="true"]')
      : [];
    for (var i = 0; i < drop.length; i++) {
      if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    }
    return clean(clone.textContent);
  }

  // 取区域内的文字。
  //
  // 这里刻意「不做全页扫描」——旧实现遍历页面上所有 div/span 再按矩形筛，
  // 既慢又会在扫到 8000 个节点时提前退出，导致排在页面后部的聊天区永远读不到。
  //
  // 改为「网格采样」：在框内按固定步长打点，用 elementFromPoint 直接命中该点的元素，
  // 再向上找到承载文字的最小块。命中多少就处理多少，与页面总规模无关。
  var TEXT_BLOCK_TAGS = /^(DIV|P|SPAN|LI|TD|TH|H1|H2|H3|H4|H5|H6|PRE|CODE|ARTICLE|SECTION|LABEL|BLOCKQUOTE|DD|DT|FIGCAPTION)$/;

  function isControlEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (/^(BUTTON|INPUT|TEXTAREA|SELECT|OPTION|SCRIPT|STYLE|SVG|PATH|NOSCRIPT|IFRAME)$/.test(el.tagName)) return true;
    if (el.closest && el.closest('button,input,textarea,select,option,[role="button"],[contenteditable="true"]')) return true;
    return false;
  }

  // 从命中的最内层元素往上找，取「承载文字的最小块」
  function blockFor(el) {
    var node = el;
    var best = null;
    for (var up = 0; up < 6 && node && node !== document.body; up++) {
      if (!isControlEl(node) && TEXT_BLOCK_TAGS.test(node.tagName) && clean(node.textContent)) {
        best = node;
        // 一旦这一层已经包含明显多的文字，就说明再往上会吞掉别人的内容
        if (clean(node.textContent).length > 12) break;
      }
      node = node.parentElement;
    }
    return best;
  }

  function textInRegion(docRect) {
    var rect = docToViewport(docRect);   // getBoundingClientRect 返回的是视口坐标
    beginLayoutFrame();
    try {
      var vw = window.innerWidth || 1024;
      var vh = window.innerHeight || 768;

      // 只在「框 ∩ 视口」范围内采样：视口外的东西本来也看不见
      var x0 = Math.max(0, Math.ceil(rect.left));
      var y0 = Math.max(0, Math.ceil(rect.top));
      var x1 = Math.min(vw - 1, Math.floor(rect.left + rect.width));
      var y1 = Math.min(vh - 1, Math.floor(rect.top + rect.height));
      if (x1 <= x0 || y1 <= y0) return '';

      var w = x1 - x0, h = y1 - y0;
      // 步长自适应：保持采样点数量在可控范围（最多约 1600 个点），
      // 同时足够密以命中每一行文字。
      var step = Math.max(8, Math.ceil(Math.max(w, h) / 40));
      var found = [];
      var seenEl = [];

      function consider(hit) {
        if (!hit || hit.nodeType !== 1) return;
        if (isOwnUI(hit) || isControlEl(hit)) return;
        var block = blockFor(hit);
        if (!block || isOwnUI(block)) return;
        if (seenEl.indexOf(block) >= 0) return;
        seenEl.push(block);
        var text = textExcludingControls(block);
        if (!text) return;
        var r = absoluteRect(block);      // 用顶层坐标，与框选坐标系一致
        found.push({ el: block, t: text, top: r.top, left: r.left });
      }

      // 在「最内层」文档里采样：顶层 elementFromPoint 只会返回 <iframe> 本身，
      // 必须逐层下钻，直到命中的不是 iframe。
      function deepestHitAt(px, py) {
        var docs = allDocs();
        var best = null;
        for (var i = 0; i < docs.length; i++) {
          var dinfo = docs[i];
          if (typeof dinfo.doc.elementFromPoint !== 'function') continue;
          var lx = px - dinfo.dx, ly = py - dinfo.dy;
          var hit = null;
          try { hit = dinfo.doc.elementFromPoint(lx, ly); } catch (e) { hit = null; }
          if (!hit) continue;
          var tag = hit.tagName ? hit.tagName.toLowerCase() : '';
          if (tag !== 'iframe' && tag !== 'frame') return hit;   // 最内层，直接用
          best = best || hit;
        }
        return best;
      }

      for (var y = y0; y <= y1; y += step) {
        for (var x = x0; x <= x1; x += step) {
          consider(deepestHitAt(x, y));
        }
      }

      // 采样没命中（或环境不支持 elementFromPoint）时，退化为「有界扫描」：
      // 只扫描与框相交的候选块。这里不再用固定次数截断，而是走 TreeWalker
      // 且只对「框内的元素」做几何判断，因此与页面总规模基本无关。
      if (!found.length) {
        var docsAll = allDocs();
        for (var di = 0; di < docsAll.length && !found.length; di++) {
          var dinfo = docsAll[di];
          var walker;
          try { walker = dinfo.doc.createTreeWalker(dinfo.doc.body, 1 /* SHOW_ELEMENT */, null); }
          catch (e) { continue; }
          var node;
          var guard = 0;
          while ((node = walker.nextNode())) {
            if (++guard > 200000) break;               // 纯粹防御死循环
            if (node.nodeType !== 1) continue;
            if (!TEXT_BLOCK_TAGS.test(node.tagName)) continue;
            if (isOwnUI(node) || isControlEl(node)) continue;
            var rr = absoluteRect(node);
            if (!rr.width || !rr.height) continue;
            if (!intersects(rr, rect)) continue;
            // 只要「自身直接含文字」的块，避免把整页容器都收集进来
            var direct = '';
            for (var c = 0; c < node.childNodes.length; c++) {
              if (node.childNodes[c].nodeType === 3) direct += node.childNodes[c].nodeValue;
            }
            if (!clean(direct)) continue;
            consider(node);
          }
        }
      }

      // 去掉互相包含的重复项，只留最内层
      var deepest = [];
      for (var a = 0; a < found.length; a++) {
        var isAncestor = false;
        for (var b = 0; b < found.length; b++) {
          if (a === b) continue;
          if (found[a].el.contains(found[b].el)) { isAncestor = true; break; }
        }
        if (!isAncestor) deepest.push(found[a]);
      }

      // 按文档位置从上到下、从左到右排序，恢复阅读顺序
      deepest.sort(function (p, q) { return (p.top - q.top) || (p.left - q.left); });

      var seen = Object.create(null);
      var lines = [];
      for (var k = 0; k < deepest.length; k++) {
        var key = deepest[k].t;
        if (seen[key]) continue;
        seen[key] = 1;
        lines.push(key);
      }
      return clean(lines.join(String.fromCharCode(10)));
    } finally {
      endLayoutFrame();
    }
  }

  // 把视口坐标转成文档坐标存起来，这样页面滚动后框依然有效
  function viewportToDoc(rect) {
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    return { left: rect.left + sx, top: rect.top + sy,
             width: rect.width, height: rect.height,
             right: rect.left + sx + rect.width, bottom: rect.top + sy + rect.height };
  }

  // 文档坐标 → 当前视口坐标
  function docToViewport(rect) {
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    return { left: rect.left - sx, top: rect.top - sy,
             width: rect.width, height: rect.height,
             right: rect.left - sx + rect.width, bottom: rect.top - sy + rect.height };
  }

  function useRegion(rect) {
    REGION.rect = viewportToDoc(rect);
    saveConfig({ regionRect: REGION.rect, regionFrameUrl: location.href });
    rect = docToViewport(REGION.rect);
    var text = textInRegion(rect);
    log('已选定区域 ' + Math.round(rect.width) + 'x' + Math.round(rect.height) +
        '（视口坐标 ' + Math.round(rect.left) + ',' + Math.round(rect.top) + '）');
    log('框内文字 ' + text.length + ' 字：');
    text.split('\n').slice(0, 12).forEach(function (l) {
      log('   | ' + l.replace(/\s+/g, ' ').slice(0, 80));
    });
    if (!text) {
      // 给出可操作的诊断，而不是把用户丢在死胡同
      log('框内没有读到文字，开始诊断…', 'error');
      var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      var vr = docToViewport(REGION.rect);
      log('  视口尺寸 ' + vw + 'x' + vh + '，框选位于视口 ' +
          Math.round(vr.left) + ',' + Math.round(vr.top) + ' 尺寸 ' +
          Math.round(vr.width) + 'x' + Math.round(vr.height));
      var outside = (vr.left + vr.width <= 0) || (vr.top + vr.height <= 0) ||
                    (vr.left >= vw) || (vr.top >= vh);
      if (outside) log('  ⚠ 框选区域当前不在视口内（页面可能滚动过），请重新框选一次。');
      if (typeof document.elementFromPoint !== 'function') {
        log('  ⚠ 本环境不支持 elementFromPoint，已改用有界扫描。');
      }
      // 采样几个点，看看框里到底是什么元素
      if (typeof document.elementFromPoint === 'function') {
        var probes = [
          [vr.left + vr.width / 2, vr.top + vr.height / 2],
          [vr.left + 10, vr.top + 10]
        ];
        probes.forEach(function (p, i) {
          if (p[0] < 0 || p[1] < 0 || p[0] >= vw || p[1] >= vh) return;
          var hitEl = document.elementFromPoint(Math.round(p[0]), Math.round(p[1]));
          if (!hitEl) { log('  采样点' + (i + 1) + ' (' + Math.round(p[0]) + ',' + Math.round(p[1]) + ') → 无元素'); return; }
          log('  采样点' + (i + 1) + ' (' + Math.round(p[0]) + ',' + Math.round(p[1]) + ') → ' +
              hitEl.tagName.toLowerCase() +
              (hitEl.id ? '#' + hitEl.id : '') +
              ' 文字:' + JSON.stringify(clean(hitEl.textContent).slice(0, 30)));
        });
      }
      log('  提示：若持续读不到，请用「点击学习」，或运行 tools/diagnose.js 把结构发给我。');
      setStatus('框内无文字', '#e33');
      return '';
    }
    REGION.lastText = '';
    setStatus('区域已选定（' + text.length + ' 字）', '#0a0');
    return text;
  }

  // 从一段文本里切出「最后一道题」：题目通常以【题型】/数字序号开头。
  // 这样即使把大段历史一起框进来，也只把最后一道题发给模型。
  function latestQuestionSlice(text) {
    if (!text) return text;
    var lines = text.split(String.fromCharCode(10));
    var startIdx = -1;
    // 题目开头的常见写法：
    //   第一题：/ 第2题.  → 第 + 中文数字或阿拉伯数字 + 题
    //   1. / 1、/ 1) / (1) → 阿拉伯数字 + 分隔符
    //   【判断题】/【单选题】 → 方括号题型
    var CN_NUM = '\\u4E00\\u4E8C\\u4E09\\u56DB\\u4E94\\u516D\\u4E03\\u516B\\u4E5D\\u5341\\d';
    var QSTART = new RegExp(
      '^\\s*(' +
      '\\u7B2C\\s*[' + CN_NUM + ']{1,4}\\s*[\\u9898\\u95EE\\uFF1A:.\\u3001]' +
      '|\\d{1,3}\\s*[.\\u3001\\uFF0E)\\uFF09\\]\\u3011\\uFF1A:]' +
      '|\\u3010[^\\u3011]{0,6}\\u9898\\u3011' +
      '|(\\u5355\\u9009|\\u591A\\u9009|\\u5224\\u65AD|\\u586B\\u7A7A|\\u7B80\\u7B54)\\u9898' +
      ')');
    for (var i = lines.length - 1; i >= 0; i--) {
      if (QSTART.test(lines[i])) { startIdx = i; break; }
    }
    if (startIdx < 0) return text;                 // 找不到题目标记就整段发
    var slice = lines.slice(startIdx).join(String.fromCharCode(10)).trim();
    // 切出来太短说明不是真题目，保守起见用原文
    return slice.length >= 8 ? slice : text;
  }

  // 区域模式下回答「最新出现的内容」
  function regionAnswerLatest(force) {
    if (!REGION.rect) {
      log('还没框选区域，请点「框选题目区域」', 'error');
      return Promise.resolve(null);
    }
    if (CHAT.busy) return Promise.resolve(null);
    if (!CONFIG.baseUrl || !CONFIG.model) {
      log('请先在「设置」里填写 Base URL 和模型名', 'error');
      return Promise.resolve(null);
    }
    if (!CHAT.inputEl || !CHAT.inputEl.isConnected) {
      CHAT.inputEl = querySafe(CONFIG.chatInputSelector);
      if (!CHAT.inputEl) {
        var got = detectInputFramed();
        if (got) {
          CHAT.inputEl = got.el;
          saveConfig({ chatInputSelector: cssPathOf(got.el) });
        }
      }
    }
    if (!CHAT.inputEl) {
      log('找不到输入框，请点「指定输入框」', 'error');
      return Promise.resolve(null);
    }

    var text = textInRegion(REGION.rect);
    var prev = REGION.lastText || '';
    var fresh = text;

    if (prev && text === prev && !force) return Promise.resolve(null);
    if (prev && text.indexOf(prev) === 0) {
      // 聊天记录通常是「只追加」的：新增部分就是最新消息
      fresh = text.slice(prev.length).trim();
    }
    if (!fresh) fresh = text;

    if (!force && fresh === prev) return Promise.resolve(null);
    REGION.lastText = text;

    // 追加式文本里可能混着旧内容（比如截断处对不齐），
    // 取最后一段「看起来像一道题」的内容，避免把整段历史都发给模型。
    fresh = latestQuestionSlice(fresh);

    // 若切出来的其实是「批改反馈」，说明当前没有待答题目
    if (looksLikeFeedback(fresh) && !looksLikeQuestion(fresh)) {
      log('框内最新内容是批改反馈，没有待答题目，已跳过');
      setStatus('没有待答题目', '#888');
      return { skipped: true };
    }

    CHAT.busy = true;
    setStatus('请求 AI 作答…', '#666');
    log('新增内容 ' + fresh.length + ' 字：「' + fresh.replace(/\n/g, ' ').slice(0, 80) + '」');

    return callModelForChat(fresh).then(function (raw) {
      var data = parseLooseJson(raw);
      if (data.skip) {
        log('模型判断这条无需作答，已跳过');
        setStatus('已跳过', '#888');
        return { skipped: true };
      }
      var answer = String(data.answer === undefined ? '' : data.answer).trim();
      if (!answer) { log('模型没有给出答案', 'error'); return null; }
      log('AI 答案：「' + answer.replace(/\n/g, ' ').slice(0, 100) + '」');

      var typed = typeIntoChatInput(CHAT.inputEl, answer);
      if (!typed) { log('答案没能写入输入框', 'error'); return null; }
      return new Promise(function (resolve) {
        setTimeout(function () {
          var how = sendChatInput(CHAT.inputEl);
          log('已发送（' + (how === 'button' ? '点击发送按钮' : '回车键') + '）');
          setStatus('已回复 1 条', '#0a0');
          resolve({ sent: true, answer: answer });
        }, 350);
      });
    }).catch(function (err) {
      log('出错: ' + err.message, 'error');
      return null;
    }).then(function (v) {
      CHAT.busy = false;
      return v;
    });
  }

  function regionStartWatch() {
    if (!REGION.rect) { log('请先框选题目区域', 'error'); return false; }
    if (REGION.observer) REGION.observer.disconnect();
    var pending = null;
    REGION.observer = new MutationObserver(function () {
      if (pending) clearTimeout(pending);
      pending = setTimeout(function () {
        if (REGION.watching) regionAnswerLatest(false);
      }, Math.max(500, Number(CONFIG.chatCooldownMs) || 1500));
    });
    REGION.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    REGION.watching = true;
    log('已开启区域模式自动应答');
    setStatus('区域模式自动应答已开启', '#0a0');
    return true;
  }

  function regionStopWatch() {
    if (REGION.observer) { REGION.observer.disconnect(); REGION.observer = null; }
    REGION.watching = false;
    log('已停止区域模式自动应答');
    setStatus('已停止', '#888');
  }

  // 本帧是否值得显示面板：顶层永远显示；子 frame 只有真的含聊天输入控件才显示
  // 只在顶层文档建面板。
  // iframe 里的实例保持沉默 —— 顶层脚本可以直接穿透同源 iframe 操作，
  // 这样就不会出现两个面板，也不会重复工作。
  function shouldShowPanelHere() {
    try { return window.top === window.self; } catch (e) { return true; }
  }

  /* ------------------------------------------------------------ 结构快照导出 */
  // 用途：把页面结构导出成文本，交给作者写针对本网站的精准规则。
  // 做进面板里，就不用往 DevTools 控制台粘贴代码了
  // （Chrome 默认拦截控制台粘贴，需要先输入「允许粘贴」）。

  function snapTag(el) {
    if (!el || el.nodeType !== 1) return '(非元素)';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (typeof el.className === 'string' ? el.className : '').trim();
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 4).join('.');
    return s;
  }

  function snapRect(el) {
    try {
      var r = absoluteRect(el);   // 跨 iframe 时带上偏移，坐标系与框选一致
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    } catch (e) { return '(取不到)'; }
  }

  function snapAncestors(el, maxUp, out) {
    var n = el, i = 0;
    while (n && n.nodeType === 1 && i < (maxUp || 10)) {
      out.push('  '.repeat(i) + snapTag(n) + '  rect=' + snapRect(n) +
               '  textLen=' + clean(n.textContent).length);
      n = n.parentElement;
      i++;
    }
  }

  function clipText(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + ' …[截断,共' + s.length + '字]' : s;
  }

  function buildSnapshotReport() {
    var L = [];
    function add(s) { L.push(s === undefined || s === null ? '' : String(s)); }
    function head(t) { add(''); add('===== ' + t + ' ====='); }

    add('quizbot 结构快照');
    add('时间: ' + new Date().toLocaleString());
    add('版本: v1.4.0');

    head('1. 环境');
    add('URL: ' + location.href);
    add('标题: ' + document.title);
    add('是否顶层窗口: ' + (window.top === window.self));
    add('视口: ' + window.innerWidth + ' x ' + window.innerHeight);
    add('滚动: scrollX=' + (window.scrollX || 0) + ' scrollY=' + (window.scrollY || 0));
    add('文档元素总数: ' + document.querySelectorAll('*').length);
    add('userAgent: ' + navigator.userAgent);

    head('2. iframe');
    var frames = document.querySelectorAll('iframe,frame');
    add('数量: ' + frames.length);
    Array.prototype.forEach.call(frames, function (f, i) {
      var readable = '否';
      try {
        if (f.contentDocument && f.contentDocument.body) {
          readable = '是(' + f.contentDocument.querySelectorAll('*').length + '个元素)';
        }
      } catch (e) { readable = '跨域不可读'; }
      add('#' + i + ' ' + snapTag(f) + ' 可读=' + readable + ' rect=' + snapRect(f));
      add('    src=' + clipText(f.getAttribute('src') || '', 200));
    });

    head('3. 所有候选输入框（含 iframe 内）');
    var inputs = queryAllDocsList(
      'textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]',
      false);
    add('数量: ' + inputs.length);
    Array.prototype.forEach.call(inputs, function (el, i) {
      var r = el.getBoundingClientRect();
      add('#' + i + ' ' + snapTag(el));
      add('    type=' + (el.getAttribute('type') || '-') +
          ' placeholder=' + JSON.stringify(el.getAttribute('placeholder') || '') +
          ' dataPh=' + JSON.stringify(el.getAttribute('data-placeholder') || '') +
          ' ariaLabel=' + JSON.stringify(el.getAttribute('aria-label') || ''));
      add('    contenteditable=' + el.getAttribute('contenteditable') +
          ' isContentEditable=' + el.isContentEditable +
          ' rect=' + snapRect(el) + ' 可见=' + (r.width > 0 && r.height > 0));
      add('    祖先链:');
      snapAncestors(el, 6, L);
    });

    head('4. 候选消息容器（含 iframe 内，按「像不像消息列表」排序）');
    var all = queryAllDocsList('div,section,main,ul,ol,article', false);
    var cands = [];
    Array.prototype.forEach.call(all, function (el, i) {
      if (i > 12000) return;
      if (isOwnUI(el)) return;
      var r = absoluteRect(el);
      if (r.width < 150 || r.height < 80) return;
      var t = clean(el.textContent);
      if (t.length < 20) return;
      cands.push({ el: el, len: t.length, r: r,
                   scroll: el.scrollHeight > el.clientHeight + 10,
                   kids: el.children.length, t: t });
    });

    function chatScore(c) {
      var score = 0;
      var cls = (typeof c.el.className === 'string' ? c.el.className : '');
      var role = String(c.el.getAttribute('role') || '');
      if (role === 'log') score += 200;
      if (c.el.getAttribute('aria-live')) score += 120;
      if (/message|chat|conversation|dialog|bubble|timeline|msg|会话|消息|对话/i.test(cls)) score += 150;
      if (/sidebar|nav|menu|drawer|aside|history|侧边|历史/i.test(cls)) score -= 250;
      if (/^(ASIDE|NAV)$/.test(c.el.tagName)) score -= 250;
      var sigs = {};
      Array.prototype.forEach.call(c.el.children, function (k) {
        var s = snapTag(k).split('.').slice(0, 3).join('.');
        sigs[s] = (sigs[s] || 0) + 1;
      });
      var counts = Object.keys(sigs).map(function (k) { return sigs[k]; });
      var maxc = counts.length ? Math.max.apply(null, counts) : 0;
      score += Math.min(maxc * 8, 120);
      if (c.scroll) score += 40;
      var per = c.kids ? c.len / c.kids : c.len;
      if (per >= 8 && per <= 400) score += 30;
      if (c.r.height > 250) score += 15;
      return score;
    }

    cands.forEach(function (c) { c.score = chatScore(c); });
    cands.sort(function (a, b) { return b.score - a.score; });
    add('候选数: ' + cands.length + '，取前 10');
    cands.slice(0, 10).forEach(function (c, i) {
      add('');
      add('--- 候选 #' + i + ' ---');
      add('  元素: ' + snapTag(c.el));
      add('  role=' + (c.el.getAttribute('role') || '-') +
          ' ariaLive=' + (c.el.getAttribute('aria-live') || '-') +
          ' 可滚动=' + c.scroll);
      add('  得分=' + c.score + ' 文本长度=' + c.len +
          ' 直接子元素数=' + c.kids + ' rect=' + snapRect(c.el));
      add('  文本开头: ' + clipText(c.t, 150));
      var sigs2 = {};
      Array.prototype.forEach.call(c.el.children, function (k) {
        var s = snapTag(k).split('.').slice(0, 3).join('.');
        sigs2[s] = (sigs2[s] || 0) + 1;
      });
      add('  子元素签名: ' + clipText(Object.keys(sigs2).map(function (k) {
        return k + ' x' + sigs2[k];
      }).join(' | '), 400));
      add('  祖先链:');
      snapAncestors(c.el, 6, L);
    });

    head('5. 最深的文本块（题目文字通常在这里，含 iframe 内）');
    var texts = [];
    var docsAll = allDocs();
    add('扫描文档数: ' + docsAll.length + '（' + docsAll.map(function (x) { return x.label; }).join(', ') + '）');
    docsAll.forEach(function (dinfo) {
      var walker;
      try { walker = dinfo.doc.createTreeWalker(dinfo.doc.body, 4 /* SHOW_TEXT */, null); }
      catch (e) { return; }
      var n, guard = 0;
      while ((n = walker.nextNode())) {
        if (++guard > 60000) break;
        var raw = (n.nodeValue || '').trim();
        if (raw.length < 12) continue;
        var p = n.parentElement;
        if (!p || isOwnUI(p)) continue;
        var ar = absoluteRect(p);
        if (ar.width === 0 || ar.height === 0) continue;
        var d = 0, cur = p;
        while (cur) { d++; cur = cur.parentElement; }
        texts.push({ t: raw, d: d, el: p, r: ar, from: dinfo.label });
      }
    });
    texts.sort(function (a, b) { return b.d - a.d; });
    add('文本块数: ' + texts.length + '，列出最深的 12 个');
    texts.slice(0, 12).forEach(function (x, i) {
      add('#' + i + ' 深度' + x.d + ' 来源=' + x.from + ' ' + snapTag(x.el) + ' rect=' + snapRect(x.el));
      add('    内容: ' + clipText(clean(x.t), 120));
      add('    祖先链(4层):');
      snapAncestors(x.el, 4, L);
    });

    head('6. 屏幕采样点');
    var vw = window.innerWidth, vh = window.innerHeight;
    var pts = [
      ['正中', vw / 2, vh / 2], ['中上', vw / 2, vh * 0.25], ['中下', vw / 2, vh * 0.7],
      ['底部中间', vw / 2, vh * 0.92], ['底部偏右', vw * 0.75, vh * 0.92],
      ['左上', vw * 0.15, vh * 0.2], ['右上', vw * 0.85, vh * 0.2]
    ];
    var docsForPoint = allDocs();
    pts.forEach(function (p) {
      var px = Math.round(p[1]), py = Math.round(p[2]);
      var found = null, fromLabel = '';
      for (var di = 0; di < docsForPoint.length; di++) {
        var dinfo = docsForPoint[di];
        if (typeof dinfo.doc.elementFromPoint !== 'function') continue;
        // 顶层坐标 → 该文档坐标
        var lx = px - dinfo.dx, ly = py - dinfo.dy;
        var got = null;
        try { got = dinfo.doc.elementFromPoint(lx, ly); } catch (e) { got = null; }
        if (got && got.tagName && got.tagName.toLowerCase() !== 'iframe') {
          found = got; fromLabel = dinfo.label; break;
        }
        if (got && !found) { found = got; fromLabel = dinfo.label; }
      }
      if (!found) { add(p[0] + ' (' + px + ',' + py + ') -> (无)'); return; }
      add(p[0] + ' (' + px + ',' + py + ') -> [' + fromLabel + '] ' + snapTag(found) +
          ' textLen=' + clean(found.textContent).length);
      add('    文字: ' + clipText(clean(found.textContent), 100));
    });

    head('7. 关键区域 HTML 快照');
    function snapshot(el, label, maxLen) {
      if (!el) return;
      var html = el.outerHTML || '';
      add('');
      add('--- ' + label + ' ---');
      add('元素: ' + snapTag(el) + ' rect=' + snapRect(el) + ' HTML长度=' + html.length);
      add(clipText(html, maxLen || 4000));
    }
    if (cands.length) {
      snapshot(cands[0].el, '★ 匹配度最高的容器（很可能是聊天区）', 6000);
      var deepestKids = null, bestScore = -1;
      Array.prototype.forEach.call(cands[0].el.querySelectorAll('*'), function (k, i) {
        if (i > 3000) return;
        if (k.children.length < 2) return;
        var kinds = {};
        Array.prototype.forEach.call(k.children, function (c2) {
          kinds[snapTag(c2).split('.').slice(0, 3).join('.')] = 1;
        });
        var score2 = k.children.length - Object.keys(kinds).length * 2;
        if (score2 > bestScore) { bestScore = score2; deepestKids = k; }
      });
      snapshot(deepestKids, '推断出的消息列表层', 6000);
    }
    snapshot(document.querySelector('[contenteditable="true"],textarea'), '输入框', 1500);

    head('8. Shadow DOM');
    var hosts = [];
    Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) {
      if (el.shadowRoot) hosts.push(snapTag(el) + ' mode=' + el.shadowRoot.mode);
    });
    add('数量: ' + hosts.length);
    hosts.slice(0, 10).forEach(function (h) { add('  ' + h); });

    add('');
    add('===== 快照结束 =====');
    return L.join(String.fromCharCode(10));
  }

  // 点击采集：追加某个元素的祖先链与 HTML
  function snapshotWithClickCapture() {
    var report = buildSnapshotReport();
    showSnapshotDialog(report, true);
  }

  function showSnapshotDialog(report, allowClickCapture) {
    var NLC = String.fromCharCode(10);
    var wrap = el('div', {
      'data-quizbot-ui': '1',
      style: 'position:fixed;right:16px;top:16px;width:540px;max-width:calc(100vw - 32px);' +
             'max-height:calc(100vh - 32px);box-sizing:border-box;z-index:2147483647;' +
             'background:#fff;border:2px solid #2f6fed;border-radius:10px;padding:12px;' +
             'font:12px/1.5 "Microsoft YaHei",sans-serif;color:#222;box-shadow:0 8px 30px rgba(0,0,0,.3);' +
             'display:flex;flex-direction:column;'
    }, []);
    var bar = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;' }, []);
    var title = el('span', { style: 'font-weight:600;flex:1;',
                             text: '结构快照已生成（' + report.length + ' 字）' }, []);
    var ta = el('textarea', {
      style: 'width:100%;flex:1;min-height:300px;font:11px/1.45 Consolas,monospace;' +
             'border:1px solid #ddd;border-radius:6px;padding:8px;box-sizing:border-box;'
    }, []);
    ta.value = report;
    var hint = el('div', { style: 'color:#666;font-size:11px;margin-top:6px;',
                           text: '点「复制」后把内容整段发我。若复制失败，在框里 Ctrl+A 再 Ctrl+C。' }, []);

    function mkBtn(label, fn, primary) {
      var b = el('button', {
        style: 'padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;font-family:inherit;' +
               'border:1px solid ' + (primary ? '#2f6fed' : '#ccc') + ';' +
               'background:' + (primary ? '#2f6fed' : '#f7f7f7') + ';' +
               'color:' + (primary ? '#fff' : '#222') + ';'
      }, []);
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }

    bar.appendChild(title);
    bar.appendChild(mkBtn('复制', function () {
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(ta.value).then(function () {
          hint.textContent = '已复制 ✔ 直接粘贴发我即可。';
          hint.style.color = '#0a0';
        }).catch(function () {
          hint.textContent = '复制失败，请在框里 Ctrl+A / Ctrl+C。';
          hint.style.color = '#e33';
        });
        return;
      }
      hint.textContent = ok ? '已复制 ✔ 直接粘贴发我即可。' : '复制失败，请在框里 Ctrl+A / Ctrl+C。';
      hint.style.color = ok ? '#0a0' : '#e33';
    }, true));

    bar.appendChild(mkBtn('下载为文件', function () {
      try {
        var blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'quizbot-snapshot.txt';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) {
        log('下载失败: ' + e.message, 'error');
      }
    }));

    if (allowClickCapture) {
      bar.appendChild(mkBtn('★ 点击采集某个气泡', function () {
        hint.textContent = '请点击页面上智能体发的那条题目气泡…';
        hint.style.color = '#2f6fed';
        wrap.style.display = 'none';
        pickElement(function (node) {
          wrap.style.display = 'flex';
          var extra = [];
          function add2(s) { extra.push(String(s)); }
          add2('');
          add2('===== 9. 手动点击采集 =====');
          add2('点击元素: ' + snapTag(node) + ' rect=' + snapRect(node));
          add2('文字: ' + clipText(clean(node.textContent), 200));
          add2('祖先链:');
          snapAncestors(node, 12, extra);
          add2('');
          add2('--- 该元素 outerHTML ---');
          add2(clipText(node.outerHTML || '', 4000));
          add2('');
          add2('--- 父元素 outerHTML ---');
          add2(clipText((node.parentElement && node.parentElement.outerHTML) || '', 5000));
          add2('');
          add2('--- 再上一层 outerHTML ---');
          add2(clipText((node.parentElement && node.parentElement.parentElement &&
                         node.parentElement.parentElement.outerHTML) || '', 6000));
          ta.value = ta.value + NLC + extra.join(NLC);
          title.textContent = '已追加点击采集（共 ' + ta.value.length + ' 字）';
          hint.textContent = '采集完成，点「复制」发我。';
          hint.style.color = '#0a0';
          log('已追加点击采集，见右上角文本框');
        });
      }));
    }

    bar.appendChild(mkBtn('关闭', function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }));

    wrap.appendChild(bar);
    wrap.appendChild(ta);
    wrap.appendChild(hint);
    document.body.appendChild(wrap);
    log('结构快照已生成（' + report.length + ' 字），见右上角文本框，点「复制」发我');
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    if (!document.body) { setTimeout(init, 300); return; }
    // 脚本现在会在所有 frame 里运行（为了支持 iframe 内的对话区）。
    // 无关的 iframe（广告、统计等）不建面板，避免满屏都是按钮。
    if (!shouldShowPanelHere()) return;
    loadAnswerLog();      // 恢复历史答题记录（跨刷新/重启保留）
    buildPanel();
    log('已加载 v' + VERSION + '（' + (hasGM ? 'Tampermonkey 模式' : '控制台模式') + '）');
    if (ANSWER_LOG.length) {
      log('已恢复 ' + ANSWER_LOG.length + ' 条历史答题记录（点「📋 答题记录」查看）');
    }
    if (!CONFIG.apiKey) log('提示：还没填写 API Key，点「设置」配置你自己的接口');
    if (CONFIG.autoRunOnLoad) setTimeout(function () { doRun(); }, 1200);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('📋 导出结构快照（发给作者）', snapshotWithClickCapture);
      GM_registerMenuCommand('🔄 重置识别（清空已保存的选择器）', function () {
        saveConfig({ chatListSelector: '', chatInputSelector: '', regionRect: null, regionFrameUrl: '' });
        CHAT.listEl = null; CHAT.inputEl = null;
        log('已重置，请重新点「① 预览对话」');
      });
      GM_registerMenuCommand('★ 点击学习消息列表', learnFromClick);
      GM_registerMenuCommand('★ 框选题目区域', function () { pickRect(function (r) { useRegion(r); }); });
      GM_registerMenuCommand('① 预览对话消息', chatPreview);
      GM_registerMenuCommand('② 回答最新一条', function () { chatAnswerLatest(true); });
      GM_registerMenuCommand('③ 自动应答 开/关', toggleChatWatch);
      GM_registerMenuCommand('读取题目（表单模式）', doRead);
      GM_registerMenuCommand('AI 作答并填写（表单模式）', doRun);
      GM_registerMenuCommand('显示/隐藏面板', function () {
        PANEL.style.display = PANEL.style.display === 'none' ? 'block' : 'none';
      });
    }

    // 恢复上次框选的题目区域（同一页面才恢复，避免坐标串页）
    if (CONFIG.regionRect && CONFIG.regionRect.width > 40 &&
        (!CONFIG.regionFrameUrl || CONFIG.regionFrameUrl === location.href)) {
      REGION.rect = CONFIG.regionRect;
      log('已恢复上次框选的题目区域（' + Math.round(REGION.rect.width) + 'x' +
          Math.round(REGION.rect.height) + '），点「区域模式：答最新」即可使用');
    }

    if (CONFIG.chatAutoReply && (CONFIG.chatListSelector || CONFIG.chatInputSelector)) {
      setTimeout(function () {
        if (ensureChatTargets(true)) chatStartWatch();
      }, 1500);
    }

    // 暴露给控制台，方便手动调用
    window.quizbot = {
      config: CONFIG,
      // —— 表单模式 ——
      read: doRead,
      run: doRun,
      fill: doFillOnly,
      questions: function () { return LAST_QUESTIONS; },
      answers: function () { return LAST_ANSWERS; },
      // —— 对话模式 ——
      chat: {
        preview: chatPreview,
        answer: chatAnswerLatest,
        start: chatStartWatch,
        stop: chatStopWatch,
        toggle: toggleChatWatch,
        detect: function () { return ensureChatTargets(true); },
        messages: extractMessages,
        pickList: function () {
          pickElement(function (node) {
            CHAT.listEl = node;
            saveConfig({ chatListSelector: cssPathOf(node) });
            chatPreview();
          });
        },
        pickInput: function () {
          pickElement(function (node) {
            CHAT.inputEl = node;
            saveConfig({ chatInputSelector: cssPathOf(node) });
            log('已指定输入框');
          });
        },
        learn: learnFromClick,
        pickRegion: function () { pickRect(function (r) { useRegion(r); }); },
        regionText: function () { return REGION.rect ? textInRegion(REGION.rect) : ''; },
        regionAnswer: regionAnswerLatest,
        regionStart: regionStartWatch,
        regionStop: regionStopWatch,
        _region: REGION,
        useList: function (el) { CHAT.listEl = el; saveConfig({ chatListSelector: cssPathOf(el) }); return el; },
        useInput: function (el) { CHAT.inputEl = el; saveConfig({ chatInputSelector: cssPathOf(el) }); return el; },
        _state: CHAT
      },
      answerLog: function () { return ANSWER_LOG.slice(); },
      code: {
        task: readCodeTask,
        editorCode: readEditorCode,
        fill: fillEditorCode,
        run: codeDoTask,
        clickRun: clickRunButton,
        preview: codePreview,
        start: codeStartWatch,
        stop: codeStopWatch,
        _state: CODE
      },
      clearAnswerLog: clearAnswerLog,
      snapshot: snapshotWithClickCapture,
      snapshotReport: function () { return buildSnapshotReport(); },
      save: saveConfig,
      log: log
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
