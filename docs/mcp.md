<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : docs/mcp.md
 usage : documents LongMemory mcp
-->

# MCP integration

LongMemory exposes one high-level Model Context Protocol server over the same
`createMemory` engine used by the package, CLI, REST API, projects, and
connectors. It supports local stdio and remote Streamable HTTP transports.

## Local stdio

```powershell
longmemory mcp --db .longmemory/project.db --project current
```

An MCP client can launch the same command directly:

```json
{
  "mcpServers": {
    "longmemory": {
      "command": "longmemory",
      "args": ["mcp", "--db", ".longmemory/project.db", "--project", "current"]
    }
  }
}
```

The stdio command writes only MCP protocol messages to stdout. Use
`--read-only` to open an existing SQLite database without migrations or writes.
Use `--audit <path>` to override the default
`<database>.mcp-audit.jsonl` path.

The bundled Codex lifecycle plugin launches stdio with
`--profile codex-memory-gateway`. This restrictive profile registers only
`longmemory_codex_memory`, `longmemory_history_backfill`, and
`longmemory_history_publication`. All three enforce the same locked
current-session, current-turn capability. It omits general-purpose legacy
tools, human governance tools, resources, and prompts. Runtime roles, a central
thread id, or an explicit `allowed_tools` value cannot broaden the profile.
`longmemory_history_governance` is separate: it is absent from both this
profile and the default allowlist, requires an explicit
`central_memory_approver` role, and derives its human actor from the trusted
runtime rather than tool arguments. The approver-only
`longmemory_central_confirmation` tool is also absent from both surfaces. On an
unrestricted default-profile server, the explicit `central_memory_approver`
role makes both tools eligible unless `allowed_tools` narrows the surface. An
allowlist cannot substitute for the approver role. The restrictive Codex
profile cannot be broadened by either mechanism.

`longmemory_central_project_link` is another separate governance surface. It
is absent from the default and Codex gateway allowlists and becomes
role-derived only when the runtime has both `central_memory_approver` and
`central_memory_admin`. `create` records one or two directed, human-evidenced
links; `revoke` preserves the immutable audit row and retracts affected linked
worksets. A link authorizes only relevant active L4 recall from its source
project into its target project. It never authorizes cross-project publication,
L1-L3 propagation, or project hierarchy changes.

The publication worker exposes only `list`, `get`, `propose_hierarchy`,
`create_plan`, `execute`, and `reconcile_confirmation`. Its project, task,
worker, and source identities are server-derived, and every successful result
is bounded to the same 1,800-token transport ceiling used by the lifecycle
context. Accept/reject, update/conflict approval, retry, and discard are
available only through the approver tool. Neither tool treats historical text
as instructions or as evidence of a current user decision.

Both history tools also require an active dedicated-worker authorization stored
in central SQLite. Ordinary tasks remain denied even when they are bound to the
same project and hold a valid turn capability. MCP arguments and task-binding
arguments cannot create or widen this grant. Run/plan scope is rechecked for
every claim, status read, candidate listing, proposal, plan, execution, and
reconciliation; a local CLI revocation immediately closes the worker path.

For on-machine review, `longmemory history govern` and `longmemory history
confirm` provide a separate trusted CLI path. They require explicit persistent
database, project, action-ID, and human-confirmation flags, derive the actor and
evidence locally, and never expose approver authority to the bundled Codex MCP
gateway. See the [CLI governance reference](cli.md#govern-codex-history-publication).

## Streamable HTTP

```powershell
longmemory serve --db ./longmemory.db --mcp-http
```

The endpoint is `http://127.0.0.1:7331/mcp`. REST and MCP share one in-process
memory engine. When `LONGMEMORY_API_KEY` is set, MCP requires the same bearer
token or `X-API-Key` as `/v1/*`. `LONGMEMORY_MCP_HTTP=true` also enables it for
`pnpm serve`.

## Tools

The core general-purpose surface contains these thirteen high-level tools:

- `longmemory_project_context`
- `longmemory_recall`
- `longmemory_ingest`
- `longmemory_remember_decision`
- `longmemory_update_task_state`
- `longmemory_explain`
- `longmemory_report_conflicts`
- `longmemory_sync_connector`
- `longmemory_match_skills`
- `longmemory_manage_skill`
- `longmemory_code_graph`
- `longmemory_asset_catalog`
- `longmemory_manage_asset`

Additional central-memory and history tools depend on the selected profile,
central-thread scope, and runtime roles. The role-derived default surface omits
`longmemory_history_governance` and `longmemory_central_confirmation`; an
explicit `central_memory_approver` role makes them eligible. An explicit tool
allowlist does not grant that role. The `codex-memory-gateway` profile always
advertises only its three turn-capability-gated worker tools.

The additional `longmemory_central_project_link` governance tool requires both
the approver and central administrator roles and is not exposed by either
default surface. Its `list`, `create`, and `revoke` actions manage directed,
L4-only recall links between projects.

Recall delegates to Hydrograph modes and their temporal, contract,
contradiction, grounding, confidence, world, and permission gates. Connector
sync defaults to `dry_run: true`. Read-only mode rejects write-capable tools.
Skill matching can filter an agent loadout; Skill management creates immutable
versions, bindings, or archive versions. CodeGraph is read-only and provides
symbol search, callers, callees, and reverse impact paths from persisted source
snapshots.

Asset catalog calls discover governed Chat Memory, Skill, LLM-Wiki, and
CodeGraph records or assemble a target-specific loadout. Asset management is a
write tool, requires owner or explicit `manage` ACL, and is blocked by MCP
read-only mode. Runtime configuration fixes user/team/role/agent/framework
identity; tool arguments cannot impersonate another configured agent.

## Resources

- `longmemory://projects`
- `longmemory://project/{project_id}/summary`
- `longmemory://project/{project_id}/current-context`
- `longmemory://project/{project_id}/decisions`
- `longmemory://project/{project_id}/tasks`
- `longmemory://project/{project_id}/skills`
- `longmemory://project/{project_id}/assets`
- `longmemory://project/{project_id}/asset/{asset_id}`
- `longmemory://project/{project_id}/agent/{agent_id}/manifest`
- `longmemory://project/{project_id}/conflicts`
- `longmemory://entity/{entity_id}`
- `longmemory://world/{world_id}`
- `longmemory://memory/{node_id}`

Direct memory, entity, and world reads enforce configured user and project
scope. Denied candidates are removed from MCP diagnostic traces as well as
result items.

## Prompts

- `longmemory_before_coding`
- `longmemory_after_coding`
- `longmemory_debug_session`
- `longmemory_project_handoff`
- `longmemory_architecture_context`

Prompts never interpolate connector content as instructions. Retrieved memory
must remain delimited as untrusted `<longmemory-data>` evidence.

## Programmatic server

```ts
import { create_longmemory_mcp } from "longmemory";

const { server, runtime } = create_longmemory_mcp({
  db_path: "./longmemory.db",
  project_id: "longmemory",
  user_id: "agent:local",
  read_only: true,
});
```

`allowed_tools` can reduce the advertised tools. Unknown names are rejected at
startup, and omitted tools are not registered.
