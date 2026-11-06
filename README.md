# Age of Agents

A local, single-user tool that turns real Claude Code agent activity into a browser-based, Age of Empires-style 3D scene: projects are buildings, active agents are workers walking between them, and a central home base holds the roster of agent and skill templates you can assign to a task. Every worker on screen is a real `claude` CLI process doing real work on a real project folder — not a simulation.

## Getting started

### Prerequisites

- **Node.js 23.6 or newer** (25.x also works). The server runs TypeScript directly, so there is no build step for it. Check with `node --version`.
- **npm**, which comes with Node.
- **git**.
- A **C/C++ build toolchain**, because `better-sqlite3` and `node-pty` are native modules. On macOS run `xcode-select --install`. On Debian/Ubuntu run `sudo apt install build-essential python3`. On Windows, install the Visual Studio Build Tools.
- At least one agent CLI, installed and logged in: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) or Codex (`codex`). Every worker is a real CLI session, so without one you can browse the app but not run tasks.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`, for the features that clone repositories, push branches and merge pull requests.

### 1. Clone and install

```bash
git clone https://github.com/asachanfbd/age-of-agents.git
cd age-of-agents
npm run install:all   # installs server + web dependencies
```

### 2. Tell the app which agent CLI to use

```bash
cp server/executors.example.json server/executors.json
```

The example lists a plain `claude` and a plain `codex`. Edit `server/executors.json` if your CLI lives elsewhere or you use several accounts (set `bin` and a `CLAUDE_CONFIG_DIR` per account). This file is git-ignored because it holds local paths. You can also add and edit executors later from the Settings page (the gear button in the top bar). More detail is in [server/README.md](server/README.md#executors--picking-which-account-runs-a-task).

### 3. Run it

```bash
npm run dev           # runs the daemon and the web app together
```

- The daemon listens on <http://localhost:4500>.
- The web app is served by Vite. Open the URL it prints (<http://localhost:5173> by default).

Use a different daemon port with `PORT=4600 npm run dev`. If you do, also set `VITE_SERVER_URL=http://localhost:4600` for the web app.

### 4. Create your first project

1. In the scene, create a new project. Pick a blank project or clone a repository.
2. Open the project and start a task. A worker walks to the building and runs your agent CLI in that project's folder.
3. Your projects and the app's database are created under `projects/` and `server/data/`. Both are git-ignored and stay on your machine.

### Checks to run while you work

| Where | Check | Command |
| --- | --- | --- |
| `server/` | Types | `npx tsc --noEmit` |
| `server/` | Tests | `npm test` |
| `web/` | Types | `npx tsc -b --noEmit` |
| `web/` | Tests | `npm test` |
| `web/` | Lint | `npm run lint` |

`npm test` from the repo root runs both test suites. The tests use temp folders and fake agent CLIs, so they never touch your real data or start a real agent. If `tsc` or `oxlint` is missing, install with `npm install --include=dev` inside that package.

### Where to look in the code

| Path | What it is |
| --- | --- |
| `server/` | The background daemon: REST + WebSocket API, task and worker orchestration, file-based database |
| `web/` | The React + Three.js front end (`web/src/scene/` is the 3D scene, `web/src/ui/` the panels) |
| `catalog/` | Agent and skill templates shipped with the app |
| `docs/` and `.docs/` | Architecture, specs and testing notes. Start with [.docs/index.md](.docs/index.md) |

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Running in the background

To run it production-style in the background (builds the web app, serves `web/dist` on :4173, daemon on :4500):

```bash
npm run prod:start     # PIDs saved to .run/prod.pids, logs in .run/*.log
npm run prod:stop      # stops everything listed in .run/prod.pids
npm run prod:update    # stop, git pull, reinstall, start again — from a terminal, interrupts everything running
```

Override ports with `PORT=... WEB_PORT=... npm run prod:start`.

A production-style run also checks for updates itself and offers to apply them from inside the app — the status footer's update item shows "Update available" once `origin` has moved ahead, and applying it either rebuilds the web app in place with no interruption (a web-only change) or waits for an idle moment before running the same stop/pull/install/start sequence as `npm run prod:update` above (a server change). See `docs/blueprint.md`'s "App update" sections for the full contract; this in-app path is unavailable in `npm run dev`, where the footer only shows whether an update exists.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
