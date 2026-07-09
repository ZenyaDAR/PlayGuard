# Pre-Commit Checklist

Run through this before every commit that touches `src/index.ts` or public behavior. Skip freely for docs-only typo fixes or internal test tweaks.

## 1. Build & tests

- [ ] `npm test` passes (runs `tsc` + `node --test`) — no type errors, no failing tests
- [ ] New/changed logic in `src/index.ts` has a matching test in `test/playguard.test.mjs` or `test/playguard-core.test.mjs`
- [ ] `npm run bench` still runs clean if proxy overhead / caching / recovery logic changed

## 2. Version & changelog

- [ ] Does this change affect runtime behavior (not just docs/tests)? If yes → bump `version` in `package.json` (semver: patch for fixes, minor for additive features, major for breaking env var / behavior changes)
- [ ] `CHANGELOG.md` has a new `## X.Y.Z — YYYY-MM-DD` entry matching the bumped version, under `### Added` / `### Fixed` / `### Changed` as appropriate
- [ ] Changelog entry explains *why*, not just *what* (matches the style of existing entries — see `0.2.1`)

## 3. Docs consistency

Cross-check `README.md` against the actual code in `src/index.ts` — anything below can drift silently:

- [ ] **Env var tables** (Playwright + Figma sections) — names, defaults, and descriptions match the `process.env.*` reads at the top of `src/index.ts`
- [ ] **Module list** (Figma Optimizer section, Modules 1–7) — matches what `optimizeFigmaResponse()` / `budgetTrimFigma()` actually do; module numbers still line up
- [ ] **Architecture diagram / feature bullets** — still accurate if routing, recovery, or caching logic changed
- [ ] **Project Structure** section — file tree and the `~N lines` comment on `src/index.ts` still roughly right
- [ ] **Comparison table** — still true (sizes, overhead numbers) if optimizer/compaction logic changed materially
- [ ] **Tests section** paragraph — lists what's actually covered in each `test/*.mjs` file
- [ ] `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` — only touch if this change affects contribution flow, supported versions, or reporting process; otherwise skip

## 4. Git hygiene

- [ ] `git status` reviewed — no stray files (`logs/`, `dist/`, `node_modules/` should be gitignored, not staged)
- [ ] No real API keys / tokens in staged diff (README examples use placeholder values like `your-figma-api-key`)
- [ ] Staged diff read end-to-end (`git diff --staged`) — no leftover debug logging, commented-out code, or TODOs that should've been resolved

## 5. CI

- [ ] `.github/workflows/ci.yml` still applies (no new required env vars / secrets needed to run `npm test` on a clean checkout)
