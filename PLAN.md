# pi-custom-provider — 方案 (PLAN)

> 2026-10-10 决策冻结：包名 `pi-custom-provider`；api 7 选 1 全给；允许明文（二次确认）；MVP 只做 global。

> 目标：**在 Pi 的 TUI 里配好自定义中转 API**，全程 `select / input / confirm`，零手动改文件。

## 1. 现状（为什么需要插件）

- Pi 原生只支持：`/login`（内置 provider 存 key）、`/model`（选模型，顺带重载 `models.json`）、`/settings`（改偏好）。
- 自定义中转（OpenAI / Anthropic / Google 兼容地址）今天必须手改 `~/.pi/agent/models.json`：填 `providers.{id}.baseUrl / api / apiKey / models`。
- 原生 TUI 没有“新增 provider 向导”表单。

## 2. 插件形态

- 标准 **Pi Package**：`package.json` + `pi.extensions` + `extensions/relay.ts`，支持 `pi install git:... / npm:... / ./local` 三种安装。
- 单文件起步（MVP ~300 行），多文件后再转 `extensions/relay/` 目录。
- 调试：`pi --extension ./extensions/relay.ts`，发布后走 `pi install`。

## 3. 技术路线（推荐 A）

### 方案 A — 配置层（推荐，MVP 做这个）

- 插件**只读写 `models.json`**，复用 Pi 内置的 `openai-completions / openai-responses / anthropic-messages` 等实现，**不写 `streamSimple`**。
- TUI 向导收集完直接写 `providers.{relayId}`，写完 `notify` 提示跑 `/model`（`/model` 打开即重载文件，即时生效）。
- 优点：代码少、完整继承官方的 tool streaming / usage / retry / compat 行为、好维护。
- 局限：模型 ID 需用户填写（中转的 `/models` 发现放到 M2 做加分项）。

### 方案 B — 运行时 Provider（进阶，可选）

- `pi.registerProvider(relayId, {...})` + `session_start` 全量注册 + 自有 `relay-profiles.json` 持久化 + `refreshModels` 做模型发现 + `unregisterProvider` 做删除。
- 优点：注册即生效、无需 `/model` 重载、可动态拉取模型列表。
- 代价：要处理与 `models.json` 合并、auth 优先级、持久化快照，复杂度 x3。放到 M4。

**结论：先做 A，代码里预留 B 的 `refreshModels` 插槽。**

## 4. TUI 交互设计

```
/relay            -> 主菜单（select）：列表 / 新增 / 编辑 / 删除 / 测连通 / 启用
/relay-add        -> 5 步向导，全用 ctx.ui：
  1. input    名字（默认 relay-xxx，只能小写/数字/连字符） 
  2. input    baseUrl（默认 https://.../v1，校验 http(s)）
  3. select   api 类型：openai-completions / openai-responses / anthropic-messages
  4. input    apiKey（支持 $ENV / !command / 明文；明文时 confirm 是否只存 $ENV 引用）
  5. input    models（逗号分隔，如 gpt-5.4,claude-sonnet-4-6）
  6. confirm  预览脱敏配置 -> 写入 -> notify 成功 + 提示 /model
/relay-list       -> select 现有 relay，一眼看 baseUrl/api/模型数
/relay-test <id>  -> fetch 最小请求（GET /models 或 POST 最小 chat）验连通性
/relay-use <id/model> -> pi.setModel() 直接切换
/relay-del <id>   -> confirm 二次确认 -> 删除 + 备份
```

- 非 TUI（`--print / --json / RPC`）降级：向导不可用，直接走 `/relay-add --name ... --baseUrl ...` 参数式；所有 `ctx.ui` 调用前 guard `ctx.mode === "tui"`。
- 参考实现：`examples/extensions/commands.ts`（select/confirm）、`preset.ts`（SelectList + session_start）、`qna.ts`（custom loader）。

## 5. 数据与安全

- 只动 `models.json` 里 `providers.relay-*` 命名空间，不碰内置 provider；写前备份 `models.json.bak`。
- Key 脱敏显示（只露后 4 位）；优先写 `$ENV_NAME` 引用，不鼓励明文落盘。
- 文件写走 `withFileMutationQueue()` 做 read-modify-write，防止并发覆写。
- MVP 只做 global（`getAgentDir()`），project 级 `.pi` 放到 M3 之后（涉及 project trust）。
- 错误继续原则：handler 报错只 `notify`，不掀桌（参考 extensions 错误语义）。

## 6. 目录结构

```text
pi-relay-tui/
├── package.json            # pi.extensions + peerDeps（已建）
├── extensions/
│   └── relay.ts            # MVP 主文件（下一步实现）
├── PLAN.md                 # 本文件
├── README.md               # 安装/使用说明
└── LICENSE                 # MIT
```

## 7. 里程碑

- [x] M0：建仓 + 方案冻结
- [x] M1：`/relay /relay-add /relay-list /relay-use /relay-del /relay-test` 实现 + 类型检查 + headless 功能测试（见 test/）
- [ ] M1-verify：真机 `pi --extension` 走一遍向导 + `/model` 能选到（等你验证）
- [ ] M2：`edit`（改 baseUrl/key/模型）、`/models` 发现、失败重试指引 polish
- [ ] M3：`pi install git:...` 发布验证 + README 录屏
- [ ] M4（可选）：转方案 B（动态注册 + `/models` 发现 + auth.json 联动）

## 8. 待你确认（回复序号即可）

1. 插件名 `pi-relay-tui` OK？还是要 `pi-relay-manager`？
2. MVP 只做 `openai-completions`，还是同时给 `anthropic-messages / openai-responses` 三选项？
3. Key 策略：强制 `$ENV` 引用（安全），还是允许明文存 `models.json`（方便）？
4. 要不要管 project 级 `.pi/models.json`？MVP 我默认只做 global。
