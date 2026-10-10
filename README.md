# pi-custom-provider

在 [Pi](https://pi.dev) 的终端界面里管理自定义中转模型，全程点选、零手改配置文件。

之前加一个中转要手动编辑 `~/.pi/agent/models.json`：填 `baseUrl`、`api`、`apiKey`、`models`，抄错一个字段就调不通。这个插件把整个过程变成 TUI 向导——输名字、填地址、选接口、贴 Key，模型列表自动从中转拉下来，回车确认即用。

## 特性

- 🧙 **TUI 向导**：`/relay-add` 四步完成（名字 → 地址 → 接口 → Key → 选模型），`select / input / confirm` 全键盘操作
- 📥 **模型自动拉取**：`GET {baseUrl}/models` 自动发现模型（OpenAI / Gemini 两种格式），列表确认时**直接回车即第 1 个**，也可继续多选、全选或手动追加；Anthropic 兼容等无该端点的自动回落手动填写
- ⌨️ **参数式可用**：`print / json` 非交互模式下用 `--name --baseUrl --api --key --models` 参数一次写完
- 🔑 **Key 三存法一次输完自动识别**：`$ENV` 引用（推荐）/ 明文（二次确认才落盘）/ `!command`（请求时执行）
- 🛡️ **只动自己的地盘**：仅管理 `relay-*` 命名空间，不碰任何内置 provider；每次写文件前自动备份 `models.json.bak`
- 🧠 **记住上次**：Base URL 和接口类型自动复用上一次的，加第二个中转更快
- 🔌 **装完即模型**：保存后本 session 立即可用，去 `/model` 里直接能选到

## 安装

```bash
# 方式一：从 GitHub 安装（推荐）
pi install git:github.com/unifare/pi-custom-provider

# 方式二：本地试用（改完即测，不写配置）
pi --extension ./extensions/relay.ts
```

装完进 Pi 就多出 6 个命令：`/relay /relay-add /relay-list /relay-use /relay-del /relay-test`。

## 快速上手

```text
/relay-add
# 1. 中转名字（自动加 relay- 前缀，如 my-relay → relay-my-relay）
# 2. Base URL（第二次起可直接回车沿用上次）
# 3. 接口类型（7 选 1，见下表，回车即第一个）
# 4. API Key（$MY_KEY / 明文 / !command 一次输完自动识别）
# 5. 模型列表自动拉取 → 直接回车取第 1 个，或继续多选 / 全选
# 6. 脱敏预览确认 → 保存

/model
# 选到 relay-my-relay/xxx，开用
```

## 接口类型

| 值 | 适用 |
|---|---|
| `openai-completions` | 绝大多数中转 / Ollama / vLLM / LM Studio / SGLang |
| `openai-responses` | OpenAI Responses 兼容中转 |
| `anthropic-messages` | Anthropic Messages 兼容中转 |
| `google-generative-ai` | Google Gemini 兼容中转 |
| `google-vertex` | Google Vertex AI 兼容中转 |
| `azure-openai-responses` | Azure OpenAI 兼容中转 |
| `mistral-conversations` | Mistral 兼容中转 |

## 命令详解

```text
/relay                          # 主菜单：新增 / 列表 / 切换 / 测试 / 删除
/relay-add                      # 新增（TUI 向导；非 TUI 用参数式，见下）
/relay-list                     # 列表，选中后可切换 / 测试 / 删除
/relay-use relay-id [model-id]  # 切换到某中转模型
/relay-test relay-id            # 测连通性（调 /models 端点并报模型数）
/relay-del relay-id              # 删除（models.json.bak 留备份）
```

参数式（`--print / --mode json` 下同样可用）：

```bash
pi --print "/relay-add --name my-relay --baseUrl https://api.example.com/v1 \
  --api openai-completions --key \$MY_RELAY_KEY --models gpt-5.4,claude-sonnet-4-6"
```

## 它改了你机器上的什么

| 文件 | 说明 |
|---|---|
| `~/.pi/agent/models.json` | 写入 `providers.relay-*`（source of truth，可随时手改，`/model` 打开即重载） |
| `~/.pi/agent/models.json.bak` | 每次写入前的自动备份 |
| `~/.pi/agent/relay-state.json` | 仅记上次用的 Base URL 和接口类型，无密钥 |

Key 安全建议：优先用 `$ENV_NAME` 引用环境变量；明文会二次确认才落盘，列表里只显示后 4 位；`!command`（如密码管理器）在每次请求时执行、不落盘。

## 常见问题

- **新增后 `/model` 里找不到？** 打开一次 `/model`（触发重载）再试；或直接 `/relay-use relay-id`。
- **`/relay-test` 说无 `/models` 端点？** Anthropic 兼容中转一般没有该端点，属正常，直接 `/model` 选模型试用即可。
- **只想改 Key 或增减模型？** 先 `/relay-del` 删掉再 `/relay-add`（地址可回车沿用）；`/relay-edit` 在路线图里。
- **只读写 global 配置**，project 级 `.pi/models.json` 暂不管（见 [PLAN.md](./PLAN.md) 决策记录）。

## 开发

```bash
npm install
npm test        # 21 项 headless 功能测试（真写临时目录、不碰真实配置）
npm run typecheck
```

实现只有 `extensions/relay.ts` 一个文件（标准 Pi Package 结构，见 `package.json` 的 `pi.extensions`）。

## License

MIT
