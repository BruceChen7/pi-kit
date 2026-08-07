# Tasks Extension

Linear 风格的任务跟踪器（task tracker），用于在 pi 里规划、跟踪和委派工作。取代旧的 todos/kanban/feature-workflow 体系。

提供四层使用方式：

| 方式 | 入口 | 适合 |
|------|------|------|
| CLI 命令 | `/issue ...` | 手动管理：建项目、建任务、移动状态 |
| Agent 工具 | `task_create` / `task_list` 等 9 个工具 | 让 agent 帮你跟踪工作（自然语言即可触发） |
| 看板视图 | `/issue board` | 打开 Glimpse 窗口可视化浏览 |
| 委托 | `task_delegate` / `/issue delegate` | 把任务丢给 herdr agent 全权执行 |

## 启用

默认**未**注册在根 `package.json`。启用方式：在根 `package.json` 的 `pi.extensions` 数组中加入

```json
"./extensions/tasks"
```

然后 `/reload` 或重启 pi。也可以在 pi 中直接加载该目录（目录内有 `index.ts` 入口）。

## 核心概念

### 项目（Project）与前缀（prefix）

**项目**是任务的分组容器，拥有自己的 key 前缀，四个属性：显示名、**前缀**、颜色、所属文件夹。

- 项目决定了任务的归属和命名：`PROD-1`、`PROD-2` 都属于"产品开发"这个项目
- **删项目 = 连锅端**：该项目下所有任务、标签、评论一起删除
- 类比：GitHub 的一个 repo，或 Linear 里的一个 Team —— 是"任务的容器"

**前缀（prefix）** 直接决定任务 key 的格式：建了 `PROD` 项目后，第一个任务是 `PROD-1`，第二个是 `PROD-2`。前缀规则：

- 大写字母开头，可含字母和数字，最多 10 个字符
- **全局唯一**（不是文件夹内唯一），`/issue project create` 时冲突会报错
- 任务 key 大小写不敏感：`prod-1` 和 `PROD-1` 指同一个任务

```text
/issue project create "产品开发" PROD #6366f1
#                       名       前缀  颜色
```

### 任务（Task）与任务 key

**任务**是最小的工作单元，字段：key、标题、描述、**状态**、**优先级**、截止日期、父任务（子任务）、标签列表、委托信息。

**任务 key** 是任务的唯一标识，格式为 `<项目前缀>-<序号>`（如 `PROD-1`），序号在项目内自动递增、不可复用。

### 状态（Status）—— 看板的列

任务的生命周期状态，也是看板的列：

```text
backlog（积压）→ todo（待办）→ in_progress（进行中）→ in_review（待审查）→ done（完成）
                                                              ↘ canceled（取消）
```

- `backlog`：尚未排期
- `todo`：已计划未开始
- `in_progress`：正在做（**委托中的任务一定在此状态**）
- `in_review`：做完了，等人审查（**子 agent 完成后把任务置为此状态**）
- `done` / `canceled`：终态

### 优先级（Priority）

`urgent`（紧急）/ `high`（高）/ `medium`（中）/ `low`（低）/ `none`（无），用于排序和过滤。

> 非法 status / priority 会在写入时被拒绝（store 层校验，不会污染数据）。

### 子任务（Subtask）

用 `--parent` 把任务挂在另一个任务下面，用于拆分大任务：

```text
/issue create "拆分订单模块" --parent PROD-12
```

- 子任务有自己的 key（如 `PROD-13`），独立管理状态
- 删除父任务会**级联删除**所有子任务
- 子任务不进看板的顶层卡片列表

### 评论（Comment）

挂在任务上的时间线记录，三种来源：

| kind | 来源 | 例子 |
|------|------|------|
| `user` | 用户/agent 手工添加 | `/issue comment PROD-12 已完成主流程` |
| `agent` | 被委托的子 agent 汇报 | 子 agent 调 `task_comment` |
| `system` | 系统自动记录 | "Delegated to agent..." / "Delegation failed..." |

评论用于审计：谁在什么时候说了什么、任务为什么变成这个状态。

### 标签（Label）

项目内的分类标记（名称 + 颜色），用于过滤任务：

```text
/issue label create PROD bug #ef4444    # 给 PROD 项目加"bug"标签
/issue create "修复崩溃" --project PROD --label bug
```

标签属于某个项目，不能跨项目复用；删除标签会自动从所有任务上摘除。

### 文件夹（Folder）

**项目**的分组容器，纯粹为了侧边栏的组织好看，类比文件系统里的"目录"（目录本身不装内容，只把文件夹到一起）：

```text
/issue folder create "Sprint"           # 建文件夹
```

**项目与文件夹的关系**：

```text
Folder（文件夹，可嵌套一层）
└── Project（项目，key 前缀所在）
    └── Task（任务 PROD-1、PROD-2...）
```

| 维度 | 规则 |
|------|------|
| 一个文件夹装几个项目 | **多个**（文件夹是 1:N 的"父"） |
| 一个项目属于几个文件夹 | **0 或 1 个**（可选；不挂 = 显示在侧边栏 "Projects" 顶层） |
| 文件夹能嵌套吗 | **一层**（folder 可挂到另一个 folder 下） |
| 前缀唯一性范围 | **全局唯一**（不是文件夹内唯一） |
| 删文件夹会删项目吗 | **不会** —— 项目只是被解除关联（folderId 置空），任务数据毫发无损 |
| 影响任务 key 吗 | **完全不影响** —— key 只由项目前缀决定 |

**一句话区别**：文件夹管"摆在哪"，项目管"归谁管 + key 叫什么"。文件夹是组织视图，删了不伤数据；项目是数据归属，删了连任务一起没。

### 看板（Board）

`/issue board` 打开 Glimpse 窗口的可视化视图：每个状态一列，卡片按状态分组，点击卡片弹出详情（含评论）。

- **只读快照**：打开时读取一次数据，改动请用命令/工具，重新 `/issue board` 刷新（无 daemon 架构，窗口不自动感知外部变更）
- 按 `⌘W`（macOS）或 `Ctrl+W` 关闭窗口

### 委托（Delegation）

把任务交给 **herdr 里的独立 pi 子 agent** 全权执行：

```text
/issue delegate PROD-12 [--instructions "先跑测试再提交"]
```

语义：

- 任务自动变为 `in_progress`，并写入一条 system 评论
- 子 agent 在新建的 herdr tab 中运行**完整 pi 会话**（含全部扩展和 task 工具），用户可实时看到它工作
- 子 agent 通过 `task_comment` 汇报进度，完成后 `task_update` 置为 `in_review`
- **已在委托中的任务不能重复委托**（防止两个 agent 同时改一个任务）
- 委托失败会写 system 评论，任务状态回滚不变
- 任务离开 `in_progress` 时（如子 agent 置为 `in_review`），委托记录自动清空

### Worktree 委托模式

`--worktree` 让子 agent 在**独立的 git worktree** 里工作，与主 checkout 隔离：

```text
/issue delegate PROD-13 --worktree
```

- 自动创建分支 `task/<key>-<slug>`（如 `task/prod-13-fix-checkout-crash`）和路径 `<worktree目录>/<仓库>.<key>`（如 `~/work/pi-kit.prod-13`）
- 子 agent 只在该 worktree 里改代码，不碰主 checkout
- 完成后 worktree **保留**供审查代码/看 diff，用 `/issue worktree-remove PROD-13 [--force]` 清理（分支保留供合并）

### Agent 工具（自然语言触发）

告诉 agent「把这个任务加到 PROD 项目」「查一下 TASK-3 进展」「把 PROD-5 标记为 in_progress」即可，agent 会自动调用 `task_*` 工具（见下文工具表）。配套 skill（`skills/tasks/SKILL.md`）定义工作流：开工前发现任务、开工置 `in_progress`、里程碑评论、完成置 `done`。

### 概念关系

> **项目**（PROD）→ 生成**任务 key**（PROD-1）→ 任务有**状态**（status，看板列）和**优先级**（priority）→ **标签**（label）是项目内的分类标记 → **文件夹**（folder）是项目的分组容器 → **评论**（comment）记录任务的时间线 → **委托**（delegation）把任务交给 herdr 子 agent 执行（可加 worktree 隔离）。

## 快速开始

```text
# 1. 建项目（前缀就是任务 key 的前缀）
/issue project create "产品开发" PROD #6366f1

# 2. 建任务（不指定 --project 时落到第一个项目）
/issue create "实现登录页" --priority high --status todo

# 3. 打开看板查看
/issue board
```

> 没有项目时，`/issue create` 会报错提示先建项目；任务 key 形如 `PROD-1`、`PROD-2`，大小写不敏感。

## CLI 命令参考（`/issue`）

### 项目 / 标签 / 文件夹

```text
/issue project create <name> <prefix> [color]   # 建项目，prefix 如 PROD、TASK
/issue project list                             # 列出项目（含 id 和 prefix）

/issue label create <prefix> <name> [color]     # 给项目加标签
/issue label list <prefix>
/issue label delete <prefix> <name>

/issue folder create <name>                     # 建文件夹（按文件夹归组项目）
/issue folder list
/issue folder delete <name>
```

### 任务

```text
/issue create <title> [--project PREFIX] [--priority p] [--status s] [--parent KEY] [--label NAME]
/issue list                                     # 列出第一个项目的前 100 个任务
/issue show <key>                               # 任务详情 + 评论 + 子任务
/issue update <key> [--status s] [--priority p] [--title t]
/issue comment <key> <body>                     # 追加评论
/issue board                                    # 打开 Glimpse 看板
```

示例：

```text
/issue create "修复结账崩溃" --project PROD --priority urgent --status todo
/issue create "拆分订单模块" --parent PROD-12
/issue update PROD-12 --status in_progress
/issue comment PROD-12 已完成主流程，还剩边界用例
```

### 委托与 worktree

```text
/issue delegate <key> [--instructions "..."]    # 委托给 herdr agent 执行
/issue delegate PROD-12 --instructions "先跑测试再提交"
/issue delegate PROD-13 --worktree              # 在独立 git worktree 中工作
/issue worktree-remove <key> [--force]          # 清理已完成的 worktree
```

## Agent 工具（自然语言）

| 工具 | 作用 |
|------|------|
| `task_project_list` | 列出所有项目 |
| `task_project_create` | 建项目（前缀唯一，1-10 位大写字母数字） |
| `task_create` | 建任务（支持子任务 parentTaskKey、标签 labelNames） |
| `task_list` | 过滤查询（projectId / statuses / search / limit） |
| `task_show` | 任务详情 + 评论 + 子任务 |
| `task_update` | 改状态 / 优先级 / 标题 / 描述 |
| `task_board_move` | 移到指定状态列（可选 before/after 排序） |
| `task_comment` | 追加评论（支持 authorName） |
| `task_delegate` | 委托给 herdr agent（可选 worktree 模式） |

## 数据模型

- **状态**：`backlog` → `todo` → `in_progress` → `in_review` → `done` / `canceled`
- **优先级**：`urgent` / `high` / `medium` / `low` / `none`
- **项目**：前缀 + 名称 + 颜色，可挂到文件夹
- **任务**：标题、描述、状态、优先级、截止日期、父任务（子任务）、标签、委托信息
- **委托信息**：agentId、开始时间，worktree 模式额外记录 worktreePath / branch / workspaceId
- **评论**：`user` / `agent` / `system` 三种来源，支持审计

## 数据存储

所有数据存在项目根目录的 git 仓库下（`git rev-parse --show-toplevel`，非 git 仓库时用当前目录）：

```text
<project-root>/.pi/tasks/tasks.json
```

JSON 文件原子写入（临时文件 + rename），加载时用 zod 校验 schema，损坏时报错而非静默。纯文本格式，可直接查看、备份或手工编辑。

## 文件结构

```
extensions/tasks/
├── README.md        ← 本文件
├── index.ts         ← 扩展入口（注册工具 + 命令）
├── contract.ts      ← 数据模型 + zod schema（纯类型，无 IO）
├── store.ts         ← 纯 CRUD 函数（Functional Core，value in / value out）
├── db.ts            ← JSON 持久化（原子读写 + withDb 事务）
├── tools.ts         ← task_* 工具注册（薄壳层）
├── cli.ts           ← /issue 命令
├── delegate.ts      ← 委托编排（prompt 构建 + herdr tab/工作树副作用）
├── paths.ts         ← 项目根目录解析
├── glimpse-host.ts  ← 看板窗口入口
├── ui-html.ts       ← Glimpse 看板/列表/详情 HTML
└── skills/tasks/SKILL.md  ← agent 使用指南
```

## 测试

```bash
npm test -- extensions/tasks/
```

- `store.test.ts` — 纯 CRUD 行为测试
- `delegate.test.ts` — 委托 prompt 构建测试
- `tools.test.ts` — 工具壳层测试（走真实临时 DB 文件）
