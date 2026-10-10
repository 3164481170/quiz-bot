/* 题目提取脚本 —— 在目标页面上下文里执行。
 * 只做「读」，不改动页面内容（仅打上 data-qb-* 标记，便于后续精准填写）。
 * 返回 JSON 字符串。
 */
(() => {
  const MAX_QUESTIONS = 300;
  const result = {
    pageType: 'unknown',
    url: location.href,
    title: document.title,
    questions: [],
    warnings: []
  };

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    return true;
  };

  const clean = (text) => (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const Q_MARK = /^[\s\u3000]*[（(【\[]?\s*(\d{1,3})\s*[.、．)）\]:：】\]]\s*/;
  const OPT_MARK = /^[\s\u3000]*[（(【\[]?\s*([A-Ha-h])\s*[.、．)）\]:：】\]]\s+/;

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w\-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w\-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };

  /* ---------- 收集文档（含同源 iframe） ---------- */
  const docs = [];
  const collectDocs = (doc, label) => {
    docs.push({ doc, label });
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe,frame')); } catch (e) { return; }
    frames.forEach((frame, i) => {
      try {
        const inner = frame.contentDocument;
        if (inner && inner.body) collectDocs(inner, label + '/iframe[' + i + ']');
      } catch (e) { result.warnings.push('跨域 iframe 无法读取: ' + label); }
    });
  };
  collectDocs(document, 'top');

  const labelFor = (input) => {
    const root = input.getRootNode ? input.getRootNode() : document;
    if (input.id) {
      try {
        const esc = (window.CSS && CSS.escape) ? CSS.escape(input.id) : input.id;
        const lab = root.querySelector('label[for="' + esc + '"]') ||
                    document.querySelector('label[for="' + esc + '"]');
        if (lab) return lab;
      } catch (e) {}
    }
    const wrapping = input.closest('label');
    if (wrapping) return wrapping;
    return null;
  };

  const optionTextFor = (input) => {
    const lab = labelFor(input);
    if (lab) {
      const t = clean(lab.innerText || lab.textContent);
      if (t) return t;
    }
    let node = input.nextSibling;
    let acc = '';
    let hops = 0;
    while (node && hops < 4) {
      if (node.nodeType === 3) acc += node.textContent;
      else if (node.nodeType === 1) {
        const t = clean(node.innerText || node.textContent);
        if (t) acc += ' ' + t;
        hops++;
      }
      if (acc.trim().length > 2) break;
      node = node.nextSibling;
    }
    if (!acc.trim()) {
      const parent = input.parentElement;
      if (parent) {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,script,style').forEach(n => n.remove());
        acc = clean(clone.innerText || clone.textContent);
      }
    }
    return clean(acc).slice(0, 400);
  };

  const inputKind = (input) => {
    const tag = input.tagName.toLowerCase();
    if (tag === 'textarea') return 'text';
    if (tag === 'select') return 'select';
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (type === 'radio') return 'single';
    if (type === 'checkbox') return 'multiple';
    if (['hidden', 'submit', 'button', 'reset', 'file', 'image'].indexOf(type) >= 0) return null;
    return 'text';
  };

  const stemFrom = (node) => {
    let current = node;
    let best = '';
    for (let up = 0; up < 7 && current && current !== document.body; up++) {
      const clone = current.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,script,style,button,svg').forEach(n => n.remove());
      const text = clean(clone.innerText || clone.textContent);
      if (text.length >= 4) {
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const filtered = lines.filter(line => !OPT_MARK.test(line));
        if (filtered.length) {
          const joined = filtered.join('\n');
          const m = joined.match(Q_MARK);
          if (m && (best === '' || joined.length < best.length)) { best = joined; break; }
          if (best === '') best = joined;
        }
      }
      current = current.parentElement;
    }
    return best.replace(Q_MARK, '').trim().slice(0, 4000);
  };

  const seenInputs = new Set();
  const blocks = [];
  let qIndex = 0;

  docs.forEach(({ doc, label }) => {
    let inputs = [];
    try { inputs = Array.from(doc.querySelectorAll('input,textarea,select')); } catch (e) { return; }
    const usable = inputs.filter(el => inputKind(el) !== null && isVisible(el) && !el.disabled);

    const groups = new Map();
    usable.forEach((el) => {
      const kind = inputKind(el);
      if (kind !== 'single' && kind !== 'multiple') return;
      let key = el.name || '';
      if (!key) {
        const box = el.closest('fieldset,li,tr,div,p');
        key = '__anon_' + (box ? blocks.length + '_' + (cssPath(box) || box.tagName) : String(Math.random()));
      }
      if (!groups.has(key)) groups.set(key, { kind, els: [] });
      groups.get(key).els.push(el);
    });

    groups.forEach((group) => {
      group.els.forEach(el => seenInputs.add(el));
      if (!group.els.length) return;
      const first = group.els[0];
      const optionEls = [];
      const options = group.els.map((el, i) => {
        const lab = labelFor(el);
        if (lab) optionEls.push(lab);
        const text = optionTextFor(el);
        const marker = text.match(OPT_MARK);
        const ownValue = el.getAttribute('value') || '';
        const handle = 'q' + qIndex + '_o' + i;
        el.setAttribute('data-qb-input', handle);
        return {
          index: i,
          key: marker ? marker[1].toUpperCase() : (ownValue || String.fromCharCode(65 + i)),
          text: text.replace(OPT_MARK, '').trim(),
          value: ownValue,
          checked: !!el.checked,
          handle: handle,
          selector: cssPath(el)
        };
      });

      const container = first.closest('fieldset,li,tr,.question,.item,.topic,.subject,div,p') || first.parentElement;
      let stem = stemFrom(container || first);
      if (!stem && container && container.previousElementSibling) {
        stem = clean(container.previousElementSibling.innerText || container.previousElementSibling.textContent);
      }
      if (!stem) stem = '(题干未识别)';

      blocks.push({
        index: blocks.length + 1,
        type: group.kind,
        stem: stem,
        options: options,
        frame: label,
        groupName: first.name || null,
        container: cssPath(container),
        required: group.els.some(el => el.required)
      });
      qIndex++;
    });
  });

  docs.forEach(({ doc, label }) => {
    let inputs = [];
    try { inputs = Array.from(doc.querySelectorAll('input,textarea')); } catch (e) { return; }
    inputs.filter(el => inputKind(el) === 'text' && isVisible(el) && !el.disabled && !seenInputs.has(el))
      .forEach((el) => {
        seenInputs.add(el);
        const handle = 'q' + qIndex + '_t';
        el.setAttribute('data-qb-input', handle);
        const placeholder = el.getAttribute('placeholder') || '';
        const aria = el.getAttribute('aria-label') || '';
        const lab = labelFor(el);
        let stem = lab ? clean(lab.innerText || lab.textContent) : '';
        if (!stem) {
          const container = el.closest('div,li,td,p,section,fieldset');
          if (container) {
            const clone = container.cloneNode(true);
            clone.querySelectorAll('input,textarea,select,script,style,button').forEach(n => n.remove());
            stem = clean(clone.innerText || clone.textContent).split('\n').filter(Boolean).join('\n');
          }
        }
        if (!stem) stem = placeholder || aria || '(题干未识别)';
        blocks.push({
          index: blocks.length + 1,
          type: 'text',
          stem: stem,
          options: [],
          frame: label,
          placeholder: placeholder,
          multiline: el.tagName.toLowerCase() === 'textarea',
          maxlength: el.getAttribute('maxlength') ? parseInt(el.getAttribute('maxlength'), 10) : null,
          handle: handle,
          container: cssPath(el),
          required: !!el.required
        });
        qIndex++;
      });
  });

  docs.forEach(({ doc, label }) => {
    let selects = [];
    try { selects = Array.from(doc.querySelectorAll('select')); } catch (e) { return; }
    selects.filter(el => isVisible(el) && !el.disabled && !seenInputs.has(el)).forEach((el) => {
      seenInputs.add(el);
      const handle = 'q' + qIndex + '_s';
      el.setAttribute('data-qb-input', handle);
      const options = Array.from(el.options).map((opt, i) => ({
        index: i, key: opt.value, text: clean(opt.text), value: opt.value,
        checked: opt.selected, handle: handle
      }));
      const container = el.closest('div,li,td,p,section,fieldset');
      let stem = '';
      if (container) {
        const clone = container.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,script,style,button').forEach(n => n.remove());
        stem = clean(clone.innerText || clone.textContent).split('\n').filter(Boolean).join('\n');
      }
      blocks.push({
        index: blocks.length + 1, type: 'select', stem: stem || '(题干未识别)',
        options: options, frame: label, handle: handle, container: cssPath(el), required: !!el.required
      });
      qIndex++;
    });
  });

  if (blocks.length === 0) {
    const bodyText = clean(document.body ? document.body.innerText : '');
    if (bodyText) {
      result.warnings.push('页面上没有发现可填写的输入控件，已返回纯文本供识别模式使用。');
      result.pageText = bodyText.slice(0, 20000);
    }
  }

  result.questions = blocks.slice(0, MAX_QUESTIONS);
  const kinds = new Set(result.questions.map(q => q.type));
  result.pageType = result.questions.length
    ? ((kinds.has('single') || kinds.has('multiple') || kinds.has('select')) ? 'quiz' : 'form')
    : 'unknown';
  try { result.documentText = clean(document.body ? document.body.innerText : '').slice(0, 20000); } catch (e) {}
  return JSON.stringify(result);
})()
