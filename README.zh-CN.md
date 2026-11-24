# cc-statistics

在输入框正上方的横栏里显示这场对话的实时状况：首 token 时间、输出速度、token 总量、缓存命中率和花费。

```
TTFT 1.24s   TPS 52.3 token/s   tokens 1.54M   cache 88.40%   turn $0.0042   session $0.0421
```

[English](README.md) · **简体中文**

## 显示内容

| 项 | 含义 |
| --- | --- |
| `TTFT` | 从请求发出到第一个 token（思考 token 也算）。等待中显示 `…`，还没有响应时显示 `—`。 |
| `TPS` | 输出速度，单位 `token/s`。流式过程中是估算值（每 32 个片段刷新一次），响应结束时用 API 的 `output_tokens` 校正。 |
| `tokens` | 会话累计：每次请求的输入（未缓存 + 缓存写入 + 缓存命中）加输出，按 API 报告的用量累加，两位小数。 |
| `cache` | 缓存命中率：`cache_read_input_tokens ÷ 全部输入 token`，两位小数。 |
| `turn` | 本轮到目前为止的花费。 |
| `session` | 整个会话到目前为止的花费。 |

`TTFT`、`TPS` 只跟随主对话循环的最新一次请求；`tokens`、`cache` 把每个子代理回合也计入，两个花费是全量数字。

## 菜单

横栏最左侧的 `☰` 打开一个四行的面板。

**显示项** —— 六个开关（`✓ ttft`、`· tps` …）。隐藏的项完全不占位。选择是全局的：任一对话改动后，其他会话在几秒内同步。

**币种与模型** —— `$` 或 `¥` 立即切换 `turn`、`session` 的符号，以及旁边费率字段的单位。后面的名字是最近一次回答的模型，四个费率属于它。

**费率** —— `input`、`output`、`cacheRead`、`cacheWrite` 四个字段，单位是按所选币种计的百万 token 价格。输入数字后按回车保存。

- 字段里显示当前生效的费率；流式回答导致横栏重绘时，打了一半的数字会保留。
- 保存后会立即用已累计的 token 按新费率重算 `turn` 和 `session`（单模型会话精确；用过多个模型的会话按当前模型的费率估算；prompt 的缓存写入部分按输入价计，因为只保留了输入总数）。
- 费率绑定到显示的模型。计价时按每条响应的 `usage.model` 匹配：先精确同名，再按 id 里包含的最长 key（如 `claude-sonnet-5-5-20260101` 里的 `sonnet`），最后用兜底行。
- 费率和显示项一样存在插件的 `$.store` 里，跨会话共享。

**更新** —— 行尾的 `update <版本>` 只在新版本存在时出现，执行 `claude plugin update cc-statistics` 并提示结果，之后按提示 `/reload-plugins`。

## 安装

这个仓库本身就是一个 marketplace：`.claude-plugin/marketplace.json` 与 `plugin.json` 并列，指向仓库根目录。

从 GitHub 安装（Claude Code 2.1.275 或更新）：

```bash
claude plugin install cc-statistics --marketplace klii0314/cc-statistics
```

终端会话里也可以直接输入 `/plugin install cc-statistics --marketplace klii0314/cc-statistics`；桌面应用走 **+ → Plugins → Add marketplace**，填 `klii0314/cc-statistics`。选 user 作用域，之后的会话都会加载。

从自己的 fork 安装时，把 `klii0314/cc-statistics` 换成 `<你的账号>/cc-statistics`。

克隆下来的文件夹也可以作为本地 marketplace（路径换成实际位置）：

```bash
claude plugin marketplace add ./cc-statistics
claude plugin install cc-statistics@cc-statistics --scope user
```

同一台机器上一个名字只能对应一个 marketplace，因此「指向文件夹的同名条目」和「同名 GitHub 仓库」不能同时配置，需要先移除一个再添加另一个。

## 修改与更新

运行中的会话加载的是**安装时的那份副本**（`claude plugin list --json` 里的 `installPath`），不是仓库目录。改完代码后：

1. 把 `.claude-plugin/plugin.json` 的 `version` 加一；
2. 刷新安装副本：`claude plugin update cc-statistics`，或点横栏上的 `update` 按钮；
3. `/reload-plugins`（或重启应用）。

只改文件不 bump 版本会被当作「已是最新」，副本不更新，reload 后仍是旧代码——最常见的「改完没生效」。

`update` 按钮的判断有两条路径：文件夹安装比较文件夹自身的版本；GitHub 安装没有文件夹，插件会读 `known_marketplaces.json` 里的仓库地址，拉取仓库顶端的 manifest 比对。网络或来源不允许时不会出现按钮。

## 计费

**默认** —— `turn`、`session` 来自引擎的 `/cost` 账本：按模型官方价，缓存读写都已计入。账本以美元计价，所以没有自定义费率时选 `¥` 只会改变符号。

**菜单里的费率** —— 上文四个字段：它们接管该模型的计价，所有金额都按累计的 token 计算。

**pricing.json** —— 服务商有自己的价格时（例如 `ANTHROPIC_BASE_URL` 指向中转），把文件放在插件**实际运行**的目录（`installPath`）：

```json
{
  "multiplier": 1,
  "models": {
    "claude-sonnet-4-5": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
  },
  "fallback": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
}
```

- 数值是百万 token 的价格；`cacheWrite` 不区分 5 分钟和 1 小时。
- 匹配顺序：精确 id → id 里包含的最长 key → `fallback`；都不中按 0 计，并在日志提示一次。
- `multiplier` 乘在所有金额上；只写倍率时改为折算引擎账本。
- 文件在每轮开始时读取，改完下一轮生效。
- `pricing.example.json` 只是结构示例，数字请换成你服务商的实际报价。

## 持久化与口径

`tokens`、`cache` 和自定义花费是插件自己的计数：从它第一次看到响应开始，之前的轮次不会补算（花费不受影响，那是引擎的账本）。它们按**对话的首条用户消息**镜像到 `$.store`，因此重启、恢复或 worker 重开都能读回；新对话从零开始，`/clear` 删除存档。菜单里显示的模型也随它们保存。

`session` 花费来自引擎，随会话重置属正常。

## 显示位置

横栏由 Claude Code 画在消息输入框正上方，桌面端、终端和移动端都显示。窗口最顶部没有插件可用的位置。窄于 88 列时，两个花费折到第二行。

## 开发

```bash
claude plugin validate .
```

```bash
claude plugin test .
```