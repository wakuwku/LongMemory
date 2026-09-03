<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : docs/session-porter.md
 usage : documents LongMemory session porter
-->

# Coding-harness session porter

LongMemory provides a terminal-first workflow for discovering and importing local
AI terminal and code-editor conversations into governed Chat Memory. Supported
sources are Claude Code, Codex, OpenCode, Gemini CLI, VS Code Copilot Chat,
Cline, and DeepSeek Harness raw session logs.

```text
Coding harness stores -> portable session IR -> LongMemory project -> Chat Memory asset
```

Source adapters are read-only. LongMemory never writes proprietary harness or
editor session stores. Imported context becomes a durable project
asset that any configured agent or framework can access through CLI, MCP, VS
Code, or the portable agent manifest.

## Interactive transfer utility

```powershell
longmemory tui
```

The native terminal utility uses an original three-phase flow:

1. **Library** detects readable local archives and confirms the current workspace.
2. **Review** previews conversations by workspace and recent activity for selection.
3. **Transfer** imports immutable revisions, reports progress, and presents a receipt.

The interface is styled as a compact desktop utility with a persistent phase
rail. It intentionally does not reproduce another porter's screen sequence,
labels, branding, or interaction choreography.

Selection accepts `all`, comma-separated rows such as `1,3,5`, and ranges such
as `2-6`.

## Headless commands

```powershell
longmemory detect
longmemory session discover --from claude-code
longmemory port --from claude-code --to longmemory --all
longmemory history inventory --from codex --all
longmemory history plan --from codex --all
longmemory port --from codex --to longmemory --id <session-id> --history-manifest ./history-overrides.json --project <project-id> --db ./central-memory.db --agent builder
longmemory verify --from opencode --sample 10
longmemory session wiki --from gemini-cli --all --name "Project decisions"
longmemory session wiki --from copilot-chat --id <session-id> --agent reviewer --status approved
```

`port` accepts exactly one source harness and the `longmemory` destination. Use
`--all` or repeat `--id`. `--force` creates a new asset version even when the
source revision is unchanged. Codex is intentionally stricter: interactive TUI
transfer and `--all` are disabled, and every batch requires explicit history
manifest, project, and persistent database authorization.

Normal non-interactive output remains one JSON document. Use `--jsonl` to emit
progress events followed by a summary record:

```powershell
longmemory port --from codex --to longmemory --id <session-id> --history-manifest ./history-overrides.json --project <project-id> --db ./central-memory.db --jsonl
```

## Codex history authorization

Codex history often contains unrelated repositories and creative projects.
`history inventory` freezes the complete source-path set and each JSONL file's
last newline-committed byte prefix, then parses those exact prefixes without
writing a database. `history plan` emits stable cwd candidates, parent/fork
relationships, per-session safe content revisions, and
`plan.override_manifest_template`. Copy that template to a JSON file, review
the candidates, and set only approved cwd or session assignments to
`confirmed: true`.

The manifest's `inventory_id` covers the exact safe review snapshots. For a
credential-affected session the content revision is computed from its
deterministically derived snapshot, never from the credential-bearing source
object. The inventory also includes a reconciliation digest accounting for
every source file. Its
`source_snapshot` also binds every reviewed path to an exact byte cutoff and
SHA-256 prefix hash. At import time LongMemory reopens only that approved set.
Records appended after a cutoff and files created after the inventory are left
for the next inventory, while a changed or truncated approved prefix fails
closed. Moving an unchanged task from active to archived Codex storage is
accepted only when its basename and exact prefix hash still match. Legacy
manifests without `source_snapshot` retain the older strict live-inventory
check. Malformed/unreadable files and otherwise importable files with skipped
malformed lines block the batch. Empty and explicitly excluded tasks remain
explicit non-importable scan counts. Every requested `--id` must be a confirmed
`assign` to the exact explicit `--project`; excluded, unresolved, unconfirmed,
duplicate, and other-project IDs are rejected before opening `--db`. Other
projects may remain unconfirmed, so reviewed projects can be imported in batches.
The write phase reuses the same parsed objects that passed authorization and
records `inventory_id`, `reconciliation_digest`, `plan_id`, `manifest_hash`,
`source_revision`, target project, and target database in the governed asset
metadata. It also creates immutable history-backfill runs in the explicitly
authorized central database. Runs are split without dropping source text and
are processed only by a task/turn capability scoped to that project.

Because snapshots and chunks are immutable, authorization scans every selected
snapshot for high-signal credential material before SQLite is opened. A match
blocks the batch by default and adds an unconfirmed, versioned
`redaction_policy` proposal to the review manifest. Only explicit human
confirmation of the complete policy and each affected session permits an
in-memory derived snapshot; the original source file is never changed.

Every matched span, including marker-shaped source text, is replaced by a
deterministic marker. The approved evidence binds the derived revision,
detector and policy versions, structural locations, credential kinds, exact
terminal marker IDs/count, and a secret-free transformation-manifest hash. It
does not expose a hash of the credential-bearing source object. Immutable
staging accepts marker-bearing content only with a live evidence object scoped
from that exact issued authorization; copied, forged, stale, missing,
duplicated, malformed, or extra markers fail closed. Reports contain only safe
session references, counts, detector kinds, and structural locations. Tests
verify that removed values never reach SQLite, errors, receipts, candidates, or
the Obsidian projection.

Extraction does not write formal memory directly. Workers first produce
source-located findings, then perform bounded multi-round consolidation. Only
the final consolidated receipt can enter the history-publication queue. A
second worker boundary proposes the four-level hierarchy, creates an immutable
CAS plan, and executes it. New roles/tasks, changed content, conflicts, and
level-1 or major rules pause at their respective human-governance or central
confirmation gates. Historical transcript text remains untrusted evidence and
is never current authorization. Replaying the same candidate is idempotent;
newer current-task memory cannot be overwritten by a stale historical plan.

A project binding alone never creates worker authority. Before extraction, a
human uses `history worker authorize` to grant the exact Codex session a run,
plan, or explicit `--all-runs` scope. The same persisted authorization gates
extraction, consolidation, and publication, and `history worker revoke`
invalidates outstanding leases before they can submit.

## Human publication governance

Review pending items in the read-only Obsidian projection or through a
separately configured approver interface. Submit the resulting human decision
through the trusted local CLI:

1. Accept or reject a hierarchy proposal with `history govern
   <accept_hierarchy|reject_hierarchy>`, the publication ID, and its exact
   `--proposal-id`.
2. Let the publication worker create an immutable plan. If its relation is
   `update` or `conflict`, approve the exact current `--plan-version` with
   `approve_update` or `approve_conflict`.
3. Let the capability-scoped worker execute a ready plan. If the result is
   `pending_confirmation`, resolve the reported confirmation ID with `history
   confirm <approve|reject|cancel>`.
4. Use `retry` only after a failed publication is `retryable`. Use `discard` to
   terminate a candidate that should not proceed.

Every governance command requires an existing persistent `--db`, the exact
`--project`, a unique `--action-id`, and an explicit bare `--confirm-human`
flag. LongMemory derives the actor and evidence from the local CLI context and
rejects cross-project targets or caller-supplied evidence. See the
[CLI governance reference](cli.md#govern-codex-history-publication) for commands
and selector requirements.

## AI Wiki conversion

`session wiki` converts selected conversations into a governed `llm_wiki`
asset. The Markdown contains an index, source and workspace provenance, stable
timestamps, and normalized user/agent sections. The transformation is
deterministic and does not invent model-generated summaries or claims.

The first conversion creates the asset, unchanged source history is skipped,
and changed conversations create a new immutable asset version. Use `--agent`
to add a direct agent binding. Wiki assets default to `candidate`; pass
`--status approved` only when the conversation set has been reviewed.

## Detection and overrides

| Harness              | Default source                                                                     | Override                                                     |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Claude Code          | `~/.claude/projects`                                                               | `LONGMEMORY_CLAUDE_PROJECTS`                                 |
| Codex                | `$CODEX_HOME/sessions` or `~/.codex/sessions`                                      | `LONGMEMORY_CODEX_SESSIONS`                                  |
| OpenCode             | `$XDG_DATA_HOME/opencode/opencode.db`                                              | `OPENCODE_DB`                                                |
| Gemini CLI           | `~/.gemini/tmp/*/chats/session-*.json[l]`                                          | `LONGMEMORY_GEMINI_SESSIONS`                                 |
| VS Code Copilot Chat | VS Code-compatible `User/workspaceStorage/*/chatSessions`                          | `LONGMEMORY_COPILOT_CHAT_SESSIONS`                           |
| Cline                | VS Code-compatible `User/globalStorage/{saoudrizwan.claude-dev,cline.cline}/tasks` | `LONGMEMORY_CLINE_TASKS`                                     |
| DeepSeek Harness     | `$DSH_HOME/sessions` or `~/.dsh/sessions`                                          | `LONGMEMORY_DEEPSEEK_HARNESS_SESSIONS` or `DSH_SESSION_ROOT` |

VS Code-compatible roots are resolved per platform:

- Windows: `%APPDATA%/{Code,Code - Insiders,VSCodium,Cursor}/User`
- macOS: `~/Library/Application Support/{Code,Code - Insiders,VSCodium,Cursor}/User`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/{Code,Code - Insiders,VSCodium,Cursor}/User`

Detection is read-only and never throws for an absent harness. OpenCode parsing
uses its native `opencode export` command when available and a read-only SQLite
fallback otherwise. DeepSeek Harness stores concatenated Zstandard frames by
default. LongMemory detects those roots but currently imports only raw
`compression: none` JSONL or a raw export; it reports compressed roots as
unavailable instead of partially decoding or silently dropping events.

## Portable session model

Every adapter maps into one provider-neutral representation:

- Native source harness and session ID
- Source path and authoritative working directory
- Clean preview title
- Created and updated timestamps
- Ordered system, user, assistant, and tool text turns
- Assistant model provenance
- Count of unsupported tool/thinking blocks
- Lossless source metadata and malformed-line diagnostics

Injected wrappers and terminal ANSI noise are removed from previews, not from
stored raw turns.

## Idempotency and revisions

The stable Chat Memory asset ID derives from `(source harness, native session
ID)`. A content revision covers every portable field used by the importer:
source path, title, cwd, timestamps, ordered turns, drop count, and source
metadata.

- First revision: `created`
- Same revision: `skipped`
- Changed or grown source: `updated` in place as a new immutable asset version
- `--force`: creates a policy version even when content is unchanged
- Archived destination asset: rejected

Raw session revisions remain immutable. The stable governed asset points at the
latest imported revision and retains source revision, path, project, drop count,
and parser diagnostics.

## Fidelity and verification

```powershell
longmemory verify --from codex --sample 25
```

Verification discovers and parses a bounded sample without writing any database.
Malformed sessions are reported independently. The importer preserves portable
text turns and counts unsupported structured blocks; it does not claim lossless
portability for hidden reasoning or proprietary UI state.

## Why LongMemory is the destination

Direct cross-writing harness stores couples a memory system to unstable private
formats and risks corrupting active sessions. LongMemory instead provides a
stable shared destination with immutable provenance, project isolation,
visibility and ACL governance, agent/framework bindings, and explainable
loadouts. Harnesses consume the resulting context through supported LongMemory
interfaces rather than editing one another's stores.
