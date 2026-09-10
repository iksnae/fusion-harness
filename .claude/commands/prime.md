---
description: Prime with foundational context for the fusion-harness Pi extension repo
---

# Purpose

Orient yourself in fusion-harness: a clean-room Pi coding-agent extension that coordinates 2–5 configured models—one ARCHITECT, one primary/Main BUILDER (raw-chat host), and optional secondary builders—through N-way opinion, sole-writer fusion, all-to-all debate, dependency-driven single-writer collaboration, adversarial gauntlet review, direct routing, and gate-first validation, with per-row speed/cost/context telemetry.

## Workflow

1. Run `git ls-files | sort` plus `git status --short` to see tracked and changed files.
2. Read `README.md` for model-stack YAML (including `append_system_prompt`), commands, the single-writer contracts, per-app-run session scoping, and the TPS/cost model-bar rows.
3. Read the modules in this order: `extensions/fusion-harness/modules/runtime.ts` (shared types + the HarnessDeps seam), `model-stack.ts`, `child-runner.ts`, `prompt-library.ts`, `tui.ts`, then the command modules `cmd-readonly.ts`, `cmd-fusion.ts`, `cmd-build.ts`, `cmd-gauntlet.ts` (with its `task-executor.ts` scheduler and `gauntlet-rubric.ts` schemas), and finally the factory `fusion-harness.ts` (flags, sessions, widgets, small commands).
4. Read `justfile` for the `fusion` trio (Fable architect + Gemini Main + DeepSeek), the 5-slot `fusion5` stack, legacy WORKHORSE/SOTA pairs, and explicit `fh-stack`.
5. Skim `extensions/fusion-harness/prompts/{SYSTEM,USER}_PROMPT_*.md`, especially FUSION merge, debate rounds, collaboration propose/delegate/execute/coordinate, the GAUNTLET rubric/critic/adjudicate/repair/integrate contracts, and context ACK.
6. Read `VALIDATION.md` and run `npm test` for current evidence.
7. Note: `prompts/duckdb/` is the simple-to-complex live validation suite; `.pi/fusion-harness/` holds the tracked stack configs; a clean demo workspace lives at `../fusion-harness-v2-playground` (own justfile, `ai_docs/` scraped docs, `.env` symlink).
8. Summarize your understanding: purpose, stack/config invariants, single-writer safety (one scheduler in `task-executor.ts`, shared by `/fh-collaborate` and `/fh-gauntlet`), dependency-driven collaboration, the gauntlet's blind-critic isolation (fresh session per round per slot, read-only tools, unanimous-to-clear), session scoping (per app run), module structure, key files, commands, and validation entry points.
