#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用本地假 GitHub API 验证上传工具的完整流程（不需要真 token、不联网）。

    python tests/upload-tool.test.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
import http.server
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PASS = 0
FAIL = 0


def check(label, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s' % label)
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (label, (' — ' + str(detail)) if detail else ''))
    return ok


# ---------- 假 GitHub API ----------
STATE = {
    'repos': {},
    'blobs': {},
    'trees': {},
    'commits': {},
    'refs': {},
    'calls': [],
}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return None
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def _auth_ok(self):
        return self.headers.get('Authorization') == 'Bearer test-token'

    def do_GET(self):
        STATE['calls'].append(('GET', self.path))
        if not self._auth_ok():
            return self._send(401, {'message': 'Bad credentials'})
        if self.path == '/user':
            return self._send(200, {'login': 'tester'})
        if self.path.startswith('/repos/tester/'):
            parts = self.path.split('/')
            # /repos/tester/<repo>
            if len(parts) == 4:
                repo = parts[3]
                if repo in STATE['repos']:
                    return self._send(200, {'name': repo})
                return self._send(404, {'message': 'Not Found'})
            # /repos/tester/<repo>/git/ref/heads/<branch>
            if len(parts) == 7 and parts[4] == 'git' and parts[5] == 'ref' and parts[6] == 'heads':
                return self._send(404, {'message': 'Not Found'})
            if len(parts) == 8 and parts[4] == 'git' and parts[5] == 'commits':
                sha = parts[7]
                if sha in STATE['commits']:
                    return self._send(200, STATE['commits'][sha])
                return self._send(404, {'message': 'Not Found'})
        return self._send(404, {'message': 'Not Found'})

    def do_POST(self):
        STATE['calls'].append(('POST', self.path))
        if not self._auth_ok():
            return self._send(401, {'message': 'Bad credentials'})
        payload = self._read() or {}
        if self.path == '/user/repos':
            name = payload.get('name')
            STATE['repos'][name] = payload
            return self._send(201, {'name': name})
        if '/git/blobs' in self.path:
            raw = base64.b64decode(payload['content'].encode('ascii'))
            sha = 'blob%d' % len(STATE['blobs'])
            STATE['blobs'][sha] = raw
            return self._send(201, {'sha': sha})
        if '/git/trees' in self.path:
            sha = 'tree%d' % len(STATE['trees'])
            STATE['trees'][sha] = payload
            return self._send(201, {'sha': sha})
        if '/git/commits' in self.path:
            sha = 'commit%d' % len(STATE['commits'])
            STATE['commits'][sha] = payload
            return self._send(201, {'sha': sha})
        if '/git/refs' in self.path:
            STATE['refs'][payload.get('ref')] = payload.get('sha')
            return self._send(201, payload)
        return self._send(404, {'message': 'Not Found'})

    def do_PATCH(self):
        STATE['calls'].append(('PATCH', self.path))
        payload = self._read() or {}
        if '/git/refs/heads/' in self.path:
            STATE['refs'][self.path.split('/git/')[1]] = payload.get('sha')
            return self._send(200, payload)
        return self._send(404, {'message': 'Not Found'})


def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 载入被测模块
    spec = importlib.util.spec_from_file_location(
        'uploader', os.path.join(ROOT, 'tools', 'upload-to-github.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # 把 API 指向本地假服务器
    mod.API = 'http://127.0.0.1:%d' % port

    print('=== 1. 文件收集 ===')
    files = mod.collect_files(ROOT)
    rels = [r for r, _ in files]
    check('收集到文件', len(files) > 20, '%d 个' % len(files))
    check('排除了 node_modules', not any('node_modules' in r for r in rels))
    check('排除了 logs', not any(r.startswith('logs/') for r in rels))
    check('排除了 __pycache__', not any('__pycache__' in r for r in rels))
    check('排除了 config.json', 'config.json' not in rels)
    check('包含油猴脚本', 'userscript/quizbot.user.js' in rels)
    check('包含 README', 'README.md' in rels)

    print('')
    print('=== 2. 完整上传流程（假 API）===')
    code = mod.main(['--root', ROOT, '--repo', 'quiz-bot', '--token', 'test-token',
                     '--yes', '--branch', 'main'])
    check('main() 返回 0', code == 0, '实际 %s' % code)
    check('创建了仓库', 'quiz-bot' in STATE['repos'])
    check('上传了全部 blob', len(STATE['blobs']) == len(files),
          'blob %d / 文件 %d' % (len(STATE['blobs']), len(files)))
    check('创建了 tree', len(STATE['trees']) == 1)
    check('创建了 commit', len(STATE['commits']) == 1)
    check('创建了分支引用', 'refs/heads/main' in STATE['refs'],
          str(list(STATE['refs'].keys())))

    print('')
    print('=== 3. 内容正确性 ===')
    # 抽查一个文件的内容是否原样上传
    tree = list(STATE['trees'].values())[0]
    entry = [t for t in tree['tree'] if t['path'] == 'userscript/quizbot.user.js']
    check('tree 里含油猴脚本', bool(entry))
    if entry:
        blob = STATE['blobs'][entry[0]['sha']]
        local = open(os.path.join(ROOT, 'userscript', 'quizbot.user.js'), 'rb').read()
        check('文件内容逐字节一致', blob == local,
              'blob %d 字节 vs 本地 %d 字节' % (len(blob), len(local)))

    print('')
    print('=== 4. token 无效时应报错 ===')
    STATE['calls'] = []
    code2 = mod.main(['--root', ROOT, '--repo', 'quiz-bot-2', '--token', 'wrong-token',
                      '--yes', '--branch', 'main'])
    check('无效 token 返回非 0', code2 != 0, '实际 %s' % code2)
    check('没有创建仓库', 'quiz-bot-2' not in STATE['repos'])

    srv.shutdown()
    print('')
    print('=' * 56)
    if FAIL:
        print('测试失败：%d 项未通过（通过 %d 项）' % (FAIL, PASS))
        return 1
    print('全部通过 ✔  共 %d 项' % PASS)
    return 0


if __name__ == '__main__':
    sys.exit(main())