<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /_____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : README.md
 usage : introduces LongMemory, its architecture, integrations, and deployment options
-->

# LongMemory

> **Local-first, governed memory for AI agents and Codex.**

LongMemory keeps durable project knowledge in SQLite and gives each task only
the context it needs. Separate Codex tasks can stay focused while sharing
approved facts, decisions, lessons, and constraints.

- Bounded recall with explicit project ownership and source evidence
- Lightweight Codex SQL gateway with on-demand loading of the full graph engine
- Reviewed history import, resumable batches and revocable background workers
- Optional startup invitation; task participation can be declined
- Confirmation for major rules and conflicts, plus version-aware updates
- Local CLI, MCP, HTTP, dashboard and read-only Obsidian projection

This is the [wakuwku fork](https://github.com/wakuwku/LongMemory) of
[CaviraOSS/LongMemory](https://github.com/CaviraOSS/LongMemory).
See the [October update](CHANGELOG.md#fork-update---2026-10-18) for the runtime
and repository cleanup changes.

## Architecture

```mermaid
graph LR
  CODEX[Codex tasks] --> GATEWAY[Lightweight MCP gateway]
  GATEWAY --> CENTRAL[Governed central memory]
  CENTRAL --> DB[(Local SQLite)]
  CLI[CLI and reviewed history workers] --> CENTRAL
  API[Library and general HTTP or MCP] --> GRAPH[Hydrograph engine]
  GRAPH --> DB
  DB --> VIEW[Read-only Obsidian projection]
```

For the shipped central-memory engine, SQLite is the source of truth and task
working sets are bounded, versioned views. The default Codex plugin registers
only an optional startup invitation; automatic per-turn capture and compaction
injection are not enabled.

The separate document-first pilot starts from project files and folders, uses
flexible branches, and retrieves relevant documents on request. Its local panel,
private project registry and knowledge files are not included in this repository.

## Quick start

This fork's Codex central-memory additions are currently distributed from
source.

```bash
git clone https://github.com/wakuwku/LongMemory.git
cd LongMemory
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
longmemory version
```

Start the local API:

```bash
pnpm start
```

The API listens on `http://127.0.0.1:7331` by default.

Use LongMemory as a library:

```ts
import { createMemory } from 'longmemory';

const memory = await createMemory({
    store: 'sqlite',
    db_path: './longmemory.db',
    tenant_id: 'local',
    user_id: 'alice',
});

await memory.ingest({ user_id: 'alice', text: 'Use SQLite for local persistence' });
const result = await memory.recall({
    user_id: 'alice',
    text: 'Which database should this project use?',
    mode: 'strict',
});

console.log(result);
await memory.close();
```

## Central memory model

The structured SQLite engine retains these levels. They are separate from the
flexible folder hierarchy of the document-first pilot.

| Level | Scope | Typical content |
| --- | --- | --- |
| L1 | Project | Purpose and rules that apply across the project |
| L2 | Role | What a Codex task or workstream is responsible for |
| L3 | Task | The current unit of work and its state |
| L4 | Formal memory | Decisions, methods, lessons, constraints, and solutions |

Authorized workflows bind an explicit project and responsibility, then recall
relevant knowledge with its provenance. Current user instructions outrank
recalled memory. Major rules, conflicts and sensitive history transitions
remain confirmation-gated. Legacy automatic lifecycle code remains available
for separately configured deployments, but is not registered by this plugin.

### Install the Codex integration

After building and linking the CLI, add this repository as a Codex plugin
marketplace, install `longmemory`, restart Codex and review the startup hook.
The invitation needs a machine-local adapter configuration; without it, the
hook does nothing and ordinary work continues.

See the [Codex integration guide](integrations/codex-longmemory/README.md) for
the exact installation, storage, hook, MCP, update, and recovery workflow.

By default, the plugin stores its central SQLite database and task registry
under Codex plugin data. Set an absolute `LONGMEMORY_DB_PATH` only when one
explicit shared location is required.

## Essential commands

```bash
# Ordinary memory
longmemory ingest "Remember the rollback procedure" --type procedure
longmemory recall "What is the rollback procedure?" --mode associative
longmemory project context "prepare the next release"

# Governed Codex history import
longmemory history inventory --from codex --all
longmemory history plan --from codex --all

# Explicit project links and Obsidian projection
longmemory project link list --db ./central-memory.db --project novel
longmemory obsidian project --db ./central-memory.db --vault ./KnowledgeVault

# Local MCP or HTTP service
longmemory mcp --db ./central-memory.db --project current
longmemory serve --mcp-http
```

The history flow is inventory → plan → human-confirmed assignment → import →
governed publication. Source conversations are never modified. Credential
matches block import unless the exact deterministic redaction proposal is
reviewed and confirmed.

See [the CLI reference](docs/cli.md) and
[history-import guide](docs/session-porter.md) for complete commands.

## Interfaces

| Surface | Purpose |
| --- | --- |
| TypeScript library | Embed memory directly in an application |
| CLI | Inspect, recall, import, govern, and maintain memory |
| MCP | Give agents scoped memory tools |
| HTTP API | Run LongMemory as a local or hosted service |
| Codex plugin | Lightweight scoped MCP tools and an optional startup invitation |
| Obsidian | Browse a deterministic read-only Markdown projection |
| Dashboard | Search, inspect, chat, and manage memory |
| VS Code | Recall and inspect project context in the editor |

Supported integrations also include Claude Code, Gemini CLI, n8n, Cline,
Continue, LibreChat, Dify, Flowise, CrewAI, AutoGen, LangGraph/LangChain,
OpenAI Agents SDK, and PydanticAI.

## Deployment

| Platform | Entry point |
| --- | --- |
| Docker | `Dockerfile` |
| Docker Compose | `docker-compose.yml` |
| Windows | `start-longmemory.ps1` |
| Optional cloud hosting | [Templates and placement instructions](deployments/README.md) |

For network deployment, configure `LONGMEMORY_API_KEY`, persistent storage,
allowed origins, and TLS. Vercel hosts only the dashboard and requires a
separate LongMemory API.

## Validation

```bash
pnpm release:check
```

The release check covers public-file safety, unit tests, type checking,
integrations, benchmarks, builds, and the dashboard. Root startup/build files
remain in place; optional cloud templates are grouped under `deployments/`.

## Documentation

- [Codex integration](integrations/codex-longmemory/README.md)
- [Architecture](docs/architecture.md)
- [CLI](docs/cli.md)
- [MCP](docs/mcp.md)
- [History import](docs/session-porter.md)
- [Migration](docs/migration.md)
- [Security](.github/SECURITY.md)

LongMemory is local-first, but recalled content remains untrusted evidence.
Keep credentials outside memory and repository files, preserve server-bound
identity, and require explicit human approval for high-impact decisions.
