# 把项目上传到 GitHub

**不需要安装 git。** 用项目自带的 Python 上传工具，一条命令搞定。

---

## 推荐：用自带的上传工具（无需 git）

### 第 1 步：生成 GitHub Token

1. 打开 <https://github.com/settings/tokens>
2. 点 **Generate new token (classic)**
3. 勾选 **repo** 权限（这一项就够）
4. 点生成，把 token 复制下来（**只显示一次**）

### 第 2 步：运行上传

在项目根目录打开 PowerShell：

```powershell
python tools\upload-to-github.py
```

它会：

1. 列出将要上传的文件（自动跳过 `node_modules`、`logs`、`config.json`）
2. 提示你**粘贴 token**（输入时不显示字符，这是正常的）
3. 自动创建仓库 `quiz-bot` 并上传所有文件
4. 完成后打印仓库地址

### 常用参数

```powershell
# 只看看会上传哪些文件（不联网、不需要 token）
python tools\upload-to-github.py --list

# 验证 token 是否有效（不真的上传）
python tools\upload-to-github.py --dry-run

# 自定义仓库名 / 设为私有
python tools\upload-to-github.py --repo my-quiz-bot --private

# 仓库已存在时更新内容（同一个工具，重复运行即可）
python tools\upload-to-github.py --message "更新说明"
```

### 已上传过，想更新怎么办

**直接再跑一次同样的命令**就行。工具会自动检测仓库已存在，
并以增量方式提交新版本（不会重复建仓库）。

---

## 备选一：网页上传（完全不用命令行）

1. 打开 <https://github.com/new>，仓库名填 `quiz-bot`，**不要**勾选 "Add a README file"
2. 创建后点 **uploading an existing file**
3. 解压 `quiz-bot-upload.zip`，把里面的内容全部拖进上传区
4. 填一句说明，点 **Commit changes**

> ⚠️ 网页上传**不走 `.gitignore`**，请自己确认别把 `config.json` 拖进去（那里有你的 API Key）。

---

## 备选二：git 命令（会长期维护的话推荐）

装好 [Git for Windows](https://git-scm.com/download/win) 后：

```powershell
.\publish.ps1 -RepoUrl https://github.com/你的用户名/quiz-bot.git
```

之后每次改动只需：

```powershell
git add -A; git commit -m "更新"; git push
```

---

## 三种方式对比

| | Python 工具 | 网页上传 | git |
| --- | --- | --- | --- |
| 需要装东西 | 只需 Python | 无 | 需要 git |
| 需要 token | 是 | 否 | 可能需要 |
| 后续更新 | 重跑命令 | 手动重传 | `git push` |
| 自动跳过敏感文件 | ✅ | ❌ | ✅ |

---

## 上传前的安全检查

已经帮你确认过：

- ✅ 源码里**没有硬编码任何密钥**（全量扫描过 `sk-` / `ghp_` / `AKIA` 等特征）
- ✅ 上传工具会**自动排除**：`config.json`（存 API Key）、`node_modules/`（20 MB）、
  `logs/`、`__pycache__/`、`*.pyc`、`*.zip`
- ✅ `publish.ps1` 在提交前会再拦一道，发现敏感文件直接中止

---

## 关于 token 的安全性

- token 只在**你自己电脑上**使用，直接请求 `api.github.com`
- 不会经过任何第三方服务器
- 用完可以随时到 <https://github.com/settings/tokens> 撤销
- 如果担心，生成时把有效期设为 7 天，传完就失效

---

## 建议在仓库说明里加上

如果设为公开仓库，建议保留这段：

> 本工具用于自动化处理**你有权限操作**的页面，例如自测题库、内部调研、个人学习。
> 请遵守目标网站的服务条款，不要用于考试作弊或任何未授权的自动化操作。
