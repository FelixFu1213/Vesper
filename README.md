# Vesper

> 黄昏时分最早亮起的那颗星，象征夜幕下依然静默运转的一点微光。

An open-source, general-purpose agent and multi-agent control plane with a built-in native Pi agent runtime.

## Core Capabilities

- **Built-in Pi Native Agent Harness**: Ships with an embedded native agent powered by `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` (workspace tools, structured `TodoWrite` / `TodoRead` task checklists, and configurable providers/models), alongside orchestration support for external coding and general agents (Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi, and [ACP](./docs/user/providers-acp.md) agents).
- **Plan Mode & Interactive Approval Flow**: Enter Plan Mode directly via `/plan [task]`, inspect plans in the dedicated right-panel Plan viewer, track execution progress via the Todo panel, and approve or switch to implementation via the interactive approval bar (`/build` / `/default`).
- **Autonomous Goal Loop & Slash Command Suite**:
  - **Universal composer slash commands**: `/plan`, `/build`, `/default`, `/permissions` (inline mode picker), `/model`, `/diff`, `/context`, `/clear`, `/side`, `/btw`
  - **Built-in Pi Native workflow commands**: `/goal` (autonomous long-running goal loop with structured progress reporting via `UpdateGoalStatus`), `/compact`, `/review`, `/grill-me`, `/boost`, `/init`
- **Multi-Agent Control Plane & Git Worktrees**: Run parallel agent threads across desktop, web, and remote machines with per-thread Git worktree isolation, inline diff review, and integrated source control.

## Quick Start

### Prerequisites

- **Node.js** `26.x` (see `engines` in [`package.json`](./package.json))
- **pnpm** `12.x`

### Run from Source

```bash
git clone https://github.com/FelixFu1213/Vesper.git
cd Vesper
pnpm install
pnpm dev
```

To launch the desktop app instead of the web client:

```bash
pnpm dev:desktop
```

See the [development runbook](./docs/operations/development.md#first-checkout) for detailed local setup instructions.

## Documentation

- [Documentation index](./docs/README.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Architecture overview](./docs/internals/overview.md)

## Acknowledgments / 致谢

- **[T3 Code](https://github.com/pingdotgg/t3code)** (MIT License) — Vesper is built on top of T3 Code's open-source agent control plane, orchestration architecture, Git worktree workflows, and multi-platform client foundation. Sincere thanks to T3 Tools Inc. and all T3 Code contributors.
- **[Pi (`@earendil-works/pi-agent-core` & `@earendil-works/pi-ai`)](https://github.com/earendil-works/pi)** (MIT License, by Mario Zechner & contributors) — Powers Vesper's built-in native agent runtime and model transport layer.
- **[PI-Desktop](https://github.com/vastsa/PI-Desktop)** — Inspiration for the Plan Mode interactive approval bar, Todo checklist UI, and desktop workspace experience.
- Workflow and slash-command ergonomics inspired by **Claude Code**, **Codex**, and **Antigravity**.

## License

[MIT](./LICENSE)
