# poteto-playbooks 进口组

上游是 `cursor/plugins` 的 `harness/pstack` 0.15.30 里 poteto 入口那一组。只进口判断，不进口 harness。入口是 `prompts/poteto.md`，本组不参与模型路由。

## 包含什么

| 路径 | 状态 |
|---|---|
| `playbooks/*.md` | 7 份 P0 步骤清单，中文改写，去掉了 harness 词与上游模型名 |
| `references/review-comment-triage.md` | 上游评审意见分诊文档的中文改写，改名去掉产品名，修 / 驳回 / 追问三段保留 |
| `SKILL.md` | 执行侧的索引与用法，模型按需读 |

## 上游哪个文件进了哪里

`scripts/poteto-kernel-map.json` 是唯一判定表，32 行逐文件写 `verdict`、`tier`、`landing`、`note`。去留看 `verdict`，理由看 `note`。矩阵由脚本现场生成，不要另写一份。

`verdict` 是三态：`已有替代`（指向本仓现有 skill）、`缺`（按 `tier` 分级进口）、`不搬`（harness 绑定或撞入口 §9）。`landingKind: "env"` 表示落点在仓库外，靠 `skills/skills.txt` 声明后安装，`--check` 不查盘。

## 改这份目录之后

```bash
node scripts/poteto-kernel-gap.mjs --check
node scripts/poteto-kernel-gap.mjs --check-routes prompts/poteto.md
npx vitest run scripts/poteto-kernel.test.ts scripts/poteto-kernel-gap.test.ts
npx tsc --noEmit
```

`--check` 逐行核对落点文件是否存在。`--check-routes` 核对入口正文里每个 `playbook:` 引用与本目录里的文件一一对齐，悬空与孤儿都会报错。

## 加一个 playbook

1. 在 map 里把该行的 `tier` 改成 `P0`，`landing` 写 `skills/poteto-playbooks/playbooks/<name>.md`。
2. 落文件，frontmatter 只留 `name`（与文件名相同）与 `description`。
3. 去掉 harness 词，`principles:` 只引用 `skills/pstack/principles/references/` 里存在的 id。
4. 在 `SKILL.md` 的表里加一行，在 `prompts/poteto.md` §1 里加 `playbook: <name>`。
5. 跑上面四条命令。测试的期望集从 map 推导，不需要改测试。
