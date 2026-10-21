---
name: maintain-verification-skill
description: "周期审计项目级验证 skill 与 feature map：每 feature 一个只读源读者，协调者逐条实跑，最多产出一个只含已证明修正的 PR。Use for /maintain-verification-skill，或 '审计 verify skill'、'feature map 过期了'。"
disable-model-invocation: true
---

# Maintain a verification skill

应用一变，feature map 就开始腐烂。这个 skill 是 `/create-verification-skill` 产物的维护环（也适用于任何带 feature map 的项目级验证 skill）。严谨的单位是 feature，不是每句话：每个 feature 文件都要有源覆盖与实跑覆盖，但不用把每条 bullet 都终端化。

## 结果

选一个，并说明是哪个：

- **clean**：每个 feature 都有源覆盖与实跑覆盖，没有值得提交的修正。不开分支，不开 PR。
- **changed**：一个 PR，只含已证明的文档、harness 或 map 修正。
- **blocked**：覆盖没跑完，或已证明的修正无法安全提交。写清被什么挡住。

## 编辑范围

只改验证 skill 自己的目录（它的 `SKILL.md`、`features/` 和它拥有的 harness 脚本）。运行期间不改产品代码：地图描述的行为应用已经不做了，要么是文档漂移（修 map），要么是产品回归（报告，不要在文档里糊过去）。

## 过程

0. **定位目标。** 找要维护的验证 skill：正文有 launch / drive 节且带 feature map 的项目级 skill（通常是 `.pi/skills/verify-*/`）。多个候选就问是哪一个；没有就停下，指向 `/create-verification-skill`，不要凭空造一个目标。

1. **索引卫生。** 读 feature map 的 README，glob 同级文件。修缺失、多余、重复、死链。轻量做，不生成 inventory。

2. **源波。** 每个 feature 文件一个只读 `subagent`，`agent: "explore"`。最多 4 个并发；超过 4 个分批，前一批收完再发下一批。每个只回答「这个用户可见功能从源码看怎么工作」，标出可能的文档漂移并给引用，返回一条简洁的实跑 recipe。子会话不驱动应用、不改文件。返回形状：feature summary / source entry points / likely drift or none / one recipe。

3. **对账。** 每个 feature 文件都要有返回的 summary。重叠的 recipe 合并成尽量少的应用状态。抽检被引用的漂移，不重证干净的声明。扫最近 churn 里地图漏掉的用户可见面；要指出缺失，先给出具体源码路径。

4. **实跑。** 即使源看起来干净也必须跑。协调者独占驱动；按验证 skill 自己的 launch 模型：server 与 UI 用一条长驻实例串行驱动，短命 CLI 每次 drive 用新的隔离会话（由 skill 的 Launch 节决定，不是这里）。每个 feature 至少走一次，全程守三条不变量：(1) 没做过健康检查的实例不驱动：首次 drive 前、每个新会话的单元前、任何失败 drive 后都要 doctor；doctor 看不到的失败（进程健康但 UI 卡死）就 reset 到已知状态或重启，不要赌；(2) 已留的证据要活过每次 cleanup，去指定位置确认，不假设；(3) 一次 drive 起的任何东西都不能活过它的有效期：失败迭代残留无论会话卡住、退出还是共享都要清（共享实例清残留，不清实例）。doctor 失败若是 skill 漂移，按编辑范围修，重试一次，只重启被修的东西；再失败就判 `blocked`。一个 feature 到不了，只有在给出具体前置条件（鉴权、权益、OS、外部状态）与尝试过的路径后才算 `verified-unreachable`；地图漏了这个前置条件就是漂移。triage 出的 harness 修正要先实跑通过再提交。最终 teardown 放在本轮最后一次 drive 之后，包括那些重证，确保没有东西活过本轮（证据按 skill 的规则留下）。

5. **Triage。** 用户视角描述错了或缺失 → 文档漂移，修。行为正常但 harness 驱动不了 → harness 缺口，修；harness 修正遵守与生成时相同的 helper 规则（脚本可执行，调用方式写在正文）。应用行为真的坏了 → 产品缺口，记给用户，不放进这个 PR。

6. **提交或停下。** `changed`：一个只含已证明修正的 PR，提交前重读每个改过的文件；按 `git remote -v` 选 `gh` 或 `glab`。`clean` 或 `blocked`：不开 PR，如实报告结果与覆盖。

运行笔记放 scratch 位置，保持简洁（覆盖了哪些 feature、不可达前置、确认的漂移、结果）；不要提交。
