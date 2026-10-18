<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : CHANGELOG.md
 usage : supports LongMemory changelog
-->

# Changelog

All notable changes are documented here. LongMemory follows Semantic Versioning.

## Fork update - 2026-10-18

- Publish the lightweight Codex SQL gateway; the full graph engine loads only
  when a graph API is explicitly used. Add bounded SQLite caching and streaming
  node loading to reduce per-connection startup memory.
- Close stdio runtimes on EOF, broken pipes and startup failure; forward launcher
  signals and monitor the parent process for child cleanup.
- Ship the optional startup-only invitation adapter as Codex plugin 0.1.1.
  Legacy turn, Stop and compaction hooks remain unregistered.
- Add opt-out participation, acknowledged-only context delivery, bounded history
  batches, revocable local background workers and L4 classification safeguards.
- Correct release checks for the standard hook layout and add startup adapter
  regression coverage. Include the missing build configuration and NOTICE in Docker.
- Refresh the dashboard's Next.js, sharp and source-map-js dependencies to
  address the advisories reported by the release dependency audit.
- Fix the library quick-start example to supply the required event user ID;
  verify CLI, SQLite persistence and MCP handshake from an independently installed package.
- Update public documentation to distinguish shipped code from the separate
  machine-local document panel and private knowledge collections.
- Move six optional cloud configuration files into `deployments/`; remove three
  upstream-only contributor/package/container publishing workflows. Preserve
  local startup, source, tests, build tooling and license notices.
- Stop tracking the dashboard's generated TypeScript build cache and prevent
  database, backup and build-cache artifacts from entering the release tree.

## 1.0.0 - 2026-08-31

- Renamed the product, npm package, CLI, environment namespace, integrations, and editor extension to LongMemory.
- Shipped the immutable Hydrograph engine with temporal, strict, historical, associative, grounded, and multilingual recall.
- Added SQLite persistence, deterministic decay and reinforcement, consolidation, compression, reconsolidation, and governed project assets.
- Added authenticated HTTP and MCP servers, a production dashboard, CLI session porter, AI Wiki generation, and a VS Code extension.
- Added native n8n, Claude Code, Codex, Gemini CLI, Agent Plugins, Cline, Continue, LibreChat, CrewAI, AutoGen, LangGraph, OpenAI Agents, and PydanticAI integrations.
- Added official benchmark tooling for LongMemEval, LoCoMo, BEAM, comparative providers, scorecards, and release gates.
- Added Docker, Compose, Heroku, Railway, Render, DigitalOcean, and Vercel deployment manifests.
- Licensed the project under Apache License 2.0.
