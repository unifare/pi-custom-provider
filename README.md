# pi-relay-tui

在 Pi 的 TUI 里配自定义中转 API，不用手改 `models.json`。

> 当前状态：M0 方案冻结，M1 开发中。详见 [PLAN.md](./PLAN.md)。

## 安装（M1 完成后可用）

```bash
pi install git:github.com/<you>/pi-relay-tui
# 本地试用
pi --extension ./extensions/relay.ts
```

## 用法（目标形态）

```text
/relay        # 主菜单：新增 / 列表 / 编辑 / 删除 / 测连通 / 启用
/relay-add    # 5 步向导：名字 -> baseUrl -> api -> key -> models
/model        # 向导写完后在这里选到新中转模型
```
