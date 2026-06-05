# opencli adapters

本项目自定义的 [opencli](https://github.com/jackwener/OpenCLI) 适配器集合。


## 前置要求

- Node.js >= 21
- `opencli` 已全局安装：`npm install -g @jackwener/opencli`
- Chrome + [OpenCLI 扩展](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk)（浏览器型 adapter 需要）

## 安装

```bash
# 将所有 adapter symlink 到 ~/.opencli/clis/ 下
make install-opencli-adapters

# 或作为完整安装的一部分
make install
```

安装脚本会遍历 `clis/` 下的所有 `<site>/<cmd>.js`，为每个文件在 `~/.opencli/clis/<site>/<cmd>.js` 创建 symlink。

## 可用适配器

### space/user-token

获取 Space 当前用户的 JWT token。

```bash
# 输出 token 到 stdout（默认 YAML 格式）
opencli space user-token

# 纯文本格式
opencli space user-token -f plain

# 写入文件（同时 stdout 输出）
opencli space user-token --write ~/.space/token
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `--write <path>` | string | 将 token 写入指定文件 |
| `-f, --format` | `plain\|json\|yaml` | 输出格式 |

**数据源：** `localStorage["session"].token`（JWT）

**策略：** UI（依赖 Chrome 浏览器，需要已登录 SPACE）

## 添加新适配器

1. 新建目录和适配器文件：

```bash
mkdir -p opencli/clis/<site>
# 编写 opencli/clis/<site>/<command>.js
```

2. 参考已有的 `space/user-token.js` 或使用 opencli 骨架生成：

```bash
opencli browser init <site>/<command>
# 将生成的 ~/.opencli/clis/<site>/<command>.js 复制到 pi-kit 目录
```

3. 安装并验证：

```bash
make install-opencli-adapters
opencli validate <site>/<command>
opencli browser verify <site>/<command>
```

适配器标准参考：[opencli-adapter-author](https://github.com/jackwener/OpenCLI/blob/main/docs/skills/opencli-adapter-author/)

## 模块解析

`opencli/package.json` 声明了 `"type": "module"`，确保适配器文件被 Node.js 识别为 ESM。
`@jackwener/opencli` 是 pi-kit 的 devDependency，安装后可从 `pi-kit/node_modules/` 解析适配器的 `import` 语句。symlink 到 `~/.opencli/clis/` 后即可被 opencli 发现和加载。
