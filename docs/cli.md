<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : docs/cli.md
 usage : documents LongMemory cli
-->

# Command-line interface

The `longmemory` CLI is a local SQLite interface to the same `createMemory` Hydrograph engine used by the package API and self-hosted server.

```bash
pnpm build
longmemory help --pretty
```

During repository development, replace `longmemory` with
`node --import tsx src/cli/index.ts`.

## Output and automation

Every finite command writes exactly one JSON document to stdout. Add `--pretty` for indented JSON. Errors are JSON on stderr and return a nonzero exit status.

When stderr is an interactive terminal, LongMemory displays its colored ASCII control-plane banner there. The banner never contaminates stdout and is automatically suppressed for pipes and subprocess capture. Set `NO_COLOR=1`, `TERM=dumb`, or use `--no-color` to disable ANSI color.

This behavior follows the automation conventions exposed by both terminal coding agents:

- [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli) separates non-interactive execution and machine-readable output from its TUI.
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) exposes print mode and JSON output for scripted calls.

LongMemory commands never prompt. This makes them safe to invoke from Codex, Claude Code, CI, shell pipelines, and MCP tools:

```bash
longmemory recall --user u1 --query "what do I prefer" --mode strict --db ./memory.db \
  | jq '.items[0].node.content.raw'
```

The single exception is the explicitly interactive `longmemory tui` wizard.
It refuses to run without a TTY. Every headless porter operation has a direct
command equivalent.

## Global options

| Option        | Description                                  |
| ------------- | -------------------------------------------- |
| `--db <path>` | SQLite database path                         |
| `--pretty`    | Indent JSON output                           |
| `--jsonl`     | Stream progress records, then a summary      |
| `--no-color`  | Disable ANSI color in the interactive banner |
| `--help`      | Print command help as JSON                   |

The database path resolves in this order: `--db`, `LONGMEMORY_DB_PATH`, then `./longmemory.db`. All stateful commands use SQLite.

Times accept epoch milliseconds or an ISO date such as `2026-03-01T00:00:00Z`.

## Session porter

```bash
longmemory tui
longmemory detect
longmemory session discover --from claude-code --limit 100
longmemory port --from claude-code --to longmemory --all
longmemory history inventory --from codex --all
longmemory history plan --from codex --all
longmemory port --from codex --to longmemory --id <confirmed-session-id> --history-manifest ./history-overrides.json --project <confirmed-project-id> --db ./central-memory.db
longmemory verify --from opencode --sample 10
```

The porter uses read-only Claude Code, Codex, and OpenCode adapters and one
portable session representation. It imports into the selected LongMemory project
as governed Chat Memory; it does not mutate proprietary harness stores. Normal
automation gets one JSON result, while `--jsonl` emits progress events. See
[session-porter.md](session-porter.md).

Codex history can span unrelated repositories and creative projects. Before
importing it, `history inventory` creates a read-only portable-session inventory
and `history plan` groups stable candidates by normalized working directory
while preserving source-session, parent-task, session, and fork relationships.
The plan emits unresolved groups plus a strict JSON override-manifest template;
cwd-wide and per-session decisions become importable only when explicitly
marked `confirmed: true`. Unknown fields, unknown sessions/cwds, and duplicate
assignments are rejected. `port --from codex --all` is disabled by design; use
explicit `--id` values for one confirmed project at a time. Copy
`plan.override_manifest_template` to a JSON file before editing it. Its
`inventory_id` binds the decisions to the complete parsed inventory, including
the safe derived content revision of every affected session and a reconciliation digest
for every source file. The emitted `source_snapshot` also freezes every
reviewed JSONL path at its last complete-line byte cutoff and binds that prefix
with SHA-256. Later appends and new tasks are deferred to a new inventory;
changes or truncation before a reviewed cutoff are rejected. Malformed or
unreadable files and importable files with skipped malformed lines block
authorization; empty and explicitly excluded tasks remain visible in the scan
counts but are not treated as memories. Codex import requires the
confirmed file as `--history-manifest` and requires explicit persistent `--db`
and `--project` targets. Each selected ID must be a confirmed assignment to that
project; excluded, unresolved, stale, duplicate, and other-project selections
fail before the destination database is opened. Other projects may remain
unconfirmed for a project-sized batch.

Selected Codex snapshots receive a versioned high-signal credential scan during
planning and authorization. The default remains a whole-batch block before
SQLite is opened. For an affected task, the emitted manifest contains a
`redaction_policy` proposal with `confirmed: false` globally and per session.
Only after a human explicitly confirms that exact policy and every selected
session may the importer create an in-memory derived snapshot. Each matched
span is replaced by a stable marker; the original source file is never changed.
Authorization binds the derived revision, detector and policy versions,
structural locations, kinds, exact terminal marker IDs/count, and a secret-free
transformation-manifest hash. It deliberately omits the original source-object
revision so the review artifact and database cannot become an offline secret
verifier. Staging must reuse the exact frozen derived object and live evidence
scoped from the issued authorization. Reports expose only safe evidence, never
a matched value, surrounding source text, or value-derived fingerprint. A
copied, forged, stale, edited, missing, duplicate, malformed, extra, or
unapproved marker fails closed.

## Authorize a dedicated history worker

Binding a Codex task to a project does not authorize it to read or publish
historical evidence. A human must grant that separate machine-enforced scope
through the local CLI. Every grant must explicitly select one run, one plan,
or all present and future runs in the project:

```bash
longmemory history worker authorize <codex-session-id> \
  --run-id <history-run-id> \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id authorize-history-worker-001 \
  --confirm-human
```

Use `--plan-id <history-plan-id>` instead of `--run-id` for a plan scope. A
project-wide grant requires the deliberately explicit `--all-runs` flag; it
cannot be combined with either narrow selector. Revoke and inspect grants with:

```bash
longmemory history worker revoke <authorization-id> --db <db> --project <id> \
  --action-id revoke-history-worker-001 --confirm-human
longmemory history worker list --db <db> --project <id>
longmemory history worker list --db <db> --project <id> --all
```

Authorization binds tenant, user, project, Codex session, server-derived worker
identity, and optional run/plan scope. Revocation takes effect immediately,
including for an already leased chunk. Scope and audit evidence are immutable;
the runtime recomputes the persisted scope hash on every use.

## Govern Codex history publication

Use the local governance commands only after a human has reviewed the exact
candidate, hierarchy proposal, plan, or confirmation. These commands write to
the existing central SQLite database; they do not extract history or create a
publication plan.

Every decision requires the same authority flags:

```bash
--db /absolute/path/to/central-memory.db \
--project confirmed-project-id \
--action-id operator-chosen-id \
--confirm-human
```

`--db` must name an existing persistent database, and `--project` cannot be
`current`. The target must belong to the resolved tenant, CLI user, and project.
Set the tenant with `LONGMEMORY_TENANT_ID`; select the CLI user with `--user`,
`LONGMEMORY_USER_ID`, or local configuration. LongMemory derives the recorded
actor from that CLI user and generates the `local_cli` evidence itself. The
commands reject caller-supplied evidence, actor, or channel fields.

Use a stable, unique `--action-id` for each human decision. Replaying the same
action with identical content is idempotent; reusing its ID for different
content fails. Pass `--confirm-human` as a bare flag only after the decision is
explicit. `--confirm-human=false` and `--dry-run` cannot submit a decision. An
optional `--note` records up to 2,000 characters of rationale.

History-governance actions require these selectors:

| Action | Selector | Valid use |
| ------ | -------- | --------- |
| `accept_hierarchy` | `--proposal-id <id>` | Accept the selected hierarchy proposal and materialize proposed roles or tasks |
| `reject_hierarchy` | `--proposal-id <id>` | Reject the selected hierarchy proposal for revision |
| `approve_update` | `--plan-version <number>` | Approve the current plan whose relation is `update` |
| `approve_conflict` | `--plan-version <number>` | Approve the current plan whose relation is `conflict` |
| `retry` | None | Return a `retryable` publication to `ready` after correcting the failure |
| `discard` | None | Terminate a publication that should not proceed |

For example, accept a reviewed hierarchy proposal:

```bash
longmemory history govern accept_hierarchy <publication-id> \
  --proposal-id <proposal-id> \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id accept-hierarchy-001 \
  --note "Reviewed project, role, and task assignment" \
  --confirm-human
```

Approve a reviewed update or conflict against the exact current plan version:

```bash
longmemory history govern approve_update <publication-id> \
  --plan-version 3 \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id approve-update-001 \
  --confirm-human
```

After the worker executes a level-1, major-rule, or conflict plan, it can return
`pending_confirmation`. Resolve that separate central-memory gate with the
reported confirmation ID:

```bash
longmemory history confirm approve <confirmation-id> \
  --db /absolute/path/to/central-memory.db \
  --project confirmed-project-id \
  --user local-operator \
  --action-id approve-confirmation-001 \
  --confirm-human
```

`history confirm` accepts `approve`, `reject`, or `cancel`. When the confirmation
belongs to a history publication, the command also reconciles that publication
to the authoritative result. Historical transcript text never satisfies
`--confirm-human` and cannot authorize any of these actions.

## Govern project links

Projects are isolated unless a human creates an explicit directed link. Each
direction allows only query-relevant L4 memory to be recalled from the source
project by the target project. It does not merge the projects, move tasks, or
share L1-L3 rules.

```bash
longmemory project link create novel ai-painting \
  --two-way \
  --db /absolute/path/to/central-memory.db \
  --project novel \
  --user local-operator \
  --action-id link-novel-art-001 \
  --confirm-human

longmemory project link list \
  --status active \
  --db /absolute/path/to/central-memory.db \
  --project novel \
  --user local-operator

longmemory project link revoke <directed-link-id> \
  --db /absolute/path/to/central-memory.db \
  --project novel \
  --user local-operator \
  --action-id revoke-novel-art-001 \
  --confirm-human
```

Omit `--two-way` to create only `source -> target`. Revocation affects one
direction, retains its audit record, retracts that direction's existing linked
worksets, and prevents future recall. `create` and `revoke` require an existing
persistent database, an endpoint selected by explicit `--project`, a stable
action ID, and `--confirm-human`.

## Obsidian projection

```bash
longmemory obsidian project \
  --db ./central-memory.db \
  --vault ./KnowledgeVault
longmemory obsidian project \
  --db ./central-memory.db \
  --vault ./KnowledgeVault \
  --projection-root SharedMemory \
  --dry-run
```

The command opens an existing central-memory database read-only and projects it
as deterministic Markdown pages. The default generated folder is `LongMemory`;
human changes belong in `LongMemory/Proposals/inbox/`. Projection is atomic and
idempotent, and it refuses to overwrite generated files changed outside
LongMemory. `--dry-run` validates the database and resolved output settings
without writing the vault. In addition to projects, tasks, formal memories,
sources, confirmations, conflicts, and dependencies, the vault exposes the
directed project-link records, history-publication queue, hierarchy proposals, immutable governance decisions,
publication plans, and execution attempts. Separate dashboards show pending
hierarchy decisions, changed-content review, and central confirmation.
Before writing Markdown, the projector scans the complete scoped projection
snapshot and fails closed on obvious credential material without echoing its
value. This prevents a legacy or manually altered database from copying a
secret into the vault; it does not remove the source row or clean an older
projection that was produced by another version.

## Serve

```bash
longmemory serve --db ./memory.db
longmemory serve --db ./memory.db --host 0.0.0.0 --port 7331
```

`serve` creates the memory facade directly and injects it into the Phase 20 HTTP transport. It prints one readiness JSON document containing the URL, database path, store, and process ID, then runs until `SIGINT` or `SIGTERM`.

The server also reads the Phase 20 environment settings documented in [api.md](api.md).

## Ingest

```bash
longmemory ingest \
  --db ./memory.db \
  --user u1 \
  --text "I prefer tea" \
  --at 2026-01-01T00:00:00Z \
  --pretty
```

Optional ingest flags are `--world <name>` and `--external`.

## Recall

Strict recall:

```bash
longmemory recall \
  --db ./memory.db \
  --user u1 \
  --query "what do I prefer" \
  --mode strict
```

Historical recall uses the same command:

```bash
longmemory recall \
  --db ./memory.db \
  --user u1 \
  --query "what did I prefer" \
  --mode historical \
  --valid-time 2026-01-01T00:00:01Z
```

`--mode` is required and accepts `strict`, `historical`, `associative`, or `world_grounded`. Optional flags include `--recorded-time`, `--at`, `--world`, and `--k`.

## Explain

```bash
longmemory explain --db ./memory.db --id node_id --pretty
```

The result contains the persisted node, incoming and outgoing executable edges, and an ingest trace when it is available in the current process.

## Worlds

```bash
longmemory worlds --db ./memory.db
longmemory worlds --db ./memory.db --zone endocortex --limit 20
```

## Entities

```bash
longmemory entities --db ./memory.db --query "Alice Chen"
```

The command delegates to conservative entity resolution and returns its merge, candidate, or creation decision. `--at` sets the observation time.

## Timeline

```bash
longmemory timeline \
  --db ./memory.db \
  --entity entity_id \
  --valid-time 2026-01-01T00:00:01Z
```

The CLI resolves the entity ID through the facade and requests its historical timeline by canonical name. `--recorded-time` is also supported.

## Benchmark

```bash
longmemory bench --pretty
```

This runs the benchmark checks shipped inside the published package and exits nonzero when a check fails. The full development harness remains available through `pnpm bench` and `pnpm bench:ci`.

## Reusable Skills

```bash
longmemory skill create \
  --name "Release check" \
  --description "Validate a release" \
  --triggers "release checklist,publish package" \
  --instructions-json '["Run tests","Build packages"]' \
  --validation-json '["Tests pass"]'
longmemory skill bind <skill-id> --agents reviewer
longmemory skill match "run the release checklist" --agent reviewer
longmemory skill list --all
longmemory skill archive <skill-id>
```

Creating with an existing `--id` writes a superseding version. Bindings also
create a version, so loadout changes remain historically explainable.

## Governed memory assets

```bash
longmemory asset list
longmemory asset register \
  --type llm_wiki \
  --name "Architecture wiki" \
  --description "Project architecture" \
  --owner alice \
  --source-type docs \
  --content-ref longmemory://project/current/wiki \
  --status candidate
longmemory asset govern <asset-id> --status approved \
  --agents reviewer --mode tool --priority 0.8
longmemory asset loadout "review architecture" \
  --agent reviewer --framework codex
longmemory agent manifest reviewer --framework codex \
  --query "review architecture"
```

Conversation imports, Skills, document sync, and repository sync automatically
register Chat Memory, Skill, LLM-Wiki, and CodeGraph assets. Inferred/imported
assets begin as candidates; curated Skills begin approved. Use `--input-json`
and `--patch-json` for complete ACL, binding, payload, and metadata contracts.
See [agent-assets.md](agent-assets.md).

## CodeGraph

```bash
longmemory code search createMemory
longmemory code callers createMemory
longmemory code callees createMemory
longmemory code impact createMemory --depth 5
```

Queries use code symbols and call relations persisted by repository connector
sync. Output includes file/line, language, commit, and backing memory identity.

## Past agent sessions

```bash
longmemory session import ./history/codex-42.json
longmemory session list
```

The input is a JSON object containing `session_id`, `agent_id`, `provider`, and
`messages`. Each message has `role`, `content`, and an optional epoch-millisecond
`at`, `name`, and `tool_call_id`. Imports validate all content and monotonic
timestamps before writing. Session IDs are unique within a project.

## Migrate

```bash
longmemory migrate \
  --from ./old.db \
  --to ./new.db \
  --report ./migration-report.json \
  --pretty
```

Migration reads legacy SQLite, JSON, or JSONL memory; skips corrupt and duplicate records; maps useful records through `createMemory`; restores supported relations; and runs an integrity/hydration benchmark against the destination. Current Hydrograph databases use SQLite online backup. The command refuses to overwrite a destination or migrate a database onto itself.

The detailed audit is returned on stdout and written to `--report`, or `<destination>.migration-report.json` by default. See [migration.md](migration.md) for supported fields, mapping rules, and report semantics.

## Agent examples

Codex non-interactive task:

```bash
codex exec --json 'Run longmemory recall --user u1 --query "current preference" --mode strict --db ./memory.db and summarize the JSON result.'
```

Claude Code print-mode task:

```bash
claude -p --output-format json 'Run longmemory worlds --db ./memory.db and identify the active endocortex worlds.'
```
