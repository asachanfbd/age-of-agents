# Contributing to Age of Agents

Thanks for your interest. Contributions of all sizes are welcome: bug reports, fixes, docs, and features.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach before you write code.
- Read [AGENTS.md](AGENTS.md) and [.docs/index.md](.docs/index.md). They point to the architecture, the domain vocabulary, and the testing rules.

## Setup

```bash
npm run install:all   # install server + web dependencies
npm run dev           # run server + web together
```

Node.js and the `claude` CLI are needed to run real agents. The test suites do not spawn real agents.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused. One concern per pull request.
3. Add or update tests alongside the code. See [.docs/testing.md](.docs/testing.md) for how the daemon tests are written.
4. If behavior changes, update the doc that owns that topic.
5. Run the checks below and make sure they pass.

| Where | Check | Command |
| --- | --- | --- |
| `server/` | Types | `npx tsc --noEmit` |
| `server/` | Tests | `npm test` |
| `web/` | Types | `npx tsc -b --noEmit` |
| `web/` | Tests | `npm test` |
| `web/` | Lint | `npm run lint` |

Tests must not touch your real data directory or any real account. The server tests already point at temp folders; keep it that way.

## Pull requests

- Describe what changed and why, and how you checked it.
- Link the issue it addresses.
- Do not commit secrets, tokens, personal paths, or machine-specific config. `server/executors.json` is git-ignored for this reason; start from `server/executors.example.json`.

## Reporting bugs and security issues

Open a GitHub issue for bugs, with steps to reproduce. For a security problem, please do not open a public issue. Use GitHub's private vulnerability reporting on this repository instead.

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
