# pi-custom-provider

在 Pi 的 TUI 里管理自定义中转 API，不用手改 `models.json`。

> 当前状态：M1 已实现（`extensions/relay.ts`），待真机验证。方案见 [PLAN.md](./PLAN.md)。

## 安装

```bash
pi install git:github.com/<you>/pi-custom-provider
# 本地试用
pi --extension ./extensions/relay.ts
```

## 用法

```text
/relay         # 主菜单：新增 / 列表 / 切换 / 测试 / 删除
/relay-add     # 新增中转（TUI 5 步向导；print/json 模式用参数式）
/relay-list    # 列表，选中后可切换 / 测试 / 删除
/relay-use relay-id [model-id]   # 切换模型
/relay-test relay-id             # GET {baseUrl}/models 测连通
/relay-del relay-id              # 删除（自动备份 models.json.bak）
/model         # 新增后在这里选到 relay-id/model-id
```

约定：

- 只管理 `relay-*` 命名空间，不碰内置 provider；写前备份 `models.json.bak`。
- 接口类型 7 选 1：`openai-completions / openai-responses / anthropic-messages / google-generative-ai / google-vertex / azure-openai-responses / mistral-conversations`。
- Key 三种存法：`$ENV` 引用（推荐）/ 明文（二次确认）/ `!command`。
- 只读写 global（`~/.pi/agent/models.json`）。
