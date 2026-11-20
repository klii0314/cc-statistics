# cc-statistics

在输入框正上方的横栏（AbovePrompt band）里显示这一轮对话的推理指标：

```
TTFT 1.24s   TPS 52.3 token/s   tokens 1.54M   cache 88.40%   turn $0.0042   session $0.0421
```

## 显示内容

| 项 | 含义 |
| --- | --- |
| `TTFT` | 从请求发出到收到第一个 token 的时间（思考 token 也算）。等待中显示 `…`，还没跑过显示 `—`。 |
| `TPS` | 输出速度，带单位 `token/s`。流式过程中是按字符数估算的实时值（每 32 个片段刷新一次），请求结束时用 API 报告的真实 `output_tokens` 校正。 |
| `tokens` | 会话累计的 token 总数：每次请求的输入（未缓存 + 缓存写入 + 缓存命中）加输出，按 API 报告的用量累加。 |
| `cache` | 缓存命中率：`cache_read_input_tokens ÷ 全部输入 token`，保留两位小数（如 `88.40%`）。会话累计口径。 |
| `turn` | 本轮对话到目前为止的花费（本轮开始时的会话总额与当前总额之差）。 |
| `session` | 整个会话到目前为止的花费，默认与 `/cost` 一致；配置了 `pricing.json` 后按自定义费率。 |

横栏最左侧的 `☰` 按钮是「显示项」菜单：点开后这一行下面出现六个开关
（`✓ ttft` / `· tps` …），点哪个就切换哪一项是否显示，隐藏的项不占位。
这个选择是全局的：在任一对话里改动后，其他会话会在几秒内（或下一轮开始时）同步。

费率行前面是币种开关：`✓ $` / `· ¥`。它决定自定义费率金额用哪个符号显示，费率本身
的单位也随之改变（美元或人民币 / 百万 token）；引擎账本始终是美元，没有自定义费率时
`session` 仍显示 `$`。

费率行接着是 `/ 1M tokens` 后面四个输入框 `input`、`output`、`cacheRead`、
`cacheWrite`，填好按回车保存，单位是美元 / 百万 token。填了之后 `turn`/`session`
改为按这些费率计算（行尾带 `*`）；`pricing.json` 里针对具体模型的费率仍然优先，
这些值作为兜底。和开关一样，费率也存进 `$.store`、跨会话共享。

横栏行尾（数字之后）**只在有新版本时**出现 `update` 按钮，标签带版本号（如
`update 0.5.3`）。插件在会话开始、每轮开始以及每隔约 5 分钟用
`claude plugin list --json` 比对「已安装版本」与磁盘上的版本，两者不同才显示。
点它执行 `claude plugin update cc-statistics`，结果以 toast 提示，再按提示
`/reload-plugins` 生效；没有新版本时这一格是空白，不会占位。

两个花费带 `*` 时（如 `$0.0042*`），表示用的是 `pricing.json` 里的自定义费率或倍率，而不是引擎账本。详见下面的「计费」。

`TTFT`/`TPS` 只统计主对话循环的最新一次请求；`tokens`/`cache` 还把子代理
（subagent）每一轮的用量计入，`turn`/`session` 与 `/cost` 一样是全量的。

`tokens` 和 `cache` 由插件自己累加，所以从插件加载那一刻开始计数：在已经跑了
很多轮之后才装上，之前那部分的 token 不会补进总数（花费不受影响，那是引擎的账本）。
累计值同时按**会话 id** 写进插件的 `$.store`：同一会话被重启或恢复后会自动读回，
新开的会话从零开始；`/clear` 清零并删除保存值。`session` 花费始终来自引擎账本，
随会话重置属正常。
横栏窄于 88 列时，`turn`/`session` 会自动折到第二行。

## 计费（pricing.json）

默认 `turn`/`session` 读引擎的 `/cost` 账本：按模型官方价计算，缓存读/写和 1 小时缓存的差异都已处理。
如果你的服务商不同（例如设置了 `ANTHROPIC_BASE_URL` 指向中转/代理），在插件**实际
运行**的目录里新建 `pricing.json`——`claude plugin list --json` 的 `installPath`
就是它；文件放进源仓库目录的话，按下面「修改与更新」走一遍让它进入副本。填费率：

```json
{
  "multiplier": 1,
  "models": {
    "claude-sonnet-4-5": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
  },
  "fallback": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
}
```

- 单位：美元 / 百万 token。`input` 未缓存输入、`output` 输出（含思考）、`cacheRead` 缓存命中、`cacheWrite` 缓存写入（不区分 5 分钟/1 小时）。
- 匹配顺序：模型 id 完全一致 → id 里包含的最长 key（如 `sonnet` 匹配 `claude-sonnet-…-20260101`）→ `fallback`。都不匹配的按 $0 记，并在日志里提示一次。
- `multiplier` 乘在所有金额上。只写 `multiplier`、不写 `models`/`fallback` 时，按倍率折算引擎账本（`session` 仍包含安装前的历史）。
- 按费率计算时，`session` 由插件自己累加，从插件开始观察会话时算起（正常是会话开始）。
- 改的是运行目录里那份 `pricing.json`，下一轮开始就生效，不需要重载插件。
- `pricing.example.json` 只是结构示例，里面的数字是占位的，请换成你服务商的报价。

## 显示位置

横栏由 Claude Code 画在消息输入框正上方，桌面端、终端和移动端都会显示。
窗口最顶部没有插件可用的绘制位置；如果希望它浮在聊天区角落，可以把
`ui.open` 的 pane 作为一个 widget 打开，但位置由客户端决定、由用户拖动。

## 安装

这个仓库本身就是一个 marketplace：`.claude-plugin/marketplace.json` 与
`plugin.json` 并列，`source` 指向仓库根目录。

从 GitHub 安装（需要 Claude Code 2.1.275 或更新）：

```bash
claude plugin install cc-statistics --marketplace klii0314/cc-statistics
```

终端会话里也可以直接输入 `/plugin install cc-statistics --marketplace klii0314/cc-statistics`；
桌面应用的 Code 标签页走 **+ → Plugins → Add marketplace**，填 `klii0314/cc-statistics`。
选 user 作用域后，之后再启动的每个会话都会加载。

从自己的 fork 安装时，把上面的 `klii0314/cc-statistics` 换成 `<你的账号>/cc-statistics`。

也可以把克隆下来的文件夹当作本地 marketplace 安装（`./cc-statistics` 换成实际克隆路径）：

```bash
claude plugin marketplace add ./cc-statistics
claude plugin install cc-statistics@cc-statistics --scope user
```

## 修改与更新

运行中的会话加载的是**安装时的那份副本**（`claude plugin list --json` 的
`installPath`），不是仓库目录。改完代码之后按这个顺序做，三步都不能省：

1. 把 `.claude-plugin/plugin.json` 的 `version` 加一；
2. 更新安装副本：`claude plugin update cc-statistics`，或者点横栏行尾出现的
   `update <版本>` 按钮；
3. `/reload-plugins`（或重启应用），让会话加载新副本。

只改文件不 bump 版本的话，`claude plugin update` 会认为「已是最新」，副本不会
更新，reload 也就仍跑旧代码——这是最常见的「改完没生效」。

横栏上的 `update` 按钮对新版本的两条判断路径：文件夹安装比对 `folderVersion`；
从 GitHub 安装的没有这个字段，插件会按 `known_marketplaces.json` 里记录的仓库去
拉 `.claude-plugin/plugin.json` 比对版本（网络不通或不是 GitHub 源时不显示按钮）。

## 开发

- 校验：`claude plugin validate <文件夹>`
- 测试：`claude plugin test <文件夹>`
