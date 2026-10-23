# 评审意见分诊

用在收尾阶段处理评审机器人或自动安全评审留下的评论。目标不是默认忽略它们，是不再把每条评论都当成必须改的代码改动。

## 判定三分

动手之前先给每条评论归一类。

- `fix`：评论指出了一个可能成立的正确性、安全、隐私、数据丢失、鉴权、计费、迁移、幂等、竞态或已发布行为问题。在最靠上游的那个 PR 里修掉，回复提交 SHA 并解决该评论。
- `dismiss`：评论命中一条已记录的低风险噪音模式，且当前代码与上下文能证明不需要改代码。回一句简短理由并解决该评论。
- `ask`：评论新颖、严重度高、涉及安全或隐私或数据，或语义含糊。问人，不要猜。

拿不准时问。放过一条代码风格噪音很便宜，放过一个真的数据或安全问题不便宜。

## 新模式的记录格式

以后新增模式照这个形状写。

```markdown
### <模式短名>

- Confidence: candidate | recurring | strong
- Skip when: <必须同时成立的条件>
- Do not skip when: <风险边界>
- Example signal: <能识别该模式的措辞或代码上下文>
- Source: <PR 或评论链接，或一句历史note>
```

一两个例子用 `candidate`。多次真实驳回之后用 `recurring`。只有模式窄、反复验证过、风险低时才用 `strong`。

## 反复出现的可驳回模式

### 有意为之的界面或设计系统视觉改动

- Confidence: candidate
- Skip when: PR 描述、截图、设计评审或邻近代码把这次视觉改动写得明确，评论只是在重述某个共享视觉默认值变了。
- Do not skip when: 评论指向可访问性、焦点可见性、键盘导航、对比度，或本次 PR 并未有意修改的组件 API 契约。
- Example signal: 关于焦点轮廓、按钮尺寸、间距、共享组件视觉默认值的评论，而 owner 回复过「intentional」「intended」。

### 上游或栈内用法评审看不到

- Confidence: candidate
- Skip when: 评论说某个导出、组件、helper 或文件没人用，而当前 forge 的 PR 列表、栈中靠后的 diff 或 PR 上下文显示后面的 PR 会用到它。
- Do not skip when: 该 PR 不在栈里，符号是公开 API，或所谓上游用法无法验证。
- Example signal: 「Exported component is never used」配上人类回复「used upstack」。

### 并行实现期间的临时重复

- Confidence: candidate
- Skip when: PR 有意重复一小段代码，让新路径与正在删除、替换或验证的旧路径并存。
- Do not skip when: 重复的代码影响安全、计费、数据访问、API 行为，或长期共享抽象明显降低风险。
- Example signal: 评论说「Significant duplication」，而 owner 说明旧路径会删掉或重复逻辑是有意局部化。

### 框架或组件不变量已经覆盖该告警

- Confidence: candidate
- Skip when: 该关注点已被共享组件、框架契约、类型不变量或单一真相源保证，且在当前 diff 或邻近代码里可见。
- Do not skip when: 不变量只是被假定而没有强制，或依赖时序，或跨异步与状态边界取值会分叉。
- Example signal: 评论说内层浮层缺 max-height，而共享浮层已经限制视口；或说某值可能为空，而本地检查过的值与传下去的值同源。

### Owner 已声明留作后续

- Confidence: candidate
- Skip when: PR owner 明说这是已知后续项，当前 PR 没有让行为变差，且评论不涉及高风险区域。
- Do not skip when: agent 在没有 owner 输入时自行放行，问题属于中高严重度的产品行为，或推迟等于合并一个新回归。
- Example signal: 「I'll worry about that later」「we'll delete this eventually」。

### 评审自己撤回或明确误报

- Confidence: recurring
- Skip when: 评论正文或该评审后来的回复明确说该发现已撤回、已合规或属误报，且 agent 能在本地核实相关规则。
- Do not skip when: 唯一证据是有人在高风险问题上说「mistake」而没有解释。
- Example signal: 文件名规则类评论，其正文自己说该文件已合规。

## 默认必须问的类别

即使前面的 PR 驳回过多条类似评论，这些也不自动跳过。

- 安全、隐私、鉴权、计费、数据留存、训练数据、权限边界类发现。
- 高严重度发现。
- 迁移、表结构、幂等、并发、跨系统行为类发现。
- 建议改动很小且明显降低风险、又不改变产品意图的评论。

历史数据说明人有时会驳回安全与数据流类评论。把那些当 owner 判断，不要变成团队级跳过规则。

## 值得沉淀的候选经验

下面几条看着团队级有用但还不够成熟。多个 PR 确认之后再提升到上一节。

### 契约测试漂移的指控一条命令就能验

- Confidence: candidate
- Skip when: 验证本身永远不要跳，它只花一条命令。PR 里带了钉住协议或文档措辞的契约测试（对文档正文做正则、对措辞做快照），而评审说「测试已经和文档对不上」时，先在 PR tip 上跑那个测试再分类。红跑等于经验性确认，绿跑就是驳回回复里的具体反证。
- Do not skip when: 不适用，这是验证捷径而不是驳回模式。注意连续多轮的「倾向驳回」启发式在这里会误伤，正是因为前面的修复轮改了正文，钉住正文的测试才会漂移。
- Example signal: 「Contract test omits the pre-fix wait」，而该 PR 前几轮修复改写了被钉住的那段。

### 同一 PR 后来已经修掉的过期发现

- Confidence: candidate
- Skip when: 自动安全评审说缺某个鉴权或校验调用，而当前 PR tip 明显包含那道闸（且带测试），通常是评审跑完之后又加的硬化提交。
- Do not skip when: 被引用的 helper 对该主体是空操作，检查发生在它守护的副作用之后，或所谓覆盖对该主体并不存在。
- Example signal: 一条 HIGH 的「missing authorization check」，而 tip 上那道 guard 已经在副作用之前调用。

### 把刻意收窄的错误条件放宽会盖住真实错误

- Confidence: candidate
- Skip when: 评论要求把一个收窄的错误条件（特定 errno、错误码或状态类）放宽成一把抓，而那份收窄编码了真实区分。典型形状是按 `ENOENT` 收口的依赖回退，「二进制没装」与「命令跑了但失败」是两种情形。
- Do not skip when: 收窄条件漏掉同一类里的情形（另一个「二进制不可用」的 errno 如 `EACCES`），未处理路径会丢数据或留半状态，或重试幂等且仍上报原始错误。
- Example signal: 「只在该错为 ENOENT 时才回退，即使存在可用的另一个实现也不试」，指向的是为缺失依赖而不是为失败操作准备的回退。

### 重复出现的人工重造原语

- Confidence: candidate
- Skip when: 几乎不要跳。diff 用人工实现替换原生行为（原生滚动换成 JS 定位克隆、原生滚动目标换成转发的滚轮与触摸事件、绘制层遮挡换成遮罩），这类代码上的逻辑缺陷发现一直是真的。
- Do not skip when: 发现落在事件转发的缺口（滚轮 deltaMode、触摸拖动、边缘滚动链、点击容差）、遮罩命中判定分叉，或观察者与框架状态之间的时序竞态。默认修。
- Example signal: 「masks do not affect hit-testing」「overlay blocks wheel scroll」「ignores deltaMode」。
