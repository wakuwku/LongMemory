<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                    /____/                                 /_____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : integrations/codex-longmemory/README.md
 usage : supports the LongMemory README integration
-->

# LongMemory for Codex

The plugin provides a lightweight local MCP gateway and an optional startup
invitation adapter. Version 0.1.1 registers only `SessionStart` with matcher
`startup`, through `hooks/hooks.json`. It does not automatically bind a task,
recall a database, save each reply, or run Stop/compaction hooks.

## Install from source

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
longmemory version
```

On Windows, `npm link` is an alternative when pnpm's global bin directory is
unavailable. Node.js 20 or newer is required. Add this repository as a local
Codex plugin marketplace and install `longmemory`. Restart the host and review
the startup hook before enabling it.

The MCP launcher finds the built CLI in the source checkout, an installed local
marketplace, or the global CLI. `LONGMEMORY_CLI_COMMAND` can specify one absolute
executable path, including the built `dist/cli/index.js`; it is not a shell
command string. Installation tests do not establish host trust or task consent.

## Optional document-memory invitation

The startup adapter reads `${PLUGIN_DATA}/document-memory-startup.json`:

```json
{
  "enabled": true,
  "entry": "/absolute/path/to/your/document-memory-startup.mjs"
}
```

`entry` is an explicitly configured local JavaScript adapter. It receives the
startup event as JSON on stdin and returns hook JSON on stdout. It should ask
once within its configured project scope, support refusal, and wait for user
consent before reading or writing project knowledge. Without this file, or if
the adapter fails, the launcher returns `{"continue":true}` and work continues.
Other lifecycle events never invoke the adapter.

The machine-local document panel, project registry, document-memory skill and
private collections used during development are a separate installation. They
are not bundled into this public plugin. The invitation adapter is an extension
point, not an out-of-the-box document-retrieval system.

## MCP and storage

The stdio launcher selects `codex-memory-gateway` and exposes three tools:

- `longmemory_codex_memory`
- `longmemory_history_backfill`
- `longmemory_history_publication`

These tools require valid server-issued task/turn authorization. The startup
invitation does not issue that authorization. Legacy hook-managed operations
therefore require a separately enabled compatible runtime; ordinary manual
memory and history maintenance are also available through the CLI.

The default central store is `${PLUGIN_DATA}/central-memory.db`; registry state
lives beneath `${PLUGIN_DATA}/sessions/`. An absolute `LONGMEMORY_DB_PATH` can
select another shared local database. Keep one database identity per intended
store. Workspace configuration does not silently replace the central path.

The gateway initializes central SQL services without loading the entire legacy
graph. A graph operation still loads the original engine when needed. Independent
stdio connections are normal; each process closes its own runtime on stream
termination, and the launcher monitors its parent and child lifecycle.

## History maintenance and browsing

The CLI supports reviewed history import, bounded extraction batches and
revocable local background workers. A worker still needs a running extractor;
authorization alone does not create a model daemon. Major rules and conflicts
retain explicit human confirmation.

- [History import](../../docs/session-porter.md)
- [Background worker commands](skills/longmemory/references/background-history.md)
- [CLI governance](../../docs/cli.md#govern-codex-history-publication)
- [Legacy lifecycle reference](docs/legacy-lifecycle.md)

For the central SQLite store, `longmemory obsidian project --db <database>
--vault <vault>` produces read-only Markdown navigation. Editing the projection
does not update the source database.

## Update and verify

Rebuild the CLI, refresh the installed plugin copy and restart the host. Check
that the installed hook definition contains only the startup invitation, then
test a fresh task and the intended consent flow. Repository tests cover the
launcher and MCP protocol; they do not substitute for that host-level check.

`pnpm test:unit` covers the startup adapter, launcher cleanup, gateway, history
boundaries and legacy contracts. `pnpm integration:check` checks manifests and
build outputs. No account login, cloud deployment or private-memory import is
performed by these checks.
