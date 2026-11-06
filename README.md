# Age of Agents

A local, single-user tool that turns real Claude Code agent activity into a browser-based, Age of Empires-style 3D scene: projects are buildings, active agents are workers walking between them, and a central home base holds the roster of agent and skill templates you can assign to a task. Every worker on screen is a real `claude` CLI process doing real work on a real project folder — not a simulation.

## Setup

```bash
npm run install:all   # install server + web dependencies
npm run dev            # run server + web together
```

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
