#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把当前项目上传到 GitHub —— 完全不需要安装 git。

原理：直接调用 GitHub 的 REST API（Git Data API），
      先建仓库，再把文件打包成一个 commit 推上去。

用法：
    # 最省事：交互式，会提示你粘贴 token
    python tools/upload-to-github.py

    # 指定仓库名 / 可见性
    python tools/upload-to-github.py --repo quiz-bot --private

    # 只看看会上传哪些文件（不联网、不需要 token）
    python tools/upload-to-github.py --list

    # 验证 token 与文件，但不真的上传
    python tools/upload-to-github.py --dry-run

    # 直接给 token（不推荐：会留在命令历史里）
    python tools/upload-to-github.py --token ghp_xxx

如何获取 token：
    https://github.com/settings/tokens  ->  Generate new token (classic)
    勾选 repo 权限，生成后复制（只显示一次）
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
UA = "quizbot-uploader"

# 不上传的目录 / 文件（与 .gitignore 保持一致）
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".pnpm", "logs",
             ".venv", "venv", ".idea", ".vscode"}
SKIP_FILES = {"config.json", ".DS_Store", "Thumbs.db"}
SKIP_EXT = {".pyc", ".zip", ".log"}

# GitHub 单文件限制
WARN_SIZE = 50 * 1024 * 1024
MAX_SIZE = 100 * 1024 * 1024


class GHError(RuntimeError):
    pass


class GitHub:
    def __init__(self, token: str):
        self.token = token

    def call(self, method: str, path: str, payload=None):
        url = API + path
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        req.add_header("User-Agent", UA)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read().decode("utf-8", "replace")
                return resp.status, (json.loads(body) if body.strip() else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            message = raw
            try:
                message = json.loads(raw).get("message", raw)
            except ValueError:
                pass
            return exc.code, {"_error": message}
        except Exception as exc:  # 网络层面的失败
            raise GHError("请求 %s %s 失败：%s" % (method, path, exc))

    def ok(self, method: str, path: str, payload=None):
        status, data = self.call(method, path, payload)
        if status >= 400:
            raise GHError("%s %s -> HTTP %d: %s" %
                          (method, path, status, (data or {}).get("_error", data)))
        return data

    def maybe(self, method: str, path: str, payload=None):
        """允许 404 / 409（视为"空仓库"）。"""
        status, data = self.call(method, path, payload)
        if status in (404, 409):
            return None
        if status >= 400:
            raise GHError("%s %s -> HTTP %d: %s" %
                          (method, path, status, (data or {}).get("_error", data)))
        return data


def collect_files(root: str):
    """收集要上传的文件，返回 [(相对路径, 绝对路径)]。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name in SKIP_FILES:
                continue
            if os.path.splitext(name)[1].lower() in SKIP_EXT:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append((rel, full))
    out.sort(key=lambda pair: pair[0])
    return out


def print_files(files, root):
    print("将要上传 %d 个文件：" % len(files))
    total = 0
    for rel, full in files:
        size = os.path.getsize(full)
        total += size
        print("  %-46s %8.1f KB" % (rel, size / 1024.0))
    print("")
    print("合计 %.1f KB" % (total / 1024.0))
    return total


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_root = os.path.dirname(here)

    ap = argparse.ArgumentParser(
        description="把项目上传到 GitHub（不需要安装 git）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=default_root, help="要上传的目录（默认项目根目录）")
    ap.add_argument("--repo", default=None, help="仓库名（默认用目录名）")
    ap.add_argument("--branch", default="main", help="分支名（默认 main）")
    ap.add_argument("--message", default="chore: 上传项目", help="提交信息")
    ap.add_argument("--token", default=None, help="GitHub token（不推荐写在命令行）")
    ap.add_argument("--private", action="store_true", help="创建私有仓库（默认公开）")
    ap.add_argument("--description", default="网页 AI 答题助手：油猴脚本 + 桌面版",
                    help="仓库描述")
    ap.add_argument("--list", action="store_true", help="只列出会上传的文件")
    ap.add_argument("--dry-run", action="store_true", help="验证但不真正上传")
    ap.add_argument("--yes", action="store_true", help="跳过确认提示")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print("目录不存在：%s" % root)
        return 2

    repo = args.repo or os.path.basename(root.rstrip("\\/"))
    files = collect_files(root)

    print("=" * 62)
    print("  上传项目到 GitHub")
    print("=" * 62)
    print("  项目目录：%s" % root)
    print("  仓库名　：%s" % repo)
    print("  分支　　：%s" % args.branch)
    print("  可见性　：%s" % ("私有" if args.private else "公开"))
    print("")

    if not files:
        print("没有找到可上传的文件。")
        return 1

    total = print_files(files, root)

    big = [(r, os.path.getsize(f)) for r, f in files if os.path.getsize(f) > WARN_SIZE]
    if big:
        print("")
        print("⚠ 以下文件超过 50MB，可能被 GitHub 拒绝：")
        for rel, size in big:
            print("    %s (%.1f MB)" % (rel, size / 1048576.0))
        if any(s > MAX_SIZE for _, s in big):
            print("  有文件超过 100MB 上限，已中止。")
            return 1

    if args.list:
        return 0

    # ---- token ----
    token = args.token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("")
        print("-" * 62)
        print("需要 GitHub Personal Access Token")
        print("  获取地址：https://github.com/settings/tokens")
        print("  新建 token (classic)，勾选 repo 权限")
        print("  粘贴时不会显示字符，这是正常的")
        print("-" * 62)
        try:
            token = getpass.getpass("请粘贴 token 后回车：").strip()
        except (KeyboardInterrupt, EOFError):
            print("")
            print("已取消。")
            return 130
    if not token:
        print("没有提供 token，已中止。")
        return 1

    gh = GitHub(token)

    # ---- 校验 token ----
    print("")
    print("==> 验证 token")
    try:
        user = gh.ok("GET", "/user")
    except GHError as exc:
        msg = str(exc)
        if "401" in msg:
            print("    token 无效或已过期。请重新生成。")
        else:
            print("    失败：%s" % msg)
        return 1
    login = user.get("login")
    print("    已登录为 %s" % login)

    # ---- 建仓库（已存在则复用）----
    print("==> 检查仓库 %s/%s" % (login, repo))
    existing = gh.maybe("GET", "/repos/%s/%s" % (login, repo))
    if existing:
        print("    仓库已存在，将更新内容")
    else:
        if args.dry_run:
            print("    仓库不存在（dry-run：不创建）")
        else:
            print("    仓库不存在，正在创建…")
            gh.ok("POST", "/user/repos", {
                "name": repo,
                "description": args.description,
                "private": bool(args.private),
                "auto_init": False,
            })
            print("    已创建")

    if args.dry_run:
        print("")
        print("dry-run 完成：token 有效、文件已就绪，但未上传。")
        return 0

    if not args.yes:
        print("")
        try:
            answer = input("确认上传到 https://github.com/%s/%s ？(y/N) " % (login, repo))
        except (KeyboardInterrupt, EOFError):
            print("")
            return 130
        if answer.strip().lower() not in ("y", "yes"):
            print("已取消。")
            return 0

    # ---- 取当前分支的最新 commit（若仓库为空则为 None）----
    base_commit = gh.maybe("GET", "/repos/%s/%s/git/ref/heads/%s" % (login, repo, args.branch))
    parent_sha = None
    base_tree = None
    if base_commit and base_commit.get("object"):
        parent_sha = base_commit["object"]["sha"]
        commit_obj = gh.ok("GET", "/repos/%s/%s/git/commits/%s" % (login, repo, parent_sha))
        base_tree = commit_obj.get("tree", {}).get("sha")
        print("==> 基于已有分支 %s（增量更新）" % args.branch)
    else:
        print("==> 仓库为空，将创建首个提交")

    # ---- 逐个上传 blob ----
    print("==> 上传文件内容")
    tree_items = []
    for index, (rel, full) in enumerate(files, 1):
        with open(full, "rb") as handle:
            raw = handle.read()
        blob = gh.ok("POST", "/repos/%s/%s/git/blobs" % (login, repo), {
            "content": base64.b64encode(raw).decode("ascii"),
            "encoding": "base64",
        })
        tree_items.append({
            "path": rel,
            "mode": "100755" if (rel.endswith(".sh") or rel.endswith(".ps1")) else "100644",
            "type": "blob",
            "sha": blob["sha"],
        })
        if index % 10 == 0 or index == len(files):
            print("    %d / %d" % (index, len(files)))

    # ---- 建 tree ----
    print("==> 构建目录树")
    tree_payload = {"tree": tree_items}
    if base_tree:
        tree_payload["base_tree"] = base_tree
    tree = gh.ok("POST", "/repos/%s/%s/git/trees" % (login, repo), tree_payload)

    # ---- 建 commit ----
    print("==> 创建提交")
    commit_payload = {"message": args.message, "tree": tree["sha"], "parents": []}
    if parent_sha:
        commit_payload["parents"] = [parent_sha]
    commit = gh.ok("POST", "/repos/%s/%s/git/commits" % (login, repo), commit_payload)

    # ---- 更新 / 创建分支引用 ----
    print("==> 更新分支 %s" % args.branch)
    ref_path = "/repos/%s/%s/git/refs/heads/%s" % (login, repo, args.branch)
    if base_commit:
        gh.ok("PATCH", ref_path, {"sha": commit["sha"], "force": False})
    else:
        gh.ok("POST", "/repos/%s/%s/git/refs" % (login, repo),
              {"ref": "refs/heads/" + args.branch, "sha": commit["sha"]})

    url = "https://github.com/%s/%s" % (login, repo)
    print("")
    print("=" * 62)
    print("  上传完成 ✔")
    print("  %s" % url)
    print("=" * 62)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GHError as exc:
        print("")
        print("出错：%s" % exc)
        print("")
        print("常见原因：")
        print("  - token 权限不足（需要勾选 repo）")
        print("  - 同名仓库已存在且不属于你")
        print("  - 网络波动，可重试")
        sys.exit(1)
    except KeyboardInterrupt:
        print("")
        print("已取消。")
        sys.exit(130)
