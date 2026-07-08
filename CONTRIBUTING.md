# Contributing to PlayGuard

## Before you start

For anything beyond a small fix, open an issue first to discuss the change —
it saves rework on both sides.

## Development setup

```bash
git clone https://github.com/ZenyaDAR/PlayGuard.git
cd playguard
npm install
npm run build
npm test
```

## Making a change

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep diffs focused — one logical change per PR.
3. Add or update tests in `test/` for any behavior change.
4. Run `npm test` (builds with `tsc` and runs the Node test runner) — it must pass.
5. Update `README.md` / `CHANGELOG.md` if behavior, env vars, or the project structure changed.
6. Open a pull request describing the change and why it's needed.

## Code style

- TypeScript, `strict: true`. Avoid `any` unless the value is genuinely
  external/untyped (e.g. arbitrary upstream Figma JSON).
- No unrequested abstractions — this is a single-file proxy by design; don't
  split it up or add layers speculative future features might need.
- Mark deliberate shortcuts with a `// ponytail: ...` comment naming the
  ceiling (e.g. "unbounded cache would grow forever; capped by size instead").

## Reporting bugs

Open a GitHub issue with: PlayGuard version, Node version, OS, the env vars
you set, and the relevant lines from `logs/YYYY-MM-DD.ndjson` if applicable.

## Security issues

Do not open a public issue for security vulnerabilities — see [SECURITY.md](SECURITY.md).
