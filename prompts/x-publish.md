---
description: 把今天学到的一条信息发到 X（Twitter）：写文案 + 配图 + 预发布预览 → 用户确认 → opencli 发帖 → 反查核实
argument-hint: "[主题词 | 素材路径] [--draft-dir <dir>] [--no-image] [--en]"
---
把一条值得说的信息发到 X，**先给预发布的样子，确认后才发**。
走 `opencli` 的 X/Twitter 适配器（UI 策略，复用我的登录态），一条推文 = 一段文案 + 一张配图。

## 参数

- 第一个参数（可选）= 主题词 / 素材路径 / 指定要发的那一条；没给就按阶段 1 自己挑。
- `--draft-dir <dir>`：换草稿目录（默认 `~/work/notes/.pi/x-drafts/`）。
- `--no-image`：纯文字帖——跳过阶段 3，其余流程不变（文案要自己扛住信息量）。
- `--en`：在中文稿之外再出一版英文文案（默认只发中文）。

## 硬性规则（违反即返工）

1. **先预览再发**：文案 + 图必须先在对话里给我看，等我说「发」才动手。不要自己判断"差不多了"就发。
2. **发完必须反查**：无论 `post` 报成功还是报错，都要用 `opencli twitter tweets --limit 1 -f json` 核实真的发出去了（文本一致 + `has_media: true` + 拿到 `url`）。
3. **报错先查再重试**：`post` 失败不等于没发出去。先反查，确认没发才能重来；永远不要因为一次报错就发第二条。
4. **不许编**：文案里的数字、源码位置、结论都要来自真实素材（笔记 / 源码 / 文章），查不到就换一条素材。

## 草稿目录

默认 `~/work/notes/.pi/x-drafts/`（`--draft-dir` 可覆盖）：

- `tweet.txt` — 最终文案（发帖时 `cat` 出来用，避免 shell 转义问题）
- `YYYY-MM-DD-image.svg` — 配图源（手写 SVG）
- `YYYY-MM-DD-image.png` — 栅格化后的图（1600×900，真正上传的那个）
- `preview.html` — 只有在我说要 HTML 预览页时才写（见阶段 4）

先 `mkdir -p` 草稿目录。

## 阶段 0：环境预检

```bash
opencli twitter whoami            # 必须 logged_in: true，否则先让我跑 opencli twitter login
opencli twitter post --help       # 确认签名：post <text> --images [paths]（逗号分隔，最多 4 张，jpg/png/gif/webp）
```

发帖人账号用 `whoami` 的结果（不要写死），并 `mkdir -p` 好草稿目录（见下）。

## 阶段 1：选题

- 我给了主题词或素材路径 → 直接用，先读素材原文，别凭记忆写。
- 没给 → 从**今天真正学到的东西**里挑（本会话的笔记、`qmd` 检索到的近期笔记、今天读过/调试过的源码）。
- 挑的标准：**一句话能说清的反直觉点**，有具体数字或出处可引。
- 同时报 2~3 条候选，并说明你选了哪条、为什么；我不满意可以直接换。

## 阶段 2：写文案

结构（中文推文，260~280 权重内）：

- 第 1 行：钩子，一句话说清"哪里反直觉"（带主题词，便于检索）
- 第 2~3 段：具体事实 + 关键数字对比（用 `——`、`→` 这类符号压缩字数）
- 末段：出处（`（internal/runtime/maps · split）` 这种）+ 1 个 hashtag

**字数权重**：X 把 CJK 字符按 2 计，上限 280。写 2~3 个变体，用同一段脚本比权重再选：

```bash
python3 - <<'EOF'
def weight(t):
    w = 0
    for ch in t:
        o = ord(ch)
        if (0x1100 <= o <= 0x11FF) or (0x2E80 <= o <= 0xA4CF) or (0xAC00 <= o <= 0xD7A3) \
           or (0xF900 <= o <= 0xFAFF) or (0xFE30 <= o <= 0xFE4F) or (0xFF00 <= o <= 0xFF60) \
           or (0xFFE0 <= o <= 0xFFE6) or (0x20000 <= o <= 0x3FFFD):
            w += 2
        else:
            w += 1
    return w

for name, c in [("c1", """..."""), ("c2", """...""")]:
    print(name, "weight=", weight(c), "chars=", len(c))
EOF
```

权重是近似值（X 对链接另有折叠规则），**留 10~20 的安全余量**；超了先砍形容词，别砍数字和出处。
定稿写入 `tweet.txt`。我要是说"英文版"（或带了 `--en`），就再出一版等价的英文文案——英文逐字符计 1，同样的 280 上限。

## 阶段 3：配图

`--no-image` 时整段跳过，直接进阶段 4。

一张图讲一件事：**左边"直觉以为的"，右边"实际发生的"** 这类对比图最好用。

图的标准：

- 手写单文件 SVG，无外链、无 JS、无 `<image>` 位图
- `viewBox="0 0 1600 900"` + `width="1600" height="900"`
- 深色底 + 大字，字号按"手机上缩到一半也能看清"来定；一屏一个观点，不堆细节
- 字体写死 `font-family="PingFang SC"`（本机实测能正常出中文）
- 坐标/字号/行位置全部手算：一行一个 `<text>`，不依赖自动换行——字宽按 1em/字估
  （中文一个字≈1em），长句就手动拆行，叠字和溢出是这种画法唯一真正的坑
- 源文件 `<草稿目录>/YYYY-MM-DD-image.svg`，图 `<草稿目录>/YYYY-MM-DD-image.png`

出图（Chrome headless 直接把 SVG 栅格化，macOS 默认路径）：

```bash
D="$HOME/work/notes/.pi/x-drafts"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1600,900 --screenshot="$D/<date>-image.png" "file://$D/<date>-image.svg"
```

X 只收位图（opencli 适配器只认 jpg/png/gif/webp），所以 **`.svg` 只是中间格式，上传的永远是 PNG**。
本机 ImageMagick 的 SVG 路径不可用（`rsvg-convert` 没装、内建渲染器报 `unable to read font`），
别用 `magick` 转，直接用上面的 Chrome。

配图是流程图时才考虑 `validate_mermaid` / `render_mermaid`；正文对比图一律手写 SVG（坐标可控、可复现）。

## 阶段 4：出预发布预览，等确认

直接在对话里给：

- 文案原文（代码块，含空行，方便我逐字看）
- `未发布 | 字数权重 <N> / 280 | 图片 <W>×<H>`（`--no-image` 时写"无图"）
- 有图就用系统默认程序打开：`open "$D/<date>-image.png"`
- 顺便说明还有哪些候选素材可以换

**默认不写 HTML 预览页**——我说"要 HTML 预览"时，才写 `preview.html`（X 卡片样式）并用
`terminal-browser open ./preview.html --split right --size 0.5` 开在侧栏，看完 `terminal-browser action done`。

然后**停下等确认**，不要顺手发。

## 阶段 5：发帖

```bash
D="$HOME/work/notes/.pi/x-drafts"
TEXT="$(cat "$D/tweet.txt")"
echo "== 将要发出的文案 =="; printf '%s\n' "$TEXT"
opencli twitter post "$TEXT" --images "$D/<date>-image.png" --window background -f yaml
```

`--window background` 是为了不抢焦点；排查问题时可换 `--window foreground`。
`--no-image` 时去掉 `--images`。

## 阶段 6：反查核实（必做）

```bash
opencli twitter tweets --limit 1 -f json        # 文本 / has_media / media_urls / url
```

- 文本一致 + `has_media: true` → 报成功，把 `url` 给我。
- `has_media: false` 或图没挂上 → 视为失败：删掉重发（`opencli twitter delete <url>`），或先说明原因再问我。
- 想确认图没被压坏，把实际挂的图拉回来目检：
  ```bash
  curl -sSL "<media_url>?name=orig" -o /tmp/posted-media.jpg && file /tmp/posted-media.jpg
  ```
- 收尾报告：帖子 URL + 核实依据（`has_media` / 反查命令）+ 草稿路径 + 中途做的任何环境改动。

## 已知坑

| 症状 | 含义 | 处理 |
|---|---|---|
| `Page.fileChooserOpened not received within 5s` | 浏览器桥的 CDP 上传超时，适配器该走 base64 降级却没走 | 先看扩展版本（`opencli doctor`）。v1.0.x 的临时办法：`clis/twitter/utils.js` 的 `isRecoverableFileInputError` 正则加 `\|filechooseropened\|not received`，**先备份原文件**；治本是升级浏览器桥扩展到 v1.6+ |
| `TIMEOUT: twitter post timed out after 15s` | 只是它自己的确认轮询超时，**帖子很可能已经发出** | 立刻 `opencli twitter tweets --limit 1 -f json` 反查；已发出就当成功 |
| 想抓失败现场 | — | `opencli twitter post ... --trace retain-on-failure`，再按 opencli-autofix 的流程处理 |

跨会话我该主动说清：任何对全局 npm 包的本地补丁，都要在收尾报告里写明备份路径和"重装即还原"。

## 收尾

- 草稿留在 `<草稿目录>`，告诉我路径，方便换个角度再发一条。

User request: $@
