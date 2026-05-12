# Librarian

`librarian` 是一个面向 GitHub 仓库和 GitLab 项目的代码库理解扩展。它会注册一组远程读取、搜索、
对比工具，并提供一个 `librarian` 汇总工具，用隔离的子 agent 帮你探索一个或多个远程代码库
后给出答案。

## 前置条件

- 已安装 GitHub CLI：`gh`
- 如需访问 GitLab，已安装 GitLab CLI：`glab`
- 已登录对应 provider：

```bash
gh auth login
glab auth login
```

扩展会通过 `gh api` 访问 GitHub，通过 `glab api` 访问 GitLab。私有仓库/项目需要当前
CLI 登录账号有对应权限。GitLab 支持 `gitlab.com` 以及 `glab` 已配置的 self-managed host。

## 启用方式

本仓库的根 `package.json` 已默认注册该扩展：

```json
{
  "pi": {
    "extensions": ["./extensions/librarian"]
  }
}
```

如果你是通过插件库按项目启用，先安装插件，然后在 Pi 中运行：

```text
/toggle-plugin
```

选择 `librarian` 后重载 Pi：

```text
/reload
```

## 推荐用法

直接让 Pi 使用 `librarian` 回答关于 GitHub 仓库的问题，例如：

```text
用 librarian 看一下 earendil-works/pi-coding-agent 的扩展加载流程在哪里实现？
```

```text
请用 librarian 对比 owner/repo 的 main 和 feature/foo，概括关键变更和风险。
```

```text
用 librarian 找一下 owner/repo 里处理 GitHub auth 的代码路径，并说明调用链。
```

```text
用 librarian 看一下 https://gitlab.com/group/project 里 CI 配置的加载流程。
```

```text
用 librarian 对比 GitLab 项目 group/subgroup/project 的 main 和 feature/foo，概括关键变更。
```

如果问题涉及多个候选仓库，可以先描述目标，`librarian` 会用仓库发现和代码搜索工具缩小范围：

```text
用 librarian 找一下我们 GitHub 组织里和 kanban worktree UI 相关的仓库，并总结入口文件。
```

## 可用工具

扩展注册以下工具，通常由 agent 自动选择使用：

- `librarian`：面向代码库理解的汇总工具，会启动隔离子 agent 探索仓库并输出答案。
- `list_repositories`：按名称、组织、语言筛选当前账号可访问 GitHub 仓库，并补充公开搜索结果。
- `read_github`：读取 GitHub 仓库文件，支持可选行号范围。
- `list_directory_github`：列出 GitHub 仓库目录。
- `glob_github`：按 glob 匹配 GitHub 仓库文件路径。
- `search_github`：在 GitHub 仓库中搜索代码并返回上下文片段。
- `commit_search`：按提交信息、作者、日期、路径搜索 GitHub 提交历史。
- `diff`：对比 GitHub 两个 ref，可选返回文件 patch。
- `list_gitlab_projects`：按名称、group、host、语言筛选 GitLab 项目。
- `read_gitlab`：读取 GitLab 项目文件，支持可选行号范围。
- `list_directory_gitlab`：列出 GitLab 项目目录。
- `glob_gitlab`：按 glob 匹配 GitLab 项目文件路径。
- `search_gitlab`：在 GitLab 项目中搜索代码并返回上下文片段。
- `commit_search_gitlab`：按提交信息、作者、日期、路径搜索 GitLab 提交历史。
- `diff_gitlab`：对比 GitLab 两个 ref，可选返回文件 patch。

## 直接工具调用示例

在支持工具调用的上下文中，也可以明确要求 Pi 调某个工具：

```text
调用 read_github 读取 owner/repo 的 src/index.ts 前 80 行。
```

```text
调用 search_github 在 owner/repo 中搜索 "registerTool"，限制在 extensions 路径下。
```

```text
调用 diff 对比 owner/repo 的 v1.0.0 和 main，并包含 patch 摘要。
```

```text
调用 read_gitlab 读取 https://gitlab.com/group/project 的 README.md 前 80 行。
```

```text
调用 search_gitlab 在 group/subgroup/project 中搜索 "registerTool"。
```

## 注意事项

- GitHub 仓库参数支持 `owner/repo` 或 `https://github.com/owner/repo`。
- GitLab project 参数支持 `group/project`、`group/subgroup/project` 或 GitLab URL。
- `read_github` 和 `read_gitlab` 单次读取内容限制约 128KB；大文件请指定行号范围。
- `search_github` 使用 GitHub code search，查询可以包含 GitHub 支持的操作符和限定词。
- `search_gitlab` 使用 GitLab project search，搜索语义比 GitHub code search 更简单。
- 子 agent 只拿到远程代码库分析工具，不会读取你的本地文件或环境变量。
- 如果看到 `GitHub authentication required`，先运行 `gh auth login` 并确认账号有仓库权限。
- 如果看到 `GitLab authentication required`，先运行 `glab auth login` 并确认账号有项目权限。
