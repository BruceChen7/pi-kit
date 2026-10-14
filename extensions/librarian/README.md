# Librarian

`librarian` 是一个面向 GitHub 仓库和 GitLab 项目的代码库理解扩展。它会注册一组远程读取、搜索、
对比工具，并提供两个隔离的子 agent（`librarian_github` / `librarian_gitlab`）分别专注于
对应 provider，帮你探索一个或多个远程代码库后给出答案。

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

### GitHub 仓库

用 `librarian_github` 回答关于 GitHub 仓库的问题：

```text
用 librarian_github 看一下 earendil-works/pi-coding-agent 的扩展加载流程在哪里实现？
```

```text
请用 librarian_github 对比 owner/repo 的 main 和 feature/foo，概括关键变更和风险。
```

```text
用 librarian_github 找一下 owner/repo 里处理 GitHub auth 的代码路径，并说明调用链。
```

### GitLab 项目

用 `librarian_gitlab` 回答关于 GitLab 项目的问题：

```text
用 librarian_gitlab 看一下 https://gitlab.com/group/project 里 CI 配置的加载流程。
```

```text
用 librarian_gitlab 对比 GitLab 项目 group/subgroup/project 的 main 和 feature/foo，概括关键变更。
```

### 多候选仓库

如果问题涉及多个候选仓库，可以先描述目标，子 agent 会用仓库发现和代码搜索工具缩小范围：

```text
用 librarian_github 找一下我们 GitHub 组织里和 kanban worktree UI 相关的仓库，并总结入口文件。
```

```text
用 librarian_gitlab 找一下我们 GitLab 组里和 CI pipeline 相关的项目。
```

## 可用工具

扩展注册 16 个工具：其中只有两个汇总子 agent 是声明给模型的普通工具，其余 14 个远程数据工具
注册为 `exposure: "deferred"` —— **可被 codemode 脚本随时调用，但默认不占用 context**（pi 不把它们
列进 `codemode` 的工具描述）。主会话模型需要它们时用 `await describeTool(name)` 取签名，或用
`await searchTools(query)` / `ALL_TOOLS` 按语义查找；启用 pi 内置的 `tool_search`（用户 settings 的
`defaultTools` 含 `+tool_search`）后，也可以直接 `tool_search("github repository diff")`，命中工具会被
声明到下一轮、之后不必写脚本即可调用——与 codemode 的 `describeTool`/`searchTools` 是两条并行发现路径。
`librarian_github` / `librarian_gitlab` 子进程则通过 `--tools +read_github,...` 直接激活这些工具给自己的子模型使用。

### 汇总子 agent（已声明给模型）

- `librarian_github`：GitHub 专属代码库理解子 agent，启动隔离子 agent 探索 GitHub 仓库并输出答案。
- `librarian_gitlab`：GitLab 专属代码库理解子 agent，启动隔离子 agent 探索 GitLab 项目并输出答案。

### GitHub 数据工具（不声明，codemode 专用）

- `list_github_repositories`：按名称、组织、语言筛选当前账号可访问 GitHub 仓库，并补充公开搜索结果。
- `read_github`：读取 GitHub 仓库文件，支持可选行号范围。
- `list_directory_github`：列出 GitHub 仓库目录。
- `glob_github`：按 glob 匹配 GitHub 仓库文件路径。
- `search_github`：在 GitHub 仓库中搜索代码并返回上下文片段。
- `commit_search`：按提交信息、作者、日期、路径搜索 GitHub 提交历史。
- `diff`：对比 GitHub 两个 ref，可选返回文件 patch。

### GitLab 数据工具（不声明，codemode 专用）

- `list_gitlab_projects`：按名称、group、host、语言筛选 GitLab 项目。
- `read_gitlab`：读取 GitLab 项目文件，支持可选行号范围。
- `list_directory_gitlab`：列出 GitLab 项目目录。
- `glob_gitlab`：按 glob 匹配 GitLab 项目文件路径。
- `search_gitlab`：在 GitLab 项目中搜索代码并返回上下文片段。
- `commit_search_gitlab`：按提交信息、作者、日期、路径搜索 GitLab 提交历史。
- `diff_gitlab`：对比 GitLab 两个 ref，可选返回文件 patch。

## 从 codemode 调用数据工具

这 14 个数据工具没有声明给模型，需要时在 codemode 脚本里调用：先用 `describeTool()` 取参数签名，
或用 `searchTools()` / `ALL_TOOLS` 按语义查找，然后 `tools.<name>({...})`。声明了 `outputSchema` 的工具
在脚本里解析为结构化对象（错误调用则以 Error 拒绝，可用 `Promise.allSettled()` 保留成功的兄弟调用），
所以可以并行调用、在脚本里先过滤，只有脚本输出会进入模型上下文。

```js
// 取签名（不确定参数名时）
return await describeTool("read_github");
```

```js
// 并行读文件 + 搜索，脚本里只返回需要的内容
const [file, hits] = await Promise.all([
  tools.read_github({ repository: "owner/repo", path: "src/index.ts", read_range: [1, 80] }),
  tools.search_github({ repository: "owner/repo", pattern: "registerTool", path: "extensions" }),
]);
return `file:\n${file.content}\nhits: ${hits.totalCount}`;
```

```js
// 语义查找 + diff，patch 很长时先在脚本里截断
const [match] = await searchTools("github compare two refs", { limit: 3 });
const d = await tools.diff({ repository: "owner/repo", base: "v1.0.0", head: "main" });
return `${match.name}: ${d.files.length} files, ${d.ahead_by} ahead`;
```

```js
// GitLab 同理：read_gitlab / search_gitlab / diff_gitlab / list_gitlab_projects
const projects = await tools.list_gitlab_projects({ group: "acme", language: "Go" });
return projects.projects.map((p) => p.name);
```

也可以直接对 Pi 说“用 codemode 调 read_github 读 owner/repo 的 src/index.ts 前 80 行”，
主会话模型会自己 `describeTool` 后调用；跨仓库的大范围探索则交给 `librarian_github` / `librarian_gitlab`。

## 内部模块结构

扩展内部按职责拆分为 7 个文件，各自保持干净：

| 文件 | 职责 |
|------|------|
| `shared.ts` | 纯工具函数（无 pi 依赖）：路径归一化、glob 匹配、进度渲染等 |
| `github.ts` | GitHub 专属：`parseRepository`、`ghApi`、7 个 GitHub 工具 handler |
| `gitlab.ts` | GitLab 专属：`parseGitLabProject`、`glabApi`、7 个 GitLab 工具 handler |
| `librarian-runner.ts` | Provider 无关的子 agent 运行器 |
| `librarian-github.ts` | `librarian_github` 工具注册（GitHub-only system prompt + tool list） |
| `librarian-gitlab.ts` | `librarian_gitlab` 工具注册（GitLab-only system prompt + tool list） |
| `index.ts` | 入口，组合各模块注册所有工具 |

## 注意事项

- GitHub 仓库参数支持 `owner/repo` 或 `https://github.com/owner/repo`。
- GitLab project 参数支持 `group/project`、`group/subgroup/project` 或 GitLab URL。
- `read_github` 和 `read_gitlab` 单次读取内容限制约 128KB；大文件请指定行号范围。
- `search_github` 使用 GitHub code search，查询可以包含 GitHub 支持的操作符和限定词。
- `search_gitlab` 使用 GitLab project search，搜索语义比 GitHub code search 更简单。
- 子 agent 只拿到对应 provider 的远程代码库分析工具，不会读取你的本地文件或环境变量。
- 14 个数据工具是 `deferred` exposure：启动不占 context，需要时用 codemode 的 `describeTool(name)` / `searchTools(query)`，或直接 `tool_search("github repository diff")`（需 `defaultTools` 含 `+tool_search`），命中工具声明到下一轮后可直接调用；`librarian_*` 子 agent 不受影响，它们显式激活这些工具。
- 如果看到 `GitHub authentication required`，先运行 `gh auth login` 并确认账号有仓库权限。
- 如果看到 `GitLab authentication required`，先运行 `glab auth login` 并确认账号有项目权限。
