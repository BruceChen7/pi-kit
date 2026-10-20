---
name: no-comments
description: "清掉一次 diff 里的注释：第一遍只读产 flags 表，第二遍才删和做最小根因修。只留 license、公共 API 契约、外部依赖强制的行为，以及解释约束的 issue/RFC 链接。Use when 收尾前 diff 里注释多、看到注释掉的代码或借口式说明，或用户说 'no comments' / '清一下注释'。"
disable-model-invocation: true
---

# No comments

注释只留代码表达不了的 why。其余删掉。删不掉的，说明代码该改。

默认用中文交付。范围默认是当前分支相对 base 的 diff，含工作区。调用方给了文件或 diff 就用它。找不到 base 时用 `git diff HEAD`，并在报告里写清用了哪个范围。

## 一、第一遍：只读，不改

先看 diff，不动任何文件。产一张表，每行必须带 `file:line`；没有行号的行作废。

| file:line | 判定 | 理由 |
|---|---|---|
| `handler.go:42` | KILL | 复述代码 |
| `api.ts:7` | KEEP | license header |
| `db.go:88` | MUST KILL | 抑制掩盖了缺失的 nil 检查 |

只有三种判定：

- **KEEP**：命中 keep list。
- **KILL**：直接删，不动代码。
- **MUST KILL**：注释在替坏代码打掩护。删注释，标出符号，给一个动作：rename / extract / type / rearchitect。

表没写完不许改文件。先出表，再动手。

## 二、Keep list

- Legal or license headers.
- Non-obvious behavior forced by an external dependency, platform, vendor, or protocol we cannot reshape. Surprises in our own code are meat. Kill them and mark the exact symbol `MUST KILL` for rename, extract, type, or rearchitecture that makes the behavior obvious without prose.
- `// prettier-ignore`. Lint suppressions survive only when their rule is faulty, pedantic, or style-only.
- Doc comments that define a public API contract.
- Issue or RFC links that explain a constraint code cannot express.

不确定某条是否命中，就删。删掉的注释不还原，除非能指出上面某一条并给出范围内的事实。

## 三、抑制是注释

| 语言 | 写法 | 判定 |
|---|---|---|
| TS/JS | `@ts-ignore`、`@ts-expect-error`、`eslint-disable` | 掩盖真 bug 或正确性问题：删抑制，标 `MUST KILL`。纯风格：留 |
| Go | `//nolint`、`//lint:ignore` | 同上。`//nolint` 必须写具体 linter 名，裸写按 KILL 处理 |
| shell | `# shellcheck disable` | 同上 |

判断标准不是「作者写了理由」，是「理由今天还成立，且代码自己说不出来」。

## 四、第二遍：才动文件

1. 先删 KILL。
2. `MUST KILL` 的符号：`grep` 调用点，需要形状时用 `/skill:codebase-design` 出三行草案，再做最小根因修。修不动或超出范围，记为 open，不硬改。
3. 不改范围外的代码，不顺手重排，不把长借口改成短借口。
4. 删完如果行为不再显然，用命名、类型或断言表达，不要写新注释补回来。

`MUST KILL` 会改应用代码，所以改完重跑测试，把命令与输出贴进报告。

## 五、约束注释

`do not remove`、`不要改这段`、`改之前问 X`：先按 keep list 找证据。证据成立就留；不成立就删，并给一条编码建议（type / test / lint / CI）。

只问一次，放在收尾。无人值守时按调用方预授权；没有预授权就删注释，把未落地的约束记为 open。

## 六、报告

- 删除数。
- flags 表，保留 `file:line`。
- `MUST KILL` 列表：一行一个符号加建议动作。
- 编码提议：提了什么，落地了没有。
- 重跑的测试命令与结果。
- open 项：没修的根因、没落地的约束。

恢复的注释默认为 0。出现就必须带例外条款和证据。
