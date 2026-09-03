<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : integrations/codex-longmemory/README.md
 usage : configures the LongMemory codex-longmemory integration
-->

# LongMemory for Codex and ChatGPT

This plugin adds a local, governed central-memory layer to Codex. SQLite is the
authoritative store; Codex hooks load a bounded working set and the bundled MCP
server exposes a turn-capability gateway for task binding, recall, and turn
finalization.

```text
Codex lifecycle hooks
        |
        v
SQLite central truth  <---- immutable versions, confirmations, conflicts
        |
        +---- per-task working sets and immutable delivery ledger
        |
        +---- governed L4-only links between otherwise isolated projects
        |
        +---- read-only Obsidian/Markdown projection for human governance
```

Obsidian is a management and browsing surface, never a second source of truth.
The projector reads SQLite without write access and materializes deterministic
Markdown pages for projects, roles, tasks, threads, formal memories, versions,
evidence, confirmations, conflicts, dependencies, project links, and dashboards.

## Prerequisites

The hook launcher invokes the `longmemory` executable. Build and make the CLI
available before enabling the plugin:

```bash
pnpm install
pnpm build
pnpm link --global
longmemory version
```

Node.js 20 or newer is required. The plugin does not hard-code a checkout path.
If global linking is unsuitable, set `LONGMEMORY_CLI_COMMAND` to one executable
path (or directly to this package's built `dist/cli/index.js`). It is a path,
not a shell command line; arguments are supplied by the plugin launcher.

Add the repository or a local marketplace with `codex plugin marketplace add`,
then install the `longmemory` plugin from the Codex Plugins Directory. Restart
Codex after installing or updating it. Open `/hooks`, review the bundled hook
definition, and trust its current hash; non-managed hooks do not run before
that review.

## Local storage

By default the plugin uses:

- `${PLUGIN_DATA}/central-memory.db` for the shared SQLite truth;
- `${PLUGIN_DATA}/sessions/*.json` for random turn-scoped capabilities,
  task binding metadata, and compaction checkpoints;
- `${PLUGIN_DATA}/failures/hook-errors.jsonl` for bounded fail-open diagnostics.

Session filenames are SHA-256 hashes rather than raw Codex task ids. Registry
files are written atomically and with owner-only mode where the OS supports it.
The registry is capability/binding state, not a second memory authority.
Staged, acknowledged, and superseded delivery receipts live in the central
SQLite ledger; losing registry files cannot falsely consume a memory or
suppress a retraction.

Set an absolute `LONGMEMORY_DB_PATH` to use an existing local central database.
The Codex Hook, MCP launcher, and Obsidian projection intentionally ignore a
workspace `.longmemory/config.json` database path so one workspace cannot split
the central store. An explicit central SQLite path is the only data location
outside `PLUGIN_DATA`. Do not point it at a network share. `LONGMEMORY_TENANT_ID` and
`LONGMEMORY_USER_ID` select the local scope.

The bundled server is stdio-only. This integration does not listen on a network
interface and does not upload memory. Its launcher selects the
`codex-memory-gateway` MCP profile, which registers only the turn-capability
gateways for lifecycle memory, authorized history extraction, and history
publication. General-purpose legacy write tools, human governance tools,
resources, and prompts are not registered on this server, even if runtime
roles or thread settings would normally enable them. Historical accept,
approve, retry, and discard decisions require either the trusted local CLI or a
separately configured approver-only MCP server. They cannot be submitted
through the bundled worker gateway.

## Obsidian management vault

Generate or refresh an Obsidian-compatible vault from the central database:

```bash
longmemory obsidian project \
  --db /absolute/path/to/central-memory.db \
  --vault /absolute/path/to/KnowledgeVault
```

Use `--projection-root <folder>` to replace the default `LongMemory` folder.
The command opens SQLite read-only and performs atomic, idempotent projection.
It refuses path traversal, symbolic-link escapes, an invalid or foreign
manifest, unknown files at generated targets, and overwriting generated pages
that were edited outside LongMemory.

Human-authored proposals belong under `LongMemory/Proposals/inbox/`. This inbox
is deliberately excluded from the generated-file manifest, so later projections
preserve it. Obsidian is optional at projection time; the output is ordinary
local Markdown and can be opened in Obsidian whenever it is installed.

The vault includes the complete governed history-publication surface: final
compressed candidates, hierarchy proposals, immutable human decisions,
publication plans with their exact CAS snapshots, and execution attempts.
Dashboards keep pending hierarchy review, pending changed-content review, and
pending central confirmation separate. Directed project links have their own
pages and project-page incoming/outgoing lists. These remain read-only audit views;
editing a generated note never counts as approval and never writes SQLite.

## Submit reviewed decisions locally

The Obsidian vault is a read-only review surface. After a human chooses an
action, submit it against the exact central database and project with the local
CLI. For example:

```bash
longmemory history govern accept_hierarchy <publication-id> \
  --proposal-id <proposal-id> \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id accept-hierarchy-001 \
  --confirm-human

longmemory history confirm approve <confirmation-id> \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id approve-confirmation-001 \
  --confirm-human

longmemory project link create novel ai-painting \
  --two-way \
  --db /absolute/path/to/central-memory.db \
  --project novel \
  --user local-operator \
  --action-id link-novel-art-001 \
  --confirm-human
```

Both commands require an existing persistent `--db`, an explicit `--project`,
a caller-stable `--action-id`, and a bare `--confirm-human` flag. The target must
belong to the resolved tenant, CLI user, and project. The CLI derives the human
actor from its resolved user and creates immutable `local_cli` evidence; it
does not accept caller-supplied actor, channel, or evidence fields.

Use `accept_hierarchy` or `reject_hierarchy` with `--proposal-id`. Use
`approve_update` or `approve_conflict` with the exact current `--plan-version`.
`retry` is valid only for a `retryable` publication, while `discard` requires no
proposal or plan selector. `history confirm` accepts `approve`, `reject`, or
`cancel` and reconciles a linked history publication. See the
[CLI governance reference](../../docs/cli.md#govern-codex-history-publication)
for the complete flow.

Project links do not merge projects. Each stored direction permits only
query-relevant active L4 memory to cross from its source into its target. The
hook marks linked content as external project memory and ranks it below the
current task and local project. L1-L3 rules and hierarchy never cross, and a
revoked direction retracts existing linked worksets.

## Lifecycle behavior

`SessionStart` handles `startup`, `resume`, `clear`, and `compact`:

- A new task is not guessed from its title, cwd, or first request. Codex first
  asks the user which project the task belongs to and what the conversation is
  responsible for.
- After that explicit answer, Codex calls `longmemory_codex_memory` with
  `action=bind` using the capability and `turn_id` injected by the current
  `UserPromptSubmit` hook. When the live conversation already contains a
  concrete active request (including the unresolved initiating request),
  `initial_query` runs one bounded, project-scoped recall after the task is
  registered and before its first context is built. This can stage a relevant
  level-4 memory owned by another role without creating a permanent
  subscription. SessionStart does not expose an actionable token.
- A bound task receives all available level-1/2 compact map entries, a broad
  level-3 map, and the most relevant level-4 bodies under one strict 1,800-token
  total budget. The project selector remains limited to levels 1–3; without an
  `initial_query`, unrelated cross-role level-4 memories are not loaded merely
  because they share the project.
- If a human-governed project link exists, focused recall may additionally
  stage relevant L4 memory from the link's source project. Linked memory is
  rendered in a separate section and remains lower priority than current-task
  state and same-project memory. No linked L1-L3 entry is eligible.
- Injected text is always labelled `【中央记忆（外部、可更新）】`. Current user
  instructions and the live task state outrank it. The hook does not duplicate
  a `【本任务工作状态】` or `【当前任务契约】` block from the conversation.

`UserPromptSubmit` performs bounded local lexical recall against current
level-4 versions, stages the matches in this task's work set, synchronizes at a
safe boundary, and injects only the related details/updates/retractions.
It atomically activates a fresh capability when `turn_id` changes and preserves
that pair across retries of the same turn. A later UserPromptSubmit or any
SessionStart invalidates the preceding token. `bind`, `recall`, and
`record_turn` all require the current capability plus its exact `turn_id`.
When a task needs a deeper expansion, the same turn-capability gateway offers
`action=recall`; it searches and returns this central SQLite store rather than
the legacy LongMemory runtime.

Each bound `UserPromptSubmit` also carries a compact per-turn submission
contract. Codex can therefore call `record_turn` before its first stop; the
`Stop` hook is a fallback for a missed submission, not an expected second model
pass on every response. Memory context plus this contract still shares the one
strict 1,800-token budget.

Every injected or recalled context carries a visible, content-addressed
`delivery_id`. Its immutable staged receipt is stored in central SQLite before
hook output, but it is not treated as delivered merely because another hook
arrives. `record_turn` explicitly returns every actually visible id through
`acknowledged_delivery_ids`; validation, work-set consumption, retraction
acknowledgement, memory writes, and finalization share one `IMMEDIATE`
transaction. Equivalent crash retries reuse one receipt, changed retries are
marked superseded without being falsely acknowledged, and unconfirmed content
continues to be delivered. Resume or compaction intentionally re-injects
tombstones so compacted context cannot revive a withdrawn fact.

`PreCompact` stores the exact synchronized/consumed checkpoint. `PostCompact`
synchronizes pending versions. The current Codex wire format does not allow
`PostCompact` to add developer context, so actual re-injection happens in the
officially paired `SessionStart(source=compact)` call before the next model
request.

`Stop` checks for an idempotent turn-finalization event. If it is missing, the
first Stop invocation creates one continuation prompt requiring Codex to make a
formal-memory decision. If the normal UserPromptSubmit credential is absent or
belongs to another turn, Stop first activates the current turn and includes its
new capability in that continuation prompt. The second invocation
(`stop_hook_active=true`) always
continues so the hook cannot loop, but it atomically records a
`central_memory.turn_unfinalized` recovery event containing the session/turn,
assistant-message hash, and reason. It never fabricates `memories=[]`.

The turn gateway accepts zero to twenty memory candidates and publishes all of
them plus `memory_refs[]` and finalization in one SQLite `IMMEDIATE`
transaction. Retrying an identical turn returns the existing result; a
different retry is rejected. Updating a stable memory id requires
`expected_current_version`, so the agent cannot blindly overwrite a newer
version.

The Stop review is the only automatic write path for hook-managed tasks. The
skill does not also invoke the legacy `remember_decision`, `update_task_state`,
or `ingest` tools, avoiding duplicate records with different governance.

Formal memory candidates are limited to:

1. what was completed, in reusable summary form;
2. transferable knowledge;
3. a problem plus its verified solution;
4. a conclusion that was actually established;
5. a durable requirement or constraint.

Transient disconnects, incidental errors, progress questions, ordinary concept
explanations, credentials, hidden reasoning, and unhelpful trial-and-error are
excluded. Reproduction memories must preserve exact parameters, software/model
versions, seed, step count, dependencies, and the reason those values were
chosen. A future reader should be able to answer both “what was done?” and
“why?” from the memory itself.

Level-1 memories, major rules, lock requests, and conflict conclusions can only
become `pending_confirmation`. The session gateway has no confirmation or
cross-thread authority and cannot forge user evidence. Conflict references are
reported to the central conflict queue in the same transaction.

All hook failures return valid fail-open JSON so normal Codex work continues.
SQLite compare-and-swap conflicts and malformed candidates are never retried as
blind writes.

## Native Codex Memories

Codex also has an optional native Memories feature under `~/.codex/memories`.
It is a useful future backfill source (summaries/raw memories/rollout summaries),
but it is not a replacement for governed versions, task subscriptions,
retraction receipts, or major-rule confirmation. Do not enable duplicate runtime
injection from both systems. If native Memories are enabled separately, import
their output as attributed historical evidence and let this plugin remain the
only injected central-memory working set. This plugin does not modify the
global Codex feature flag.

## Updating the plugin

After changing this local plugin, rebuild and refresh the installed plugin copy,
restart Codex, and review the new hook hash in `/hooks`. A new task is the most
reliable place to verify updated bundled MCP tools and lifecycle definitions.
