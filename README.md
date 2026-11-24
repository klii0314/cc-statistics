# cc-statistics

A band above the prompt that shows how the conversation is doing: time to first token, output speed, tokens moved, cache hit rate and cost.

```
TTFT 1.24s   TPS 52.3 token/s   tokens 1.54M   cache 88.40%   turn $0.0042   session $0.0421
```

**English** · [简体中文](README.zh-CN.md)

## What it shows

| Reading | Meaning |
| --- | --- |
| `TTFT` | From the request leaving to the first token (thinking tokens count). `…` while it waits, `—` before the first response. |
| `TPS` | Output speed in `token/s`. Live while streaming (an estimate refreshed every 32 chunks), corrected at the end of the response with the API's `output_tokens`. |
| `tokens` | Tokens the session has moved: prompt tokens (uncached + cache-written + cache-read) plus output, summed from each response's usage. Two decimals, `52.11M`. |
| `cache` | Cache hit rate: `cache_read_input_tokens ÷ all prompt tokens`, two decimals. |
| `turn` | What the current turn has cost so far. |
| `session` | What the session has cost so far. |

`TTFT` and `TPS` follow the main loop's latest request; `tokens` and `cache` include each subagent turn, and the costs are whole-session figures.

## The menu

The `☰` button on the left opens a panel with four rows.

**Readings** — six switches (`✓ ttft`, `· tps`, …). A hidden reading draws nothing at all. The choice is global: every session reads it back within a few seconds of a change.

**Currency and model** — `$` or `¥` sets the symbol on `turn` and `session` immediately, and the unit of the rate fields beside it. The name after them is the model that last answered; its rates are edited for that model.

**Rates** — four fields (`input`, `output`, `cacheRead`, `cacheWrite`), in the chosen currency per million tokens. Type a value and press Enter to save it.

- The fields show the rate in force, and keep a half-typed value through the redraws a streaming turn brings.
- Saving reprices `turn` and `session` at once from the tokens already counted (exact for a one-model session; a session that used several models is estimated at the current model's rates; the cache-written part of a prompt is priced at the input rate, since only the total is kept).
- A rate is bound to the model shown. Pricing matches each response's `usage.model`: the exact id first, then the longest key the id contains (`sonnet` in `claude-sonnet-5-5-20260101`), then the fallback row.
- Rates, like the switches, live in the plugin's `$.store` and are shared across sessions.

**Update** — at the row's right end, `update <version>` appears only when a newer version is installed or published. It runs `claude plugin update cc-statistics` and says how it went; press `/reload-plugins` afterwards.

## Install

This repository is a marketplace: `.claude-plugin/marketplace.json` sits beside `plugin.json` and points at the repository root.

From GitHub (Claude Code 2.1.275 or later):

```bash
claude plugin install cc-statistics --marketplace klii0314/cc-statistics
```

In a terminal session you can also type `/plugin install cc-statistics --marketplace klii0314/cc-statistics`; in the desktop app use **+ → Plugins → Add marketplace** and enter `klii0314/cc-statistics`. Choose the user scope so later sessions load it too.

Installing from your own fork: replace `klii0314/cc-statistics` with `<your-account>/cc-statistics`.

A cloned folder works as a local marketplace (replace the path):

```bash
claude plugin marketplace add ./cc-statistics
claude plugin install cc-statistics@cc-statistics --scope user
```

A machine holds one marketplace per name, so a pinned folder entry and the GitHub repository of the same name cannot both be configured; remove one before adding the other.

## Updating

A running session loads the copy made when the plugin was installed (`installPath` in `claude plugin list --json`), not the repository. After an edit:

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Refresh the installed copy: `claude plugin update cc-statistics`, or the `update` button in the band.
3. `/reload-plugins` (or restart the app).

A change without a version bump reads as "already at the latest", so the copy is not refreshed and the reload keeps running the old code — the usual "my change did nothing".

The `update` button decides in two ways: a folder install compares the folder's own version with the installed one; a GitHub install has no folder, so the plugin reads `known_marketplaces.json` for the repository and fetches its manifest at the tip. No button appears when the network or the source does not allow that.

## Pricing

**Default** — `turn` and `session` come from the engine's `/cost` ledger: the list price per model, cache reads and writes included. The ledger is US dollars, so selecting `¥` with no rates of your own only changes the symbol.

**Rates from the menu** — the four fields described above: they take over for that model, and every figure is then computed from the tokens counted.

**pricing.json** — for a provider that bills its own prices (a relay behind `ANTHROPIC_BASE_URL`, for example), put a file in the directory the plugin runs from (`installPath`):

```json
{
  "multiplier": 1,
  "models": {
    "claude-sonnet-4-5": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
  },
  "fallback": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
}
```

- Values are per million tokens; `cacheWrite` covers both cache lifetimes.
- A model is matched by exact id, then by the longest key the id contains, then by `fallback`; an unmatched model is priced at zero, with one log line.
- `multiplier` scales every figure. With only a multiplier, the engine's ledger is scaled instead.
- The file is read at the start of every turn, so an edit lands on the next turn.
- `pricing.example.json` is a shape to copy, not real prices.

## Persistence and scope

`tokens`, `cache` and the custom cost are the plugin's own counts: they begin when the plugin first sees a response, so earlier turns are not backfilled (cost is unaffected — that is the engine's ledger). They are mirrored into `$.store` under the conversation's first user message, so a restart, a resume or a worker respawn reads them back; a new conversation starts at zero, and `/clear` deletes the saved entry. The model shown in the menu is saved with them.

`session` cost comes from the engine and resets with the session.

## Where it draws

The band is drawn by Claude Code directly above the message box, on the desktop, terminal and mobile surfaces. There is no plugin slot at the very top of the window. Narrower than 88 columns, the two costs move to a second line.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```