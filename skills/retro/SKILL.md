---
name: retro
description: 回看一次编码会话，把改进点落在 agent 的环境上而不是代码上：导航指针、自动检查、编码标准、steering 文件、工具成本、信息获取。Use when 用户说 retro、复盘、这次会话哪里可以更好，或一个 bug 修完后想知道下次怎么避免。
disable-model-invocation: true
---

# Retro

用户要的是一次**复盘**。你提的是对 agent **环境**的改进，不是对这次代码的改进。

默认中文。用户换语言就跟着换。`file:line`、命令、配置原样保留。

## 步骤

1. 先读 `/skill:writing-for-agents`，按它的标准写建议。建议写得能读，才会被采纳。

2. 读这次会话的一手材料。用户指定了就按指定的，没指定就是当前会话。Pi 的会话记录在 `~/.pi/agent/sessions/<cwd 转义>/*.jsonl`，一行一个事件，能查到工具调用、报错、反复读同一个文件。

3. 先判要不要做。**一次性事件不是 learning**：只发生一次、下个会话不会再撞上的事，不要写成规则。会话琐碎、跑题，或者某个 skill 已经正确执行过，就停，直接说这次没有值得落的改进。

4. 按下面几类找候选。每条都要能指到会话里的具体位置。

- **导航**：agent 找对文件花了多久？文件之间有没有藏起来的依赖？加一条**导航指针**能不能省掉这段。_用在_ 找一份信息花了很久的时候。
- **自动检查**：有没有哪种自动检查能抓住 agent 犯的错？lint、类型、测试、文件系统 lint。先读仓库自己的检查命令（`package.json` 的 `lint`/`check`、构建工具的脚本、CI workflow），所以"检查已经存在但没接上或者已经坏了"才是结论，重写一遍不算。仓库**完全没有护栏**（没有 pre-commit hook，也没有跑 lint/typecheck/test 的 CI job）本身就是一条 finding，不是中性默认。_用在_ agent 犯了自动检查能抓的错，或者仓库压根没有护栏的时候。
- **编码标准**：要不要给 review 阶段的 agent 加一条规则？现有规则要不要删或澄清？先给违规分类：**机械型**（固定的语法模式、禁用的 API、import 形状、文件位置规则）一律做成确定性的检查，用仓库自己的 linter 加自定义规则、加 pre-commit hook、或加 CI job，挑仓库语言和现有护栏里最便宜的那种。默认造检查，不写规则。`CODING_STANDARDS.md` 只留给**判断题**（跨文件一致性、"和周围风格保持一致"、任何护栏替代不了的东西）。_用在_ review 阶段没抓住某个错的时候。
- **全局 `AGENTS.md`**：有没有该挪到编码标准（或自动检查）里的 steering 指令？_用在_ `AGENTS.md` 特别大，不管是仓库里的还是用户全局的。Pi 会自动加载 cwd 及父目录的 `AGENTS.md`，所以它每轮都占上下文。
- **工具成本**：agent 有没有做本可以合并的昂贵工具调用？自定义工具（CLI、MCP）里有没有特别费 token 的？_用在_ 某次工具调用明显偏贵的时候。
- **空转指令**：steering 文件里有没有不改变 agent 行为的指令。_用在_ steering 文件又长又难维护的时候。
- **信息获取**：有没有办法让 agent 拿到更多信息。tee 开发服务器日志、给第三方服务只读权限。_用在_ 关键信息拿不到的时候。

5. 会话长、或这次改动风险高、或用户要严格时，把上一步拆成三个互不知情的只读视角并行跑。每个视角一次 `subagent` run，`agent: "reviewer"`，`background: true`，`task` 自包含（子会话看不到本对话）：

- **判断**：这次哪些决定是错的，哪该权衡的地方没权衡。
- **工具**：哪些工具调用是白花钱，哪个 CLI 或 MCP 特别费 token，缺了哪个信息源。
- **发散**：还有哪些做法没试，哪些方案被过早否掉，哪些该问没问。

三个视角各自回报后，同一件事的不同说法合成一条，冲突的写进结论。会话短就自己一遍过完，不派。

6. 每条落进三个桶之一，一次分完：

- **Accepted**：这次就要改。
- **Rejected**：不成立或缺上下文，每条一句原因。
- **Backlog**：成立但现在不做。

凡是能靠 lint、脚本、元数据标记或运行时检查更可靠地挡住的事，从 Accepted 移进 Backlog，并写明检查长什么样。判据见「编码标准」：默认造检查，不写规则。

Accepted 里按严重度排序，每条写清：会话里的证据、改哪个文件、改完能抓住什么。落点按体量分流：

- 一行以内的改动（补一条 bullet、收紧一句、修一个过期事实）：父会话直接改。
- 结构性改动（新的一节、新的对照表、超过十行）：交给 `skill-creator` 走它的 draft / test / iterate 环。
- 只有「该触发时没触发」的 skill：交给 `skill-creator` 走 description 优化环。
- 要新建 skill：同样交给 `skill-creator`，不要在对话里临时发明一个形状。

7. 应用前过门禁。把三个桶完整摆出来，等用户明确挑子集再动手改 skill：skill 的改动影响以后每一个 agent。Backlog 里那些不依赖用户挑的事可以直接落地。

8. 收尾，不带前言：改了的 skill 一条一行；新建的 skill（很少）；落进 Backlog 的；Rejected 的每条一句原因。

## 参考

### 实现与 review 是两个阶段

实现阶段的 agent 上下文压力最大，负责探索、写代码、调试失败。

review 阶段的 agent 上下文压力最小，它拿到的是 diff，不用探索，通常也不用写代码或调试。

所以编码标准由 review 阶段施加，不要压给实现阶段。Pi 里这是两次会话、两个 skill：实现完走 `/skill:review`。

### 仓库里这几类文件

- `AGENTS.md`：进每个 agent 的上下文，要极省，通常只放**导航指针**指向别的文件。
- `CODING_STANDARDS.md`：review 时读，实现时不读。超过 1000 行就加分文件的导航指针。
- `docs/`：当参考文件用，靠别的文件指过去。写新的之前先找现成的。
- `.pi/contexts/**/GLOSSARY.md`、`.pi/plans/**`：领域语言与决策记录，当指针目标用。
- skill：只有描述要进上下文、或者要用户手动敲的命令，才用 skill 形态。写法按 `/skill:writing-for-agents`。

## Attribution

Adapted from the `retro` skill in https://github.com/mattpocock/skills (v1.3.1) under the MIT License. Pi 适配：中文默认、会话记录路径、`.pi/` 路径约定、review 阶段由 `/skill:review` 承担、去掉 Claude 专用 tool 名与 `agents/openai.yaml`。

第 3 步的跳过条件、第 5 步的三视角、第 6 步的三桶与落点分流搬自 pstack 的 `reflect` skill（https://github.com/cursor/plugins，MIT），按本仓改写成 `subagent` profile 与 `skill-creator`。
