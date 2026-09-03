/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                    /____/                                 /_____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/integrations/obsidian/projector.ts
 *  usage : implements the LongMemory projector component
 */

import { createHash } from 'node:crypto';
import {
    closeSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
    find_obvious_credentials,
    obvious_credential_detector_version,
} from '../../core/central_memory/sensitive_content.js';

const GENERATOR = 'longmemory-obsidian-projector';
const CONTENT_SCHEMA = 1;
const MANIFEST_SCHEMA = 2;
const JOURNAL_SCHEMA = 2;
const DEFAULT_PROJECTION_ROOT = 'LongMemory';
const DEFAULT_STATE_DIRECTORY = '.longmemory-obsidian-state';
const OWNERSHIP_STATE_DIRECTORY = 'ownership';
const TRANSACTION_STATE_DIRECTORY = 'transactions';
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_MANAGED_FILES = 100_000;
const MAX_GENERATED_FILE_BYTES = 4 * 1024 * 1024;

type scalar = null | boolean | number | string;
type database_row = Record<string, scalar>;
type projection_kind =
    | 'home'
    | 'project'
    | 'project_link'
    | 'role'
    | 'task'
    | 'memory'
    | 'memory_version'
    | 'thread'
    | 'source'
    | 'confirmation'
    | 'conflict'
    | 'dependency'
    | 'history_publication'
    | 'hierarchy_proposal'
    | 'governance_decision'
    | 'publication_plan'
    | 'publication_attempt'
    | 'dashboard'
    | 'guide';

type central_memory_snapshot = {
    projects: database_row[];
    project_links: database_row[];
    roles: database_row[];
    tasks: database_row[];
    threads: database_row[];
    memories: database_row[];
    versions: database_row[];
    sources: database_row[];
    version_sources: database_row[];
    worksets: database_row[];
    subscriptions: database_row[];
    dependencies: database_row[];
    confirmations: database_row[];
    conflicts: database_row[];
    history_publications: database_row[];
    hierarchy_proposals: database_row[];
    governance_decisions: database_row[];
    publication_plans: database_row[];
    publication_attempts: database_row[];
};

type desired_file = {
    path: string;
    content: string;
    sha256: string;
    kind: projection_kind;
    record_id: string;
};

type manifest_file = {
    path: string;
    sha256: string;
    kind: projection_kind;
    record_id: string;
};

type projection_manifest = {
    generator: typeof GENERATOR;
    schema_version: typeof MANIFEST_SCHEMA;
    scope_fingerprint: string;
    vault_root_fingerprint: string;
    projection_root: string;
    source_fingerprint: string;
    proposal_inbox: string;
    managed_files: manifest_file[];
};

type journal_write = {
    path: string;
    before_sha256: string | null;
    after_sha256: string;
    content: string;
};

type journal_removal = {
    path: string;
    before_sha256: string;
};

type projection_journal = {
    generator: typeof GENERATOR;
    schema_version: typeof JOURNAL_SCHEMA;
    credential_detector_version: typeof obvious_credential_detector_version;
    transaction_id: string;
    scope_fingerprint: string;
    vault_root_fingerprint: string;
    projection_root: string;
    base_manifest_checksum: string | null;
    base_manifest: projection_manifest | null;
    next_manifest_checksum: string;
    next_manifest: projection_manifest;
    writes: journal_write[];
    removals: journal_removal[];
};

export type ObsidianProjectionFaultPhase =
    | 'after_prepare'
    | 'after_inbox'
    | 'after_write'
    | 'after_remove'
    | 'after_manifest_commit';

export type ObsidianProjectionOptions = {
    database: Database.Database;
    vault_root: string;
    tenant_id: string;
    user_id: string;
    projection_root?: string;
    state_root?: string;
    fault_inject?: (phase: ObsidianProjectionFaultPhase, detail?: string) => void;
};

export type ObsidianProjectionReport = {
    written: string[];
    unchanged: string[];
    removed: string[];
    preserved: string[];
    manifest_path: string;
    state_root: string;
    source_fingerprint: string;
};

export class ObsidianProjectionOwnershipError extends Error {
    readonly code = 'OBSIDIAN_PROJECTION_OWNERSHIP_ERROR';

    constructor(message: string) {
        super(message);
        this.name = 'ObsidianProjectionOwnershipError';
    }
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function stable_value(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable_value);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([key, nested]) => [key, stable_value(nested)]),
        );
    }
    return value;
}

function stable_json(value: unknown, spacing?: number): string {
    const result = JSON.stringify(stable_value(value), null, spacing);
    if (result === undefined) throw new Error('cannot serialize undefined projection data');
    return result;
}

function parse_json(value: scalar, field: string): unknown {
    if (typeof value !== 'string') throw new Error(`${field} must be JSON text`);
    try {
        return JSON.parse(value) as unknown;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid JSON in ${field}: ${reason}`);
    }
}

function normalized_snapshot(snapshot: central_memory_snapshot): unknown {
    return Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [
        table,
        rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
            key,
            key.endsWith('_json') ? parse_json(value, `${table}.${key}`) : value,
        ]))),
    ]));
}

function string_value(row: database_row, field: string): string {
    const value = row[field];
    if (typeof value !== 'string') throw new Error(`${field} must be text`);
    return value;
}

function optional_string(row: database_row, field: string): string | null {
    const value = row[field];
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error(`${field} must be text or null`);
    return value;
}

function number_value(row: database_row, field: string): number {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
    return value;
}

function optional_number(row: database_row, field: string): number | null {
    const value = row[field];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number or null`);
    return value;
}

function json_value(row: database_row, field: string): unknown {
    return parse_json(row[field], field);
}

function iso_timestamp(value: number | null): string | null {
    if (value === null) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
    return date.toISOString();
}

function normalize_relative_path(candidate: string, label = 'relative path'): string {
    if (candidate.length === 0) throw new Error(`${label} cannot be empty`);
    if (candidate.includes('\0')) throw new Error(`${label} cannot contain NUL`);
    const portable = candidate.replace(/\\/g, '/');
    if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(portable)) {
        throw new Error(`${label} must be relative`);
    }
    const segments = portable.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new Error(`${label} contains an unsafe segment`);
    }
    for (const segment of segments) {
        if (/[<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment)) {
            throw new Error(`${label} contains a Windows-unsafe segment`);
        }
        const basename = segment.split('.')[0].toUpperCase();
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(basename)) {
            throw new Error(`${label} contains a reserved Windows device name`);
        }
    }
    return segments.join('/');
}

function ownership_key(relative_path: string): string {
    return normalize_relative_path(relative_path).normalize('NFC').toLowerCase();
}

function inside_vault(vault_root: string, relative_path: string): string {
    const safe_relative = normalize_relative_path(relative_path);
    const target = path.resolve(vault_root, ...safe_relative.split('/'));
    const from_root = path.relative(vault_root, target);
    if (from_root === '..' || from_root.startsWith(`..${path.sep}`) || path.isAbsolute(from_root)) {
        throw new Error(`projection path escapes the vault: ${relative_path}`);
    }
    return target;
}

function lstat_if_present(candidate: string): ReturnType<typeof lstatSync> | undefined {
    try {
        return lstatSync(candidate);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function assert_root_is_safe(root: string, label = 'vault_root'): void {
    const stat = lstat_if_present(root);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symlink or junction`);
    if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
}

function path_contains(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`)
        && relative !== '..' && !path.isAbsolute(relative));
}

function assert_roots_are_separate(vault_root: string, state_root: string): void {
    if (path_contains(vault_root, state_root)) {
        throw new ObsidianProjectionOwnershipError('state_root must be outside the vault');
    }
    if (path_contains(state_root, vault_root)) {
        throw new ObsidianProjectionOwnershipError('vault_root must not be nested inside state_root');
    }
}

function assert_existing_components_are_safe(vault_root: string, relative_path: string): void {
    let current = vault_root;
    const segments = normalize_relative_path(relative_path).split('/');
    for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const stat = lstat_if_present(current);
        if (!stat) return;
        if (stat.isSymbolicLink()) {
            throw new ObsidianProjectionOwnershipError(
                `refusing to follow a symlink or junction inside the vault: ${relative_path}`,
            );
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
            throw new ObsidianProjectionOwnershipError(
                `a non-directory blocks the projection path: ${relative_path}`,
            );
        }
        const resolved = realpathSync.native(current);
        const from_root = path.relative(vault_root, resolved);
        if (from_root === '..' || from_root.startsWith(`..${path.sep}`) || path.isAbsolute(from_root)) {
            throw new ObsidianProjectionOwnershipError(
                `an existing path component resolves outside the vault: ${relative_path}`,
            );
        }
    }
}

function assert_existing_parent_components_are_safe(vault_root: string, relative_path: string): void {
    const parent = path.posix.dirname(normalize_relative_path(relative_path));
    if (parent !== '.') assert_existing_components_are_safe(vault_root, parent);
}

function ensure_directory(vault_root: string, relative_directory: string): void {
    let current = vault_root;
    for (const segment of normalize_relative_path(relative_directory, 'directory path').split('/')) {
        current = path.join(current, segment);
        const existing = lstat_if_present(current);
        if (existing) {
            if (existing.isSymbolicLink() || !existing.isDirectory()) {
                throw new ObsidianProjectionOwnershipError(`unsafe projection directory: ${relative_directory}`);
            }
        } else {
            mkdirSync(current);
            const created = lstatSync(current);
            if (created.isSymbolicLink() || !created.isDirectory()) {
                throw new ObsidianProjectionOwnershipError(`could not safely create: ${relative_directory}`);
            }
        }
        const resolved = realpathSync.native(current);
        const from_root = path.relative(vault_root, resolved);
        if (from_root === '..' || from_root.startsWith(`..${path.sep}`) || path.isAbsolute(from_root)) {
            throw new ObsidianProjectionOwnershipError(`projection directory escapes the vault: ${relative_directory}`);
        }
    }
}

function ensure_parent_directory(vault_root: string, relative_path: string): void {
    const parent = path.posix.dirname(normalize_relative_path(relative_path));
    ensure_directory(vault_root, parent);
}

let temporary_sequence = 0;

function fsync_parent_directory(absolute_path: string): void {
    let descriptor: number | null = null;
    try {
        descriptor = openSync(path.dirname(absolute_path), 'r');
        fsyncSync(descriptor);
    } catch (error) {
        // Some Windows filesystems do not allow fsync on a directory handle.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'EACCES') throw error;
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

function atomic_write(vault_root: string, relative_path: string, content: string): void {
    ensure_parent_directory(vault_root, relative_path);
    const target = inside_vault(vault_root, relative_path);
    const basename = path.basename(target);
    let temporary = '';
    let descriptor: number | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        temporary_sequence += 1;
        temporary = path.join(path.dirname(target), `.${basename}.${process.pid}.${temporary_sequence}.longmemory-tmp`);
        try {
            descriptor = openSync(temporary, 'wx', 0o600);
            break;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') throw error;
        }
    }
    if (descriptor === null) throw new Error(`could not allocate a temporary file for ${relative_path}`);
    try {
        writeFileSync(descriptor, content, { encoding: 'utf8' });
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        renameSync(temporary, target);
        fsync_parent_directory(target);
    } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        if (temporary.length > 0 && lstat_if_present(temporary)) unlinkSync(temporary);
        throw error;
    }
}

function durable_unlink(absolute_path: string): void {
    unlinkSync(absolute_path);
    fsync_parent_directory(absolute_path);
}

function file_checksum(absolute_path: string): string {
    return sha256(readFileSync(absolute_path));
}

function read_snapshot(
    database: Database.Database,
    tenant_id: string,
    user_id: string,
): central_memory_snapshot {
    const tables = [
        'cm_projects',
        'cm_project_links',
        'cm_roles',
        'cm_tasks',
        'cm_threads',
        'cm_memories',
        'cm_memory_versions',
        'cm_sources',
        'cm_memory_version_sources',
        'cm_thread_worksets',
        'cm_subscriptions',
        'cm_dependencies',
        'cm_confirmations',
        'cm_memory_conflicts',
        'cm_history_publications',
        'cm_history_hierarchy_proposals',
        'cm_history_governance_decisions',
        'cm_history_publication_plans',
        'cm_history_publication_attempts',
        'cm_history_backfill_runs',
        'cm_history_backfill_candidates',
    ] as const;
    const read = (): central_memory_snapshot => {
        const existing = database.prepare(`SELECT name FROM sqlite_master
            WHERE type='table' AND name IN (${tables.map(() => '?').join(', ')})`)
            .all(...tables) as Array<{ name: string }>;
        const names = new Set(existing.map((row) => row.name));
        const missing = tables.filter((table) => !names.has(table));
        if (missing.length > 0) throw new Error(`central-memory schema is missing: ${missing.join(', ')}`);
        const scoped = (table: string, order: string): database_row[] => database.prepare(
            `SELECT * FROM ${table} WHERE tenant_id = ? AND user_id = ? ORDER BY ${order}`,
        ).all(tenant_id, user_id) as database_row[];
        return {
            projects: scoped('cm_projects', 'project_id'),
            project_links: scoped('cm_project_links', 'created_at, link_id'),
            roles: scoped('cm_roles', 'role_id'),
            tasks: scoped('cm_tasks', 'task_id'),
            threads: scoped('cm_threads', 'thread_id'),
            memories: scoped('cm_memories', 'memory_id'),
            versions: scoped('cm_memory_versions', 'memory_id, version'),
            sources: scoped('cm_sources', 'source_id'),
            version_sources: scoped('cm_memory_version_sources', 'memory_id, version, source_id'),
            worksets: scoped('cm_thread_worksets', 'thread_id, memory_id'),
            subscriptions: scoped('cm_subscriptions', 'thread_id, subscription_id'),
            dependencies: scoped('cm_dependencies', 'dependency_id'),
            confirmations: scoped('cm_confirmations', 'confirmation_id'),
            conflicts: scoped('cm_memory_conflicts', 'conflict_id'),
            history_publications: database.prepare(`SELECT publication.*,
                    run.project_id,
                    candidate.title AS candidate_title,
                    candidate.summary AS candidate_summary,
                    candidate.body AS candidate_body,
                    candidate.importance AS candidate_importance,
                    candidate.is_major AS candidate_is_major,
                    candidate.finding_kind AS candidate_finding_kind,
                    candidate.finding_hash AS candidate_finding_hash,
                    candidate.evidence_json AS candidate_evidence_json
                FROM cm_history_publications AS publication
                JOIN cm_history_backfill_runs AS run
                  ON run.tenant_id=publication.tenant_id AND run.user_id=publication.user_id
                 AND run.run_id=publication.run_id
                JOIN cm_history_backfill_candidates AS candidate
                  ON candidate.tenant_id=publication.tenant_id AND candidate.user_id=publication.user_id
                 AND candidate.candidate_id=publication.candidate_id
                 AND candidate.run_id=publication.run_id
                WHERE publication.tenant_id=? AND publication.user_id=?
                ORDER BY publication.created_at, publication.publication_id`)
                .all(tenant_id, user_id) as database_row[],
            hierarchy_proposals: scoped('cm_history_hierarchy_proposals', 'created_at, proposal_id'),
            governance_decisions: scoped('cm_history_governance_decisions', 'created_at, decision_id'),
            publication_plans: scoped('cm_history_publication_plans', 'created_at, publication_id, plan_version'),
            publication_attempts: scoped('cm_history_publication_attempts', 'created_at, attempt_id'),
        };
    };
    return database.inTransaction ? read() : database.transaction(read)();
}

function record_token(kind: string, id: string): string {
    return `id-${sha256(`${kind}\0${id}`)}`;
}

function version_key(memory_id: string, version: number): string {
    return `${memory_id}\0${String(version)}`;
}

function entity_path(projection_root: string, kind: projection_kind, id: string): string {
    const directories: Partial<Record<projection_kind, string>> = {
        project: 'Projects',
        project_link: 'Project Links',
        role: 'Roles',
        task: 'Tasks',
        memory: 'Memories/current',
        thread: 'Threads',
        source: 'Sources',
        confirmation: 'Confirmations',
        conflict: 'Conflicts',
        dependency: 'Dependencies',
        history_publication: 'History/Publications',
        hierarchy_proposal: 'History/Hierarchy Proposals',
        governance_decision: 'History/Governance Decisions',
        publication_plan: 'History/Publication Plans',
        publication_attempt: 'History/Publication Attempts',
    };
    const directory = directories[kind];
    if (!directory) throw new Error(`unsupported entity path kind: ${kind}`);
    return `${projection_root}/${directory}/${record_token(kind, id)}.md`;
}

function memory_version_path(projection_root: string, memory_id: string, version: number): string {
    if (!Number.isInteger(version) || version <= 0) throw new Error(`invalid memory version: ${String(version)}`);
    return `${projection_root}/Memories/versions/${record_token('memory', memory_id)}/v-${String(version).padStart(8, '0')}.md`;
}

function without_extension(relative_path: string): string {
    return relative_path.replace(/\.(?:md|base)$/u, '');
}

function display_text(value: string): string {
    const flattened = value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '¦').replace(/\]/g, '］').trim();
    return flattened.replace(/[\\`*_{}[\]<>#+.!-]/gu, '\\$&') || '(untitled)';
}

function wikilink(relative_path: string, label: string): string {
    return `[[${without_extension(relative_path)}|${display_text(label)}]]`;
}

function inline_code(value: string): string {
    return `\`${value.replace(/`/g, 'ˋ').replace(/[\r\n]+/g, ' ')}\``;
}

function yaml_scalar(value: scalar): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
}

function frontmatter(fields: Array<[string, scalar | undefined]>): string {
    return [
        '---',
        ...fields.flatMap(([key, value]) => value === undefined ? [] : [`${key}: ${yaml_scalar(value)}`]),
        '---',
    ].join('\n');
}

function json_block(value: unknown): string {
    const rendered = stable_json(value, 2);
    const longest = Math.max(0, ...Array.from(rendered.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(4, longest + 1));
    return `${fence}json\n${rendered}\n${fence}`;
}

function untrusted_text_block(value: string): string {
    const normalized = value.replace(/\r\n?/g, '\n');
    const longest = Math.max(0, ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(4, longest + 1));
    return `${fence}text\n${normalized}\n${fence}`;
}

function markdown_note(fields: Array<[string, scalar | undefined]>, body: string[]): string {
    return `${frontmatter(fields)}\n\n${body.join('\n')}\n`;
}

function metadata_field(row: database_row): string {
    return stable_json(json_value(row, 'metadata_json'));
}

function base_fields(
    kind: projection_kind,
    record_id: string,
    extra: Array<[string, scalar | undefined]> = [],
): Array<[string, scalar | undefined]> {
    return [
        ['longmemory_projection', true],
        ['projection_schema', CONTENT_SCHEMA],
        ['record_kind', kind],
        ['record_id', record_id],
        ...extra,
    ];
}

function links_or_empty(links: string[], empty = '_None._'): string[] {
    return links.length === 0 ? [empty] : links.map((link) => `- ${link}`);
}

function add_file(
    files: Map<string, desired_file>,
    relative_path: string,
    content: string,
    kind: projection_kind,
    record_id: string,
): void {
    const safe_path = normalize_relative_path(relative_path, 'generated file path');
    const safe_key = ownership_key(safe_path);
    if (files.has(safe_key)) throw new Error(`duplicate generated path: ${safe_path}`);
    const normalized_content = content.replace(/\r\n?/g, '\n').replace(/\n*$/u, '\n');
    files.set(safe_key, {
        path: safe_path,
        content: normalized_content,
        sha256: sha256(normalized_content),
        kind,
        record_id,
    });
}

function rows_by(rows: database_row[], field: string): Map<string, database_row[]> {
    const result = new Map<string, database_row[]>();
    for (const row of rows) {
        const key = string_value(row, field);
        const existing = result.get(key) ?? [];
        existing.push(row);
        result.set(key, existing);
    }
    return result;
}

function timestamp_lines(row: database_row, fields: string[]): string[] {
    return fields.map((field) => {
        const value = optional_number(row, field);
        return `- ${field}: ${value === null ? '_None_' : `${inline_code(String(value))} (${inline_code(iso_timestamp(value)!)})`}`;
    });
}

function dashboard_content(record_kind: string, name: string, order: string[], extra_filters: string[] = []): string {
    const filters = [
        'longmemory_projection == true',
        `record_kind == ${JSON.stringify(record_kind)}`,
        ...extra_filters,
    ];
    return [
        'filters:',
        '  and:',
        ...filters.map((filter) => `    - ${JSON.stringify(filter)}`),
        'views:',
        '  - type: table',
        `    name: ${JSON.stringify(name)}`,
        '    order:',
        ...order.map((property) => `      - ${property}`),
        '',
    ].join('\n');
}

function build_projection(snapshot: central_memory_snapshot, projection_root: string): desired_file[] {
    const files = new Map<string, desired_file>();
    const projects = new Map(snapshot.projects.map((row) => [string_value(row, 'project_id'), row]));
    const roles = new Map(snapshot.roles.map((row) => [string_value(row, 'role_id'), row]));
    const tasks = new Map(snapshot.tasks.map((row) => [string_value(row, 'task_id'), row]));
    const memories = new Map(snapshot.memories.map((row) => [string_value(row, 'memory_id'), row]));
    const versions = new Map(snapshot.versions.map((row) => [
        version_key(string_value(row, 'memory_id'), number_value(row, 'version')),
        row,
    ]));
    const sources = new Map(snapshot.sources.map((row) => [string_value(row, 'source_id'), row]));
    const history_publications = new Map(snapshot.history_publications.map((row) => [
        string_value(row, 'publication_id'), row,
    ]));
    const hierarchy_proposals = new Map(snapshot.hierarchy_proposals.map((row) => [
        string_value(row, 'proposal_id'), row,
    ]));
    const roles_by_project = rows_by(snapshot.roles, 'project_id');
    const tasks_by_project = rows_by(snapshot.tasks, 'project_id');
    const threads_by_project = rows_by(snapshot.threads, 'project_id');
    const memories_by_project = rows_by(snapshot.memories, 'project_id');
    const publications_by_project = rows_by(snapshot.history_publications, 'project_id');
    const outgoing_links_by_project = rows_by(snapshot.project_links, 'source_project_id');
    const incoming_links_by_project = rows_by(snapshot.project_links, 'target_project_id');
    const proposals_by_publication = rows_by(snapshot.hierarchy_proposals, 'publication_id');
    const decisions_by_publication = rows_by(snapshot.governance_decisions, 'publication_id');
    const plans_by_publication = rows_by(snapshot.publication_plans, 'publication_id');
    const attempts_by_publication = rows_by(snapshot.publication_attempts, 'publication_id');
    const tasks_by_role = new Map<string, database_row[]>();
    const threads_by_role = new Map<string, database_row[]>();
    const memories_by_role = new Map<string, database_row[]>();
    for (const row of snapshot.tasks) {
        const role_id = optional_string(row, 'role_id');
        if (role_id !== null) tasks_by_role.set(role_id, [...tasks_by_role.get(role_id) ?? [], row]);
    }
    for (const row of snapshot.threads) {
        const role_id = optional_string(row, 'role_id');
        if (role_id !== null) threads_by_role.set(role_id, [...threads_by_role.get(role_id) ?? [], row]);
    }
    for (const row of snapshot.memories) {
        const role_id = optional_string(row, 'role_id');
        if (role_id !== null) memories_by_role.set(role_id, [...memories_by_role.get(role_id) ?? [], row]);
    }
    const threads_by_task = new Map<string, database_row[]>();
    const memories_by_task = new Map<string, database_row[]>();
    for (const row of snapshot.threads) {
        const task_id = optional_string(row, 'task_id');
        if (task_id !== null) threads_by_task.set(task_id, [...threads_by_task.get(task_id) ?? [], row]);
    }
    for (const row of snapshot.memories) {
        const task_id = optional_string(row, 'task_id');
        if (task_id !== null) memories_by_task.set(task_id, [...memories_by_task.get(task_id) ?? [], row]);
    }
    const versions_by_memory = rows_by(snapshot.versions, 'memory_id');
    const confirmations_by_memory = rows_by(snapshot.confirmations, 'memory_id');
    const worksets_by_thread = rows_by(snapshot.worksets, 'thread_id');
    const subscriptions_by_thread = rows_by(snapshot.subscriptions, 'thread_id');
    const version_sources_by_source = rows_by(snapshot.version_sources, 'source_id');
    const version_sources_by_version = new Map<string, database_row[]>();
    for (const row of snapshot.version_sources) {
        const key = version_key(string_value(row, 'memory_id'), number_value(row, 'version'));
        version_sources_by_version.set(key, [...version_sources_by_version.get(key) ?? [], row]);
    }

    const project_link = (id: string): string => wikilink(
        entity_path(projection_root, 'project', id), string_value(projects.get(id)!, 'name'),
    );
    const project_link_record = (row: database_row): string => {
        const id = string_value(row, 'link_id');
        const source = string_value(row, 'source_project_id');
        const target = string_value(row, 'target_project_id');
        return wikilink(entity_path(projection_root, 'project_link', id), `${source} → ${target}`);
    };
    const role_link = (id: string): string => wikilink(
        entity_path(projection_root, 'role', id), string_value(roles.get(id)!, 'name'),
    );
    const task_link = (id: string): string => wikilink(
        entity_path(projection_root, 'task', id), string_value(tasks.get(id)!, 'title'),
    );
    const memory_link = (id: string): string => wikilink(
        entity_path(projection_root, 'memory', id), string_value(memories.get(id)!, 'title'),
    );
    const version_link = (memory_id: string, version: number): string => wikilink(
        memory_version_path(projection_root, memory_id, version),
        `${string_value(memories.get(memory_id)!, 'title')} · v${String(version)}`,
    );
    const thread_link = (row: database_row): string => {
        const id = string_value(row, 'thread_id');
        return wikilink(entity_path(projection_root, 'thread', id), id);
    };
    const source_link = (id: string): string => wikilink(
        entity_path(projection_root, 'source', id), `${string_value(sources.get(id)!, 'source_kind')}: ${id}`,
    );
    const publication_link = (id: string): string => {
        const publication = history_publications.get(id);
        const label = publication === undefined
            ? id
            : `${string_value(publication, 'candidate_title')} · ${id}`;
        return wikilink(entity_path(projection_root, 'history_publication', id), label);
    };
    const proposal_link = (id: string): string => wikilink(
        entity_path(projection_root, 'hierarchy_proposal', id), `层级提案 · ${id}`,
    );
    const decision_link = (id: string): string => wikilink(
        entity_path(projection_root, 'governance_decision', id), `治理决定 · ${id}`,
    );
    const plan_link = (publication_id: string, plan_version: number): string => wikilink(
        entity_path(projection_root, 'publication_plan', `${publication_id}@${String(plan_version)}`),
        `发布计划 · ${publication_id}@${String(plan_version)}`,
    );
    const attempt_link = (id: string): string => wikilink(
        entity_path(projection_root, 'publication_attempt', id), `发布尝试 · ${id}`,
    );

    for (const project of snapshot.projects) {
        const project_id = string_value(project, 'project_id');
        const name = string_value(project, 'name');
        const role_links = (roles_by_project.get(project_id) ?? []).map((row) => role_link(string_value(row, 'role_id')));
        const task_links = (tasks_by_project.get(project_id) ?? []).map((row) => task_link(string_value(row, 'task_id')));
        const thread_links = (threads_by_project.get(project_id) ?? []).map(thread_link);
        const memory_links = (memories_by_project.get(project_id) ?? [])
            .map((row) => memory_link(string_value(row, 'memory_id')));
        const history_links = (publications_by_project.get(project_id) ?? [])
            .map((row) => publication_link(string_value(row, 'publication_id')));
        const outgoing_project_links = (outgoing_links_by_project.get(project_id) ?? []).map(project_link_record);
        const incoming_project_links = (incoming_links_by_project.get(project_id) ?? []).map(project_link_record);
        add_file(files, entity_path(projection_root, 'project', project_id), markdown_note(
            base_fields('project', project_id, [
                ['project_id', project_id],
                ['name', name],
                ['status', string_value(project, 'status')],
                ['created_at_ms', number_value(project, 'created_at')],
                ['updated_at_ms', number_value(project, 'updated_at')],
                ['metadata_json', metadata_field(project)],
            ]),
            [
                `# ${display_text(name)}`,
                '',
                `- 项目 ID：${inline_code(project_id)}`,
                `- 状态：${inline_code(string_value(project, 'status'))}`,
                `- 说明：${string_value(project, 'description')
                    ? inline_code(string_value(project, 'description')) : '_未填写_'}`,
                ...timestamp_lines(project, ['created_at', 'updated_at']),
                '',
                '## 角色',
                '',
                ...links_or_empty(role_links),
                '',
                '## 任务',
                '',
                ...links_or_empty(task_links),
                '',
                '## 对话任务',
                '',
                ...links_or_empty(thread_links),
                '',
                '## 记忆',
                '',
                ...links_or_empty(memory_links),
                '',
                '## 历史回溯发布',
                '',
                ...links_or_empty(history_links),
                '',
                '## 项目联动（只允许相关 L4 记忆）',
                '',
                '### 本项目 → 其他项目',
                '',
                ...links_or_empty(outgoing_project_links),
                '',
                '### 其他项目 → 本项目',
                '',
                ...links_or_empty(incoming_project_links),
                '',
                '## 元数据',
                '',
                json_block(json_value(project, 'metadata_json')),
            ],
        ), 'project', project_id);
    }

    for (const link of snapshot.project_links) {
        const link_id = string_value(link, 'link_id');
        const source_project_id = string_value(link, 'source_project_id');
        const target_project_id = string_value(link, 'target_project_id');
        const status = string_value(link, 'status');
        if (!projects.has(source_project_id) || !projects.has(target_project_id)) {
            throw new Error(`project link ${link_id} references a missing project`);
        }
        const body: string[] = [
            `# ${display_text(source_project_id)} → ${display_text(target_project_id)}`,
            '',
            '> [!info] 受控项目联动',
            '> 此链接只允许目标项目按相关性召回来源项目的 L4 经验；不会传播 L1–L3、项目规则或任务结构。',
            '',
            `- 联动 ID：${inline_code(link_id)}`,
            `- 来源项目：${project_link(source_project_id)}`,
            `- 目标项目：${project_link(target_project_id)}`,
            `- 方向：${inline_code(`${source_project_id} -> ${target_project_id}`)}`,
            `- 允许层级：${inline_code('L4 only')}`,
            `- 状态：${inline_code(status)}`,
            '',
            '## 建立授权',
            '',
            `- 操作者：${inline_code(string_value(link, 'created_by'))}`,
            `- 操作 ID：${inline_code(string_value(link, 'created_action_id'))}`,
            `- 渠道：${inline_code(string_value(link, 'created_channel'))}`,
            ...timestamp_lines(link, ['created_at']),
            '',
            '### 建立证据',
            '',
            json_block(json_value(link, 'created_evidence_json')),
            '',
        ];
        if (status === 'revoked') {
            body.push(
                '> [!danger] REVOKED — 不再允许新的跨项目召回',
                '',
                '## 撤销授权',
                '',
                `- 操作者：${inline_code(optional_string(link, 'revoked_by')!)}`,
                `- 操作 ID：${inline_code(optional_string(link, 'revoked_action_id')!)}`,
                `- 渠道：${inline_code(optional_string(link, 'revoked_channel')!)}`,
                ...timestamp_lines(link, ['revoked_at']),
                '',
                '### 撤销证据',
                '',
                json_block(json_value(link, 'revoked_evidence_json')),
                '',
            );
        }
        body.push('## 元数据', '', json_block(json_value(link, 'metadata_json')));
        add_file(files, entity_path(projection_root, 'project_link', link_id), markdown_note(
            base_fields('project_link', link_id, [
                ['link_id', link_id],
                ['source_project_id', source_project_id],
                ['target_project_id', target_project_id],
                ['allowed_level', 4],
                ['status', status],
                ['created_at_ms', number_value(link, 'created_at')],
                ['revoked_at_ms', optional_number(link, 'revoked_at')],
                ['metadata_json', metadata_field(link)],
            ]),
            body,
        ), 'project_link', link_id);
    }

    for (const role of snapshot.roles) {
        const role_id = string_value(role, 'role_id');
        const project_id = string_value(role, 'project_id');
        const name = string_value(role, 'name');
        const task_links = (tasks_by_role.get(role_id) ?? []).map((row) => task_link(string_value(row, 'task_id')));
        const thread_links = (threads_by_role.get(role_id) ?? []).map(thread_link);
        const memory_links = (memories_by_role.get(role_id) ?? [])
            .map((row) => memory_link(string_value(row, 'memory_id')));
        add_file(files, entity_path(projection_root, 'role', role_id), markdown_note(
            base_fields('role', role_id, [
                ['project_id', project_id],
                ['role_id', role_id],
                ['name', name],
                ['status', string_value(role, 'status')],
                ['created_at_ms', number_value(role, 'created_at')],
                ['updated_at_ms', number_value(role, 'updated_at')],
                ['metadata_json', metadata_field(role)],
            ]),
            [
                `# ${display_text(name)}`,
                '',
                `- 角色 ID：${inline_code(role_id)}`,
                `- 所属项目：${project_link(project_id)}`,
                `- 状态：${inline_code(string_value(role, 'status'))}`,
                '',
                '## 职责',
                '',
                string_value(role, 'responsibility')
                    ? untrusted_text_block(string_value(role, 'responsibility')) : '_未填写_',
                '',
                '## 任务',
                '',
                ...links_or_empty(task_links),
                '',
                '## 对话任务',
                '',
                ...links_or_empty(thread_links),
                '',
                '## 记忆',
                '',
                ...links_or_empty(memory_links),
                '',
                '## 时间',
                '',
                ...timestamp_lines(role, ['created_at', 'updated_at']),
                '',
                '## 元数据',
                '',
                json_block(json_value(role, 'metadata_json')),
            ],
        ), 'role', role_id);
    }

    for (const task of snapshot.tasks) {
        const task_id = string_value(task, 'task_id');
        const project_id = string_value(task, 'project_id');
        const role_id = optional_string(task, 'role_id');
        const title = string_value(task, 'title');
        const thread_links = (threads_by_task.get(task_id) ?? []).map(thread_link);
        const memory_links = (memories_by_task.get(task_id) ?? [])
            .map((row) => memory_link(string_value(row, 'memory_id')));
        add_file(files, entity_path(projection_root, 'task', task_id), markdown_note(
            base_fields('task', task_id, [
                ['project_id', project_id],
                ['role_id', role_id],
                ['task_id', task_id],
                ['title', title],
                ['status', string_value(task, 'status')],
                ['created_at_ms', number_value(task, 'created_at')],
                ['updated_at_ms', number_value(task, 'updated_at')],
                ['metadata_json', metadata_field(task)],
            ]),
            [
                `# ${display_text(title)}`,
                '',
                `- 任务 ID：${inline_code(task_id)}`,
                `- 所属项目：${project_link(project_id)}`,
                `- 所属角色：${role_id === null ? '_无_' : role_link(role_id)}`,
                `- 状态：${inline_code(string_value(task, 'status'))}`,
                '',
                '## 目标',
                '',
                string_value(task, 'objective')
                    ? untrusted_text_block(string_value(task, 'objective')) : '_未填写_',
                '',
                '## 对话任务',
                '',
                ...links_or_empty(thread_links),
                '',
                '## 记忆',
                '',
                ...links_or_empty(memory_links),
                '',
                '## 时间',
                '',
                ...timestamp_lines(task, ['created_at', 'updated_at']),
                '',
                '## 元数据',
                '',
                json_block(json_value(task, 'metadata_json')),
            ],
        ), 'task', task_id);
    }

    for (const memory of snapshot.memories) {
        const memory_id = string_value(memory, 'memory_id');
        const project_id = string_value(memory, 'project_id');
        const role_id = optional_string(memory, 'role_id');
        const task_id = optional_string(memory, 'task_id');
        const current_version = optional_number(memory, 'current_version');
        const memory_versions = versions_by_memory.get(memory_id) ?? [];
        const current = current_version === null ? null : versions.get(version_key(memory_id, current_version)) ?? null;
        if (current_version !== null && current === null) {
            throw new Error(`memory ${memory_id} points to missing version ${String(current_version)}`);
        }
        const latest = memory_versions.at(-1) ?? null;
        const pending_versions = memory_versions.filter((row) => string_value(row, 'status') === 'pending_confirmation');
        const confirmations = confirmations_by_memory.get(memory_id) ?? [];
        const current_sources = current === null
            ? []
            : version_sources_by_version.get(version_key(memory_id, number_value(current, 'version'))) ?? [];
        const title = string_value(memory, 'title');
        const effective_status = current === null
            ? latest === null ? 'no_versions' : string_value(latest, 'status')
            : string_value(current, 'status');
        const body: string[] = [
            `# ${display_text(title)}`,
            '',
            `- 记忆 ID：${inline_code(memory_id)}`,
            `- 层级：${inline_code(String(number_value(memory, 'level')))}`,
            `- 类型：${inline_code(string_value(memory, 'memory_kind'))}`,
            `- 所属项目：${project_link(project_id)}`,
            `- 所属角色：${role_id === null ? '_无_' : role_link(role_id)}`,
            `- 所属任务：${task_id === null ? '_无_' : task_link(task_id)}`,
            `- 当前版本：${current_version === null ? '_无_' : version_link(memory_id, current_version)}`,
            '',
        ];
        if (current !== null && string_value(current, 'status') === 'locked') {
            body.push(
                '> [!important] LOCKED — 重大规则',
                '> 当前版本已锁定。任何替换或撤回都必须经过明确的人类确认。',
                '',
            );
        }
        if (current === null && latest !== null && string_value(latest, 'status') === 'retracted') {
            body.push(
                '> [!danger] RETRACTED — DO NOT USE',
                '> 此记忆没有当前有效版本。最新版本已撤回，不能用于推理或执行。',
                '',
            );
        } else if (current === null) {
            body.push(
                '> [!warning] NO CURRENT EFFECTIVE VERSION',
                '> 此记忆目前没有 active 或 locked 版本。待确认候选不等于当前有效记忆。',
                '',
            );
        }
        body.push('## 当前有效内容', '');
        if (current === null) {
            body.push('_无当前有效内容。_', '');
        } else {
            body.push(
                '### 正式内容（只读文本）',
                '',
                untrusted_text_block([
                    `标题：${string_value(current, 'title')}`,
                    `摘要：${string_value(current, 'summary')}`,
                    '',
                    string_value(current, 'body'),
                ].join('\n')),
                '',
                `- 状态：${inline_code(string_value(current, 'status'))}`,
                `- 重要度：${inline_code(String(number_value(current, 'importance')))}`,
                `- 重大变更：${number_value(current, 'is_major') === 1 ? '是' : '否'}`,
                `- 变更原因：${string_value(current, 'change_reason')
                    ? inline_code(string_value(current, 'change_reason')) : '_未填写_'}`,
                '',
                '### 当前版本来源',
                '',
                ...links_or_empty(current_sources.map((row) => source_link(string_value(row, 'source_id')))),
                '',
            );
        }
        body.push('## 待确认候选', '');
        if (pending_versions.length === 0) body.push('_无。_', '');
        else {
            body.push(
                '> [!warning] PENDING — NOT EFFECTIVE',
                '> 以下候选尚未获批，不能覆盖当前有效版本。',
                '',
                ...pending_versions.map((row) => `- ${version_link(memory_id, number_value(row, 'version'))}`),
                '',
            );
        }
        body.push(
            '## 版本历史',
            '',
            ...links_or_empty(memory_versions.map((row) => {
                const version = number_value(row, 'version');
                return `${version_link(memory_id, version)} — ${inline_code(string_value(row, 'status'))}`;
            })),
            '',
            '## 确认记录',
            '',
            ...links_or_empty(confirmations.map((row) => {
                const confirmation_id = string_value(row, 'confirmation_id');
                return `${wikilink(entity_path(projection_root, 'confirmation', confirmation_id), confirmation_id)} — ${inline_code(string_value(row, 'status'))}`;
            })),
            '',
            '## 时间',
            '',
            ...timestamp_lines(memory, ['created_at', 'updated_at']),
            '',
            '## 元数据',
            '',
            json_block(json_value(memory, 'metadata_json')),
        );
        add_file(files, entity_path(projection_root, 'memory', memory_id), markdown_note(
            base_fields('memory', memory_id, [
                ['project_id', project_id],
                ['role_id', role_id],
                ['task_id', task_id],
                ['memory_id', memory_id],
                ['level', number_value(memory, 'level')],
                ['memory_kind', string_value(memory, 'memory_kind')],
                ['title', title],
                ['status', effective_status],
                ['current_version', current_version],
                ['created_at_ms', number_value(memory, 'created_at')],
                ['updated_at_ms', number_value(memory, 'updated_at')],
                ['metadata_json', metadata_field(memory)],
            ]),
            body,
        ), 'memory', memory_id);
    }

    for (const version of snapshot.versions) {
        const memory_id = string_value(version, 'memory_id');
        const version_number = number_value(version, 'version');
        const status = string_value(version, 'status');
        const memory = memories.get(memory_id);
        if (!memory) throw new Error(`version references missing memory: ${memory_id}`);
        const source_rows = version_sources_by_version.get(version_key(memory_id, version_number)) ?? [];
        const confirmation_rows = (confirmations_by_memory.get(memory_id) ?? [])
            .filter((row) => number_value(row, 'proposed_version') === version_number);
        const body: string[] = [
            `# ${display_text(string_value(version, 'title'))} · v${String(version_number)}`,
            '',
        ];
        if (status === 'retracted') {
            body.push(
                '> [!danger] RETRACTED — DO NOT USE',
                '> 此版本已撤回。保留本页仅用于审计与历史追溯。',
                '',
            );
        } else if (status === 'pending_confirmation') {
            body.push(
                '> [!warning] PENDING CONFIRMATION — NOT EFFECTIVE',
                '> 此候选版本尚未获批，不能用于推理或执行。',
                '',
            );
        } else if (status === 'locked') {
            body.push(
                '> [!important] LOCKED — 重大规则',
                '> 此版本当前有效且已锁定。',
                '',
            );
        } else if (status === 'superseded') {
            body.push(
                '> [!note] SUPERSEDED',
                '> 此版本已被更新版本取代，仅供历史追溯。',
                '',
            );
        }
        body.push(
            `- 记忆：${memory_link(memory_id)}`,
            `- 版本：${inline_code(String(version_number))}`,
            `- 状态：${inline_code(status)}`,
            `- 当前版本：${optional_number(memory, 'current_version') === version_number ? '是' : '否'}`,
            `- 内容哈希：${inline_code(string_value(version, 'content_hash'))}`,
            `- 创建者：${inline_code(string_value(version, 'created_by'))}`,
            `- 重要度：${inline_code(String(number_value(version, 'importance')))}`,
            `- 重大变更：${number_value(version, 'is_major') === 1 ? '是' : '否'}`,
            `- 变更原因：${string_value(version, 'change_reason')
                ? inline_code(string_value(version, 'change_reason')) : '_未填写_'}`,
            '',
            '## 摘要',
            '',
            string_value(version, 'summary')
                ? untrusted_text_block(string_value(version, 'summary')) : '_未填写_',
            '',
            '## 正文',
            '',
            string_value(version, 'body')
                ? untrusted_text_block(string_value(version, 'body')) : '_正文为空_',
            '',
            '## 来源',
            '',
            ...links_or_empty(source_rows.map((row) => {
                const source_id = string_value(row, 'source_id');
                return `${source_link(source_id)} — evidence_role=${inline_code(string_value(row, 'evidence_role'))}`;
            })),
            '',
            '## 确认记录',
            '',
            ...links_or_empty(confirmation_rows.map((row) => {
                const confirmation_id = string_value(row, 'confirmation_id');
                return `${wikilink(entity_path(projection_root, 'confirmation', confirmation_id), confirmation_id)} — ${inline_code(string_value(row, 'status'))}`;
            })),
            '',
            '## 时间',
            '',
            ...timestamp_lines(version, ['created_at', 'activated_at', 'superseded_at', 'retracted_at']),
            '',
            '## 元数据',
            '',
            json_block(json_value(version, 'metadata_json')),
        );
        add_file(files, memory_version_path(projection_root, memory_id, version_number), markdown_note(
            base_fields('memory_version', `${memory_id}@${String(version_number)}`, [
                ['project_id', string_value(memory, 'project_id')],
                ['role_id', optional_string(memory, 'role_id')],
                ['task_id', optional_string(memory, 'task_id')],
                ['memory_id', memory_id],
                ['version', version_number],
                ['level', number_value(memory, 'level')],
                ['memory_kind', string_value(memory, 'memory_kind')],
                ['title', string_value(version, 'title')],
                ['status', status],
                ['importance', number_value(version, 'importance')],
                ['is_major', number_value(version, 'is_major') === 1],
                ['created_at_ms', number_value(version, 'created_at')],
                ['metadata_json', metadata_field(version)],
            ]),
            body,
        ), 'memory_version', `${memory_id}@${String(version_number)}`);
    }

    for (const thread of snapshot.threads) {
        const thread_id = string_value(thread, 'thread_id');
        const project_id = string_value(thread, 'project_id');
        const role_id = optional_string(thread, 'role_id');
        const task_id = optional_string(thread, 'task_id');
        const worksets = worksets_by_thread.get(thread_id) ?? [];
        const subscriptions = subscriptions_by_thread.get(thread_id) ?? [];
        const body: string[] = [
            `# 对话任务 · ${display_text(thread_id)}`,
            '',
            `- 对话 ID：${inline_code(thread_id)}`,
            `- 所属项目：${project_link(project_id)}`,
            `- 所属角色：${role_id === null ? '_无_' : role_link(role_id)}`,
            `- 所属任务：${task_id === null ? '_无_' : task_link(task_id)}`,
            `- 状态：${inline_code(string_value(thread, 'status'))}`,
            `- 最近安全边界：${optional_number(thread, 'last_safe_boundary_at') === null
                ? '_无_'
                : inline_code(iso_timestamp(optional_number(thread, 'last_safe_boundary_at'))!)}`,
            '',
            '## 职责',
            '',
            string_value(thread, 'responsibility')
                ? untrusted_text_block(string_value(thread, 'responsibility')) : '_未填写_',
            '',
            '## 当前工作集',
            '',
        ];
        if (worksets.length === 0) body.push('_无。_', '');
        for (const workset of worksets) {
            const memory_id = string_value(workset, 'memory_id');
            const sync_state = string_value(workset, 'sync_state');
            if (sync_state === 'retracted') {
                body.push(
                    '> [!danger] RETRACTED WORKSET ENTRY — DO NOT USE',
                    `> ${memory_link(memory_id)} 已从有效工作集中撤回。`,
                    '',
                );
            }
            const render_workset_version = (field: string): string => {
                const value = optional_number(workset, field);
                return value === null ? '_无_' : version_link(memory_id, value);
            };
            body.push(
                `### ${memory_link(memory_id)}`,
                '',
                `- synced_version：${render_workset_version('synced_version')}`,
                `- consumed_version：${render_workset_version('consumed_version')}`,
                `- pending_version：${render_workset_version('pending_version')}`,
                `- relevance：${inline_code(String(number_value(workset, 'relevance')))}`,
                `- origin：${inline_code(string_value(workset, 'origin'))}`,
                `- sync_state：${inline_code(sync_state)}`,
                ...timestamp_lines(workset, ['last_synced_at', 'last_consumed_at', 'updated_at']),
                '',
            );
        }
        body.push('## 订阅', '');
        if (subscriptions.length === 0) body.push('_无。_', '');
        for (const subscription of subscriptions) {
            body.push(
                `- ${inline_code(string_value(subscription, 'subscription_id'))}`,
                `  - 选择器：${inline_code(string_value(subscription, 'selector_kind'))} = ${inline_code(string_value(subscription, 'selector_value'))}`,
                `  - 最低相关度：${inline_code(String(number_value(subscription, 'min_relevance')))}`,
                `  - 启用：${number_value(subscription, 'enabled') === 1 ? '是' : '否'}`,
                `  - 游标版本：${optional_number(subscription, 'cursor_version') === null
                    ? '_无_'
                    : inline_code(String(optional_number(subscription, 'cursor_version')))}`,
            );
        }
        body.push(
            '',
            '## 时间',
            '',
            ...timestamp_lines(thread, ['created_at', 'updated_at']),
            '',
            '## 元数据',
            '',
            json_block(json_value(thread, 'metadata_json')),
        );
        add_file(files, entity_path(projection_root, 'thread', thread_id), markdown_note(
            base_fields('thread', thread_id, [
                ['project_id', project_id],
                ['role_id', role_id],
                ['task_id', task_id],
                ['thread_id', thread_id],
                ['status', string_value(thread, 'status')],
                ['last_safe_boundary_at_ms', optional_number(thread, 'last_safe_boundary_at')],
                ['created_at_ms', number_value(thread, 'created_at')],
                ['updated_at_ms', number_value(thread, 'updated_at')],
                ['metadata_json', metadata_field(thread)],
            ]),
            body,
        ), 'thread', thread_id);
    }

    const thread_ids = new Set(snapshot.threads.map((row) => string_value(row, 'thread_id')));
    for (const source of snapshot.sources) {
        const source_id = string_value(source, 'source_id');
        const source_thread_id = optional_string(source, 'thread_id');
        const references = version_sources_by_source.get(source_id) ?? [];
        const reference_lines = references.map((row) => {
            const memory_id = string_value(row, 'memory_id');
            const version = number_value(row, 'version');
            return `${version_link(memory_id, version)} — evidence_role=${inline_code(string_value(row, 'evidence_role'))}; locator=${inline_code(stable_json(json_value(row, 'locator_json')))}`;
        });
        add_file(files, entity_path(projection_root, 'source', source_id), markdown_note(
            base_fields('source', source_id, [
                ['source_id', source_id],
                ['source_kind', string_value(source, 'source_kind')],
                ['thread_id', source_thread_id],
                ['turn_id', optional_string(source, 'turn_id')],
                ['recorded_at_ms', number_value(source, 'recorded_at')],
                ['metadata_json', metadata_field(source)],
            ]),
            [
                `# 来源 · ${display_text(source_id)}`,
                '',
                `- 来源 ID：${inline_code(source_id)}`,
                `- 类型：${inline_code(string_value(source, 'source_kind'))}`,
                `- URI：${inline_code(string_value(source, 'uri'))}`,
                `- 对话：${source_thread_id === null
                    ? '_无_'
                    : thread_ids.has(source_thread_id)
                        ? wikilink(entity_path(projection_root, 'thread', source_thread_id), source_thread_id)
                        : `${inline_code(source_thread_id)}（本范围内无对应对话页）`}`,
                `- Turn：${optional_string(source, 'turn_id') === null ? '_无_' : inline_code(optional_string(source, 'turn_id')!)}`,
                `- 摘录哈希：${optional_string(source, 'excerpt_hash') === null
                    ? '_无_'
                    : inline_code(optional_string(source, 'excerpt_hash')!)}`,
                `- 记录时间：${inline_code(String(number_value(source, 'recorded_at')))} (${inline_code(iso_timestamp(number_value(source, 'recorded_at'))!)})`,
                '',
                '## 引用此来源的版本',
                '',
                ...links_or_empty(reference_lines),
                '',
                '## 定位信息',
                '',
                json_block(json_value(source, 'locator_json')),
                '',
                '## 元数据',
                '',
                json_block(json_value(source, 'metadata_json')),
            ],
        ), 'source', source_id);
    }

    for (const confirmation of snapshot.confirmations) {
        const confirmation_id = string_value(confirmation, 'confirmation_id');
        const memory_id = string_value(confirmation, 'memory_id');
        const proposed_version = number_value(confirmation, 'proposed_version');
        const status = string_value(confirmation, 'status');
        const body: string[] = [
            `# 确认请求 · ${display_text(confirmation_id)}`,
            '',
        ];
        if (status === 'pending') {
            body.push(
                '> [!warning] PENDING — 只读页面，不能在此批准',
                `> 如需提出处理意见，请复制 ${inline_code(`${projection_root}/Proposals/TEMPLATE.md`)} 到 ${inline_code(`${projection_root}/Proposals/inbox/`)}，填写后交由记忆管理流程处理。提案本身不等于批准。`,
                '',
            );
        }
        body.push(
            `- 确认 ID：${inline_code(confirmation_id)}`,
            `- 记忆：${memory_link(memory_id)}`,
            `- 候选/目标版本：${version_link(memory_id, proposed_version)}`,
            `- 预期当前版本：${optional_number(confirmation, 'expected_current_version') === null
                ? '_无_'
                : inline_code(String(optional_number(confirmation, 'expected_current_version')))}`,
            `- 请求状态：${inline_code(string_value(confirmation, 'requested_status'))}`,
            `- 类型：${inline_code(string_value(confirmation, 'confirmation_kind'))}`,
            `- 状态：${inline_code(status)}`,
            `- 请求者：${inline_code(string_value(confirmation, 'requested_by'))}`,
            '',
            '## 提示',
            '',
            string_value(confirmation, 'prompt')
                ? untrusted_text_block(string_value(confirmation, 'prompt')) : '_未填写_',
            '',
            '## 决定',
            '',
            `- 决定者：${optional_string(confirmation, 'decided_by') === null
                ? '_无_'
                : inline_code(optional_string(confirmation, 'decided_by')!)}`,
            `- 决定说明：${string_value(confirmation, 'decision_note') || '_无_'}`,
            ...timestamp_lines(confirmation, ['requested_at', 'decided_at']),
            '',
            '### 决定证据',
            '',
            json_block(json_value(confirmation, 'decision_metadata_json')),
            '',
            '## 元数据',
            '',
            json_block(json_value(confirmation, 'metadata_json')),
        );
        add_file(files, entity_path(projection_root, 'confirmation', confirmation_id), markdown_note(
            base_fields('confirmation', confirmation_id, [
                ['confirmation_id', confirmation_id],
                ['memory_id', memory_id],
                ['proposed_version', proposed_version],
                ['requested_status', string_value(confirmation, 'requested_status')],
                ['confirmation_kind', string_value(confirmation, 'confirmation_kind')],
                ['status', status],
                ['requested_at_ms', number_value(confirmation, 'requested_at')],
                ['decided_at_ms', optional_number(confirmation, 'decided_at')],
                ['metadata_json', metadata_field(confirmation)],
            ]),
            body,
        ), 'confirmation', confirmation_id);
    }

    for (const conflict of snapshot.conflicts) {
        const conflict_id = string_value(conflict, 'conflict_id');
        const memory_a_id = string_value(conflict, 'memory_a_id');
        const memory_a_version = number_value(conflict, 'memory_a_version');
        const memory_b_id = string_value(conflict, 'memory_b_id');
        const memory_b_version = number_value(conflict, 'memory_b_version');
        const status = string_value(conflict, 'status');
        const body: string[] = [`# 冲突 · ${display_text(conflict_id)}`, ''];
        if (status === 'open') {
            body.push(
                '> [!danger] OPEN CONFLICT — 需要处理',
                '> 两条记忆存在尚未解决的冲突。解决前不要把它们同时当作可靠规则。',
                '',
            );
        }
        body.push(
            `- 冲突 ID：${inline_code(conflict_id)}`,
            `- 状态：${inline_code(status)}`,
            `- 严重度：${inline_code(String(number_value(conflict, 'severity')))}`,
            `- 记忆 A：${version_link(memory_a_id, memory_a_version)}`,
            `- 记忆 B：${version_link(memory_b_id, memory_b_version)}`,
            `- 解决版本：${optional_string(conflict, 'resolution_memory_id') === null
                ? '_无_'
                : version_link(optional_string(conflict, 'resolution_memory_id')!, optional_number(conflict, 'resolution_version')!)}`,
            '',
            '## 冲突理由',
            '',
            string_value(conflict, 'rationale')
                ? untrusted_text_block(string_value(conflict, 'rationale')) : '_未填写_',
            '',
            '## 时间',
            '',
            ...timestamp_lines(conflict, ['created_at', 'resolved_at']),
            '',
            '## 元数据与决定证据',
            '',
            json_block(json_value(conflict, 'metadata_json')),
        );
        add_file(files, entity_path(projection_root, 'conflict', conflict_id), markdown_note(
            base_fields('conflict', conflict_id, [
                ['conflict_id', conflict_id],
                ['memory_a_id', memory_a_id],
                ['memory_a_version', memory_a_version],
                ['memory_b_id', memory_b_id],
                ['memory_b_version', memory_b_version],
                ['severity', number_value(conflict, 'severity')],
                ['status', status],
                ['created_at_ms', number_value(conflict, 'created_at')],
                ['resolved_at_ms', optional_number(conflict, 'resolved_at')],
                ['metadata_json', metadata_field(conflict)],
            ]),
            body,
        ), 'conflict', conflict_id);
    }

    for (const dependency of snapshot.dependencies) {
        const dependency_id = string_value(dependency, 'dependency_id');
        const memory_id = string_value(dependency, 'memory_id');
        const memory_version = number_value(dependency, 'memory_version');
        const status = string_value(dependency, 'status');
        const body: string[] = [`# 依赖 · ${display_text(dependency_id)}`, ''];
        if (status === 'needs_review') {
            body.push(
                '> [!warning] NEEDS REVIEW',
                '> 所依赖的记忆已有变化，此下游对象需要重新检查。',
                '',
            );
        } else if (status === 'invalidated') {
            body.push(
                '> [!danger] INVALIDATED',
                '> 所依赖的记忆已撤回，此下游对象不能继续按原结论使用。',
                '',
            );
        }
        body.push(
            `- 依赖 ID：${inline_code(dependency_id)}`,
            `- 下游类型：${inline_code(string_value(dependency, 'subject_kind'))}`,
            `- 下游 ID：${inline_code(string_value(dependency, 'subject_id'))}`,
            `- 记忆版本：${version_link(memory_id, memory_version)}`,
            `- 状态：${inline_code(status)}`,
            '',
            '## 详情',
            '',
            json_block(json_value(dependency, 'details_json')),
            '',
            '## 时间',
            '',
            ...timestamp_lines(dependency, ['created_at', 'updated_at']),
        );
        add_file(files, entity_path(projection_root, 'dependency', dependency_id), markdown_note(
            base_fields('dependency', dependency_id, [
                ['dependency_id', dependency_id],
                ['subject_kind', string_value(dependency, 'subject_kind')],
                ['subject_id', string_value(dependency, 'subject_id')],
                ['memory_id', memory_id],
                ['memory_version', memory_version],
                ['status', status],
                ['created_at_ms', number_value(dependency, 'created_at')],
                ['updated_at_ms', number_value(dependency, 'updated_at')],
                ['details_json', stable_json(json_value(dependency, 'details_json'))],
            ]),
            body,
        ), 'dependency', dependency_id);
    }

    for (const publication of snapshot.history_publications) {
        const publication_id = string_value(publication, 'publication_id');
        const project_id = string_value(publication, 'project_id');
        const status = string_value(publication, 'status');
        const current_plan_version = optional_number(publication, 'current_plan_version');
        const result_memory_id = optional_string(publication, 'result_memory_id');
        const result_version = optional_number(publication, 'result_version');
        const result_confirmation_id = optional_string(publication, 'result_confirmation_id');
        const proposals = proposals_by_publication.get(publication_id) ?? [];
        const decisions = decisions_by_publication.get(publication_id) ?? [];
        const plans = plans_by_publication.get(publication_id) ?? [];
        const attempts = attempts_by_publication.get(publication_id) ?? [];
        const current_plan = current_plan_version === null
            ? null
            : plans.find((row) => number_value(row, 'plan_version') === current_plan_version) ?? null;
        const body: string[] = [
            `# 历史回溯发布 · ${display_text(string_value(publication, 'candidate_title'))}`,
            '',
        ];
        if (status === 'awaiting_hierarchy') {
            body.push(
                '> [!warning] AWAITING HIERARCHY — 待人工确认层级',
                '> 历史提取器只能提出层级建议；新角色或新任务必须由人确认后才能创建。',
                '',
            );
        } else if (status === 'needs_review') {
            body.push(
                '> [!warning] NEEDS CONTENT REVIEW — 待人工审核内容',
                '> 候选与当前正式记忆不同或存在冲突，未批准前不能覆盖当前结果。',
                '',
            );
        } else if (status === 'pending_confirmation') {
            body.push(
                '> [!important] PENDING CENTRAL CONFIRMATION — 尚未生效',
                '> 正式记忆候选已经创建，但一级/重大/冲突规则仍在等待中央人工确认。',
                '',
            );
        } else if (status === 'published') {
            body.push('> [!success] PUBLISHED — 已进入中央记忆', '',);
        } else if (status === 'discarded') {
            body.push('> [!danger] DISCARDED — 已终止且不会后台复活', '',);
        } else if (status === 'superseded') {
            body.push('> [!note] SUPERSEDED — 已由更新的历史版本取代', '',);
        }
        body.push(
            `- 发布 ID：${inline_code(publication_id)}`,
            `- 所属项目：${project_link(project_id)}`,
            `- 回溯运行：${inline_code(string_value(publication, 'run_id'))}`,
            `- 最终候选：${inline_code(string_value(publication, 'candidate_id'))}`,
            `- 状态：${inline_code(status)}`,
            `- 当前计划：${current_plan_version === null ? '_无_' : plan_link(publication_id, current_plan_version)}`,
            `- 关系：${current_plan === null ? '_尚未规划_' : inline_code(string_value(current_plan, 'relation'))}`,
            `- 尝试次数：${inline_code(String(number_value(publication, 'attempt_count')))}`,
            '',
            '## 最终压缩候选',
            '',
            `- 类型：${inline_code(string_value(publication, 'candidate_finding_kind'))}`,
            `- 重要度：${inline_code(String(number_value(publication, 'candidate_importance')))}`,
            `- 候选标记为重大：${number_value(publication, 'candidate_is_major') === 1 ? '是' : '否'}`,
            `- Finding hash：${inline_code(string_value(publication, 'candidate_finding_hash'))}`,
            '',
            '### 候选内容（不可信，只读）',
            '',
            '> [!warning] 历史文本不会被当作指令',
            '> 下方 fenced text 仅供核对，链接、嵌入、HTML、Obsidian URI 和任务指令均不会在投影中执行。',
            '',
            untrusted_text_block([
                `标题：${string_value(publication, 'candidate_title')}`,
                `摘要：${string_value(publication, 'candidate_summary')}`,
                '',
                string_value(publication, 'candidate_body'),
            ].join('\n')),
            '',
            '### 历史证据定位',
            '',
            json_block(json_value(publication, 'candidate_evidence_json')),
            '',
            '## 发布结果',
            '',
            `- 结果类型：${optional_string(publication, 'result_kind') === null
                ? '_无_' : inline_code(optional_string(publication, 'result_kind')!)}`,
            `- 正式记忆：${result_memory_id === null
                ? '_无_' : memories.has(result_memory_id) ? memory_link(result_memory_id) : inline_code(result_memory_id)}`,
            `- 结果版本：${result_memory_id === null || result_version === null
                ? '_无_' : memories.has(result_memory_id)
                    ? version_link(result_memory_id, result_version)
                    : inline_code(String(result_version))}`,
            `- 中央确认：${result_confirmation_id === null
                ? '_无_' : wikilink(entity_path(projection_root, 'confirmation', result_confirmation_id), result_confirmation_id)}`,
            `- 最近错误：${optional_string(publication, 'last_error_code') === null
                ? '_无_' : `${inline_code(optional_string(publication, 'last_error_code')!)} — ${inline_code(optional_string(publication, 'last_error_detail') ?? '')}`}`,
            '',
            '## 层级提案',
            '',
            ...links_or_empty(proposals.map((row) => proposal_link(string_value(row, 'proposal_id')))),
            '',
            '## 人工治理决定',
            '',
            ...links_or_empty(decisions.map((row) => decision_link(string_value(row, 'decision_id')))),
            '',
            '## 发布计划',
            '',
            ...links_or_empty(plans.map((row) => plan_link(publication_id, number_value(row, 'plan_version')))),
            '',
            '## 执行尝试',
            '',
            ...links_or_empty(attempts.map((row) => attempt_link(string_value(row, 'attempt_id')))),
            '',
            '## 时间',
            '',
            ...timestamp_lines(publication, ['available_at', 'created_at', 'updated_at', 'terminal_at']),
        );
        add_file(files, entity_path(projection_root, 'history_publication', publication_id), markdown_note(
            base_fields('history_publication', publication_id, [
                ['publication_id', publication_id],
                ['project_id', project_id],
                ['run_id', string_value(publication, 'run_id')],
                ['candidate_id', string_value(publication, 'candidate_id')],
                ['title', string_value(publication, 'candidate_title')],
                ['status', status],
                ['relation', current_plan === null ? null : string_value(current_plan, 'relation')],
                ['current_plan_version', current_plan_version],
                ['result_memory_id', result_memory_id],
                ['result_version', result_version],
                ['result_confirmation_id', result_confirmation_id],
                ['attempt_count', number_value(publication, 'attempt_count')],
                ['needs_hierarchy_confirmation', status === 'awaiting_hierarchy'],
                ['needs_content_review', status === 'needs_review'],
                ['needs_central_confirmation', status === 'pending_confirmation'],
                ['created_at_ms', number_value(publication, 'created_at')],
                ['updated_at_ms', number_value(publication, 'updated_at')],
                ['terminal_at_ms', optional_number(publication, 'terminal_at')],
            ]),
            body,
        ), 'history_publication', publication_id);
    }

    for (const proposal of snapshot.hierarchy_proposals) {
        const proposal_id = string_value(proposal, 'proposal_id');
        const publication_id = string_value(proposal, 'publication_id');
        const publication = history_publications.get(publication_id);
        if (!publication) throw new Error(`hierarchy proposal references missing publication: ${publication_id}`);
        const decision_rows = (decisions_by_publication.get(publication_id) ?? [])
            .filter((row) => optional_string(row, 'proposal_id') === proposal_id);
        const accepted = decision_rows.find((row) => string_value(row, 'action') === 'accept_hierarchy');
        const rejected = decision_rows.find((row) => string_value(row, 'action') === 'reject_hierarchy');
        const governance_status = accepted ? 'accepted' : rejected ? 'rejected' : 'pending';
        const requires_human = string_value(proposal, 'role_mode') === 'proposed'
            || string_value(proposal, 'task_mode') === 'proposed';
        const body: string[] = [`# 层级提案 · ${display_text(proposal_id)}`, ''];
        if (governance_status === 'pending' && requires_human) {
            body.push(
                '> [!warning] PENDING HUMAN HIERARCHY DECISION',
                '> 新角色或新任务尚未获人类接受，不能据此创建正式层级。',
                '',
            );
        } else if (governance_status === 'accepted') {
            body.push('> [!success] ACCEPTED HIERARCHY', '',);
        } else if (governance_status === 'rejected') {
            body.push('> [!danger] REJECTED HIERARCHY', '',);
        }
        body.push(
            `- 提案 ID：${inline_code(proposal_id)}`,
            `- 发布：${publication_link(publication_id)}`,
            `- 所属项目：${project_link(string_value(publication, 'project_id'))}`,
            `- 建议层级：${inline_code(String(number_value(proposal, 'proposed_level')))}`,
            `- 范围：${inline_code(string_value(proposal, 'scope_kind'))}`,
            `- 置信度：${inline_code(String(number_value(proposal, 'confidence')))}`,
            `- 治理状态：${inline_code(governance_status)}`,
            '',
            '## 角色建议',
            '',
            `- 模式：${inline_code(string_value(proposal, 'role_mode'))}`,
            `- 角色 ID：${optional_string(proposal, 'role_id') === null ? '_无_' : inline_code(optional_string(proposal, 'role_id')!)}`,
            `- 语义键：${optional_string(proposal, 'role_semantic_key') === null ? '_无_' : inline_code(optional_string(proposal, 'role_semantic_key')!)}`,
            `- 名称：${optional_string(proposal, 'role_name') === null
                ? '_无_' : inline_code(optional_string(proposal, 'role_name')!)}`,
            `- 职责：${optional_string(proposal, 'role_responsibility') === null
                ? '_无_' : inline_code(optional_string(proposal, 'role_responsibility')!)}`,
            '',
            '## 任务建议',
            '',
            `- 模式：${inline_code(string_value(proposal, 'task_mode'))}`,
            `- 任务 ID：${optional_string(proposal, 'task_id') === null ? '_无_' : inline_code(optional_string(proposal, 'task_id')!)}`,
            `- 语义键：${optional_string(proposal, 'task_semantic_key') === null ? '_无_' : inline_code(optional_string(proposal, 'task_semantic_key')!)}`,
            `- 标题：${optional_string(proposal, 'task_title') === null
                ? '_无_' : inline_code(optional_string(proposal, 'task_title')!)}`,
            `- 目标：${optional_string(proposal, 'task_objective') === null
                ? '_无_' : inline_code(optional_string(proposal, 'task_objective')!)}`,
            '',
            '## 人工决定',
            '',
            ...links_or_empty(decision_rows.map((row) => decision_link(string_value(row, 'decision_id')))),
            '',
            '## 证据',
            '',
            json_block(json_value(proposal, 'evidence_json')),
            '',
            '## 审计',
            '',
            `- Worker task：${inline_code(string_value(proposal, 'worker_session_id'))}`,
            `- Worker turn：${inline_code(string_value(proposal, 'worker_turn_id'))}`,
            `- 提案哈希：${inline_code(string_value(proposal, 'proposal_hash'))}`,
            ...timestamp_lines(proposal, ['created_at']),
        );
        add_file(files, entity_path(projection_root, 'hierarchy_proposal', proposal_id), markdown_note(
            base_fields('hierarchy_proposal', proposal_id, [
                ['proposal_id', proposal_id],
                ['publication_id', publication_id],
                ['project_id', string_value(publication, 'project_id')],
                ['proposed_level', number_value(proposal, 'proposed_level')],
                ['role_mode', string_value(proposal, 'role_mode')],
                ['role_id', optional_string(proposal, 'role_id')],
                ['task_mode', string_value(proposal, 'task_mode')],
                ['task_id', optional_string(proposal, 'task_id')],
                ['confidence', number_value(proposal, 'confidence')],
                ['governance_status', governance_status],
                ['requires_human', requires_human],
                ['created_at_ms', number_value(proposal, 'created_at')],
            ]),
            body,
        ), 'hierarchy_proposal', proposal_id);
    }

    for (const decision of snapshot.governance_decisions) {
        const decision_id = string_value(decision, 'decision_id');
        const publication_id = string_value(decision, 'publication_id');
        const publication = history_publications.get(publication_id);
        if (!publication) throw new Error(`governance decision references missing publication: ${publication_id}`);
        const proposal_id = optional_string(decision, 'proposal_id');
        const plan_version = optional_number(decision, 'plan_version');
        const action = string_value(decision, 'action');
        add_file(files, entity_path(projection_root, 'governance_decision', decision_id), markdown_note(
            base_fields('governance_decision', decision_id, [
                ['decision_id', decision_id],
                ['publication_id', publication_id],
                ['project_id', string_value(publication, 'project_id')],
                ['proposal_id', proposal_id],
                ['plan_version', plan_version],
                ['action', action],
                ['actor_kind', string_value(decision, 'actor_kind')],
                ['actor_id', string_value(decision, 'actor_id')],
                ['channel', string_value(decision, 'channel')],
                ['created_at_ms', number_value(decision, 'created_at')],
            ]),
            [
                `# 人工治理决定 · ${display_text(action)}`,
                '',
                '> [!important] IMMUTABLE GOVERNANCE EVIDENCE',
                '> 本页是不可变决定记录的只读投影；编辑此文件不会改变批准状态。',
                '',
                `- 决定 ID：${inline_code(decision_id)}`,
                `- 发布：${publication_link(publication_id)}`,
                `- 所属项目：${project_link(string_value(publication, 'project_id'))}`,
                `- 动作：${inline_code(action)}`,
                `- 层级提案：${proposal_id === null ? '_无_' : proposal_link(proposal_id)}`,
                `- 发布计划：${plan_version === null ? '_无_' : plan_link(publication_id, plan_version)}`,
                `- 操作者类型：${inline_code(string_value(decision, 'actor_kind'))}`,
                `- 操作者：${inline_code(string_value(decision, 'actor_id'))}`,
                `- Action ID：${inline_code(string_value(decision, 'action_id'))}`,
                `- 渠道：${inline_code(string_value(decision, 'channel'))}`,
                `- 说明：${string_value(decision, 'note')
                    ? inline_code(string_value(decision, 'note')) : '_无_'}`,
                `- Payload hash：${inline_code(string_value(decision, 'payload_hash'))}`,
                ...timestamp_lines(decision, ['created_at']),
                '',
                '## 决定证据',
                '',
                json_block(json_value(decision, 'evidence_json')),
            ],
        ), 'governance_decision', decision_id);
    }

    for (const plan of snapshot.publication_plans) {
        const publication_id = string_value(plan, 'publication_id');
        const plan_version = number_value(plan, 'plan_version');
        const record_id = `${publication_id}@${String(plan_version)}`;
        const publication = history_publications.get(publication_id);
        if (!publication) throw new Error(`publication plan references missing publication: ${publication_id}`);
        const proposal_id = string_value(plan, 'proposal_id');
        if (!hierarchy_proposals.has(proposal_id)) {
            throw new Error(`publication plan references missing hierarchy proposal: ${proposal_id}`);
        }
        const hierarchy_decision_id = optional_string(plan, 'hierarchy_decision_id');
        const role_id = optional_string(plan, 'role_id');
        const task_id = optional_string(plan, 'task_id');
        const target_memory_id = string_value(plan, 'target_memory_id');
        const expected_current_version = optional_number(plan, 'expected_current_version');
        const is_current = optional_number(publication, 'current_plan_version') === plan_version;
        const relation = string_value(plan, 'relation');
        const body: string[] = [`# 发布计划 · ${display_text(record_id)}`, ''];
        if (is_current) body.push('> [!info] CURRENT IMMUTABLE PLAN', '> 执行时必须精确匹配本页的 CAS 快照。', '');
        else body.push('> [!note] HISTORICAL PLAN', '> 该计划已不是当前计划，仅用于审计。', '');
        if (relation === 'update' || relation === 'conflict') {
            body.push(
                '> [!warning] HUMAN CONTENT DECISION REQUIRED',
                `> ${relation === 'conflict' ? '冲突' : '内容更新'}在执行前必须有对应的人类治理决定。`,
                '',
            );
        }
        body.push(
            `- 发布：${publication_link(publication_id)}`,
            `- 计划版本：${inline_code(String(plan_version))}`,
            `- 当前计划：${is_current ? '是' : '否'}`,
            `- 所属项目：${project_link(string_value(plan, 'project_id'))}`,
            `- 层级提案：${proposal_link(proposal_id)}`,
            `- 层级决定：${hierarchy_decision_id === null ? '_无_' : decision_link(hierarchy_decision_id)}`,
            `- 层级：${inline_code(String(number_value(plan, 'level')))}`,
            `- 角色：${role_id === null ? '_无_' : role_link(role_id)}`,
            `- 任务：${task_id === null ? '_无_' : task_link(task_id)}`,
            `- 类型：${inline_code(string_value(plan, 'memory_kind'))}`,
            `- 语义键：${inline_code(string_value(plan, 'semantic_key_normalized'))}`,
            `- 关系：${inline_code(relation)}`,
            `- 重大：${number_value(plan, 'is_major') === 1 ? '是' : '否'}`,
            `- 目标记忆：${memories.has(target_memory_id) ? memory_link(target_memory_id) : inline_code(target_memory_id)}`,
            '',
            '## 精确 CAS 快照',
            '',
            `- 规划时记忆存在：${number_value(plan, 'expected_memory_exists') === 1 ? '是' : '否'}`,
            `- 预期当前版本：${expected_current_version === null ? '_无_' : inline_code(String(expected_current_version))}`,
            `- 预期状态：${optional_string(plan, 'expected_current_status') === null
                ? '_无_' : inline_code(optional_string(plan, 'expected_current_status')!)}`,
            `- 预期内容哈希：${optional_string(plan, 'expected_current_content_hash') === null
                ? '_无_' : inline_code(optional_string(plan, 'expected_current_content_hash')!)}`,
            `- 候选内容哈希：${inline_code(string_value(plan, 'publication_content_hash'))}`,
            '',
            '## 差异与冲突',
            '',
            json_block(json_value(plan, 'conflicts_json')),
            '',
            '## 审计',
            '',
            `- Semantic identity：${inline_code(string_value(plan, 'semantic_identity_hash'))}`,
            `- Candidate finding：${inline_code(string_value(plan, 'candidate_finding_hash'))}`,
            `- Plan hash：${inline_code(string_value(plan, 'plan_hash'))}`,
            `- Worker task：${inline_code(string_value(plan, 'created_by_session_id'))}`,
            `- Worker turn：${inline_code(string_value(plan, 'created_by_turn_id'))}`,
            ...timestamp_lines(plan, ['created_at']),
        );
        add_file(files, entity_path(projection_root, 'publication_plan', record_id), markdown_note(
            base_fields('publication_plan', record_id, [
                ['publication_id', publication_id],
                ['plan_version', plan_version],
                ['project_id', string_value(plan, 'project_id')],
                ['proposal_id', proposal_id],
                ['level', number_value(plan, 'level')],
                ['role_id', role_id],
                ['task_id', task_id],
                ['memory_kind', string_value(plan, 'memory_kind')],
                ['relation', relation],
                ['target_memory_id', target_memory_id],
                ['expected_current_version', expected_current_version],
                ['is_major', number_value(plan, 'is_major') === 1],
                ['is_current', is_current],
                ['created_at_ms', number_value(plan, 'created_at')],
            ]),
            body,
        ), 'publication_plan', record_id);
    }

    for (const attempt of snapshot.publication_attempts) {
        const attempt_id = string_value(attempt, 'attempt_id');
        const publication_id = string_value(attempt, 'publication_id');
        const publication = history_publications.get(publication_id);
        if (!publication) throw new Error(`publication attempt references missing publication: ${publication_id}`);
        const plan_version = number_value(attempt, 'plan_version');
        const outcome = string_value(attempt, 'outcome');
        const result_memory_id = optional_string(attempt, 'result_memory_id');
        const result_version = optional_number(attempt, 'result_version');
        const result_confirmation_id = optional_string(attempt, 'result_confirmation_id');
        const body: string[] = [`# 发布尝试 · ${display_text(attempt_id)}`, ''];
        if (outcome === 'needs_review' || outcome === 'retryable') {
            body.push(
                `> [!warning] ${outcome.toUpperCase()}`,
                '> 本次尝试没有写入正式结果；请根据错误信息重新审核或安全重试。',
                '',
            );
        } else if (outcome === 'pending_confirmation') {
            body.push('> [!important] PENDING CENTRAL CONFIRMATION — 尚未生效', '',);
        } else {
            body.push('> [!success] COMMITTED ATTEMPT', '',);
        }
        body.push(
            `- 尝试 ID：${inline_code(attempt_id)}`,
            `- 发布：${publication_link(publication_id)}`,
            `- 计划：${plan_link(publication_id, plan_version)}`,
            `- 结果：${inline_code(outcome)}`,
            `- 正式记忆：${result_memory_id === null
                ? '_无_' : memories.has(result_memory_id) ? memory_link(result_memory_id) : inline_code(result_memory_id)}`,
            `- 结果版本：${result_memory_id === null || result_version === null
                ? '_无_' : memories.has(result_memory_id)
                    ? version_link(result_memory_id, result_version)
                    : inline_code(String(result_version))}`,
            `- 中央确认：${result_confirmation_id === null
                ? '_无_' : wikilink(entity_path(projection_root, 'confirmation', result_confirmation_id), result_confirmation_id)}`,
            `- 错误代码：${optional_string(attempt, 'error_code') === null
                ? '_无_' : inline_code(optional_string(attempt, 'error_code')!)}`,
            `- 错误详情：${optional_string(attempt, 'error_detail') === null
                ? '_无_' : inline_code(optional_string(attempt, 'error_detail')!)}`,
            '',
            '## 执行身份',
            '',
            `- Worker task：${inline_code(string_value(attempt, 'worker_session_id'))}`,
            `- Worker turn：${inline_code(string_value(attempt, 'worker_turn_id'))}`,
            `- Request hash：${inline_code(string_value(attempt, 'request_hash'))}`,
            ...timestamp_lines(attempt, ['created_at']),
        );
        add_file(files, entity_path(projection_root, 'publication_attempt', attempt_id), markdown_note(
            base_fields('publication_attempt', attempt_id, [
                ['attempt_id', attempt_id],
                ['publication_id', publication_id],
                ['project_id', string_value(publication, 'project_id')],
                ['plan_version', plan_version],
                ['outcome', outcome],
                ['result_memory_id', result_memory_id],
                ['result_version', result_version],
                ['result_confirmation_id', result_confirmation_id],
                ['error_code', optional_string(attempt, 'error_code')],
                ['created_at_ms', number_value(attempt, 'created_at')],
            ]),
            body,
        ), 'publication_attempt', attempt_id);
    }

    const dashboard_specs: Array<{
        filename: string;
        record_kind: string;
        name: string;
        order: string[];
        filters?: string[];
    }> = [
        { filename: 'Projects.base', record_kind: 'project', name: 'Projects', order: ['file.name', 'name', 'status', 'updated_at_ms'] },
        {
            filename: 'Project Links.base', record_kind: 'project_link', name: 'Project Links',
            order: ['file.name', 'source_project_id', 'target_project_id', 'allowed_level', 'status', 'created_at_ms'],
        },
        { filename: 'Roles.base', record_kind: 'role', name: 'Roles', order: ['file.name', 'name', 'project_id', 'status'] },
        { filename: 'Tasks.base', record_kind: 'task', name: 'Tasks', order: ['file.name', 'title', 'project_id', 'role_id', 'status'] },
        {
            filename: 'Current Memories.base', record_kind: 'memory', name: 'Current Memories',
            order: ['file.name', 'title', 'level', 'memory_kind', 'status', 'current_version', 'project_id'],
            filters: ['current_version != null'],
        },
        {
            filename: 'Versions.base', record_kind: 'memory_version', name: 'Memory Versions',
            order: ['file.name', 'title', 'memory_id', 'version', 'status', 'importance', 'is_major'],
        },
        {
            filename: 'Threads.base', record_kind: 'thread', name: 'Threads',
            order: ['file.name', 'thread_id', 'project_id', 'role_id', 'task_id', 'status', 'updated_at_ms'],
        },
        {
            filename: 'Sources.base', record_kind: 'source', name: 'Sources',
            order: ['file.name', 'source_kind', 'source_id', 'thread_id', 'turn_id', 'recorded_at_ms'],
        },
        {
            filename: 'Pending Confirmations.base', record_kind: 'confirmation', name: 'Pending Confirmations',
            order: ['file.name', 'confirmation_id', 'memory_id', 'proposed_version', 'confirmation_kind', 'requested_at_ms'],
            filters: ['status == "pending"'],
        },
        {
            filename: 'Open Conflicts.base', record_kind: 'conflict', name: 'Open Conflicts',
            order: ['file.name', 'conflict_id', 'severity', 'memory_a_id', 'memory_b_id', 'created_at_ms'],
            filters: ['status == "open"'],
        },
        {
            filename: 'Dependencies.base', record_kind: 'dependency', name: 'Dependencies',
            order: ['file.name', 'dependency_id', 'subject_kind', 'subject_id', 'memory_id', 'memory_version', 'status'],
        },
        {
            filename: 'History Publications.base', record_kind: 'history_publication', name: 'History Publications',
            order: ['file.name', 'title', 'project_id', 'status', 'relation', 'current_plan_version', 'attempt_count', 'updated_at_ms'],
        },
        {
            filename: 'Pending Hierarchy Review.base', record_kind: 'history_publication', name: 'Pending Hierarchy Review',
            order: ['file.name', 'title', 'project_id', 'status', 'created_at_ms'],
            filters: ['status == "awaiting_hierarchy"'],
        },
        {
            filename: 'Pending Content Review.base', record_kind: 'history_publication', name: 'Pending Content Review',
            order: ['file.name', 'title', 'project_id', 'relation', 'status', 'updated_at_ms'],
            filters: ['status == "needs_review"'],
        },
        {
            filename: 'Pending Central Confirmation.base', record_kind: 'history_publication', name: 'Pending Central Confirmation',
            order: ['file.name', 'title', 'project_id', 'result_memory_id', 'result_version', 'result_confirmation_id', 'updated_at_ms'],
            filters: ['status == "pending_confirmation"'],
        },
        {
            filename: 'Hierarchy Proposals.base', record_kind: 'hierarchy_proposal', name: 'Hierarchy Proposals',
            order: ['file.name', 'project_id', 'publication_id', 'proposed_level', 'role_mode', 'task_mode', 'governance_status', 'confidence'],
        },
        {
            filename: 'Governance Decisions.base', record_kind: 'governance_decision', name: 'Governance Decisions',
            order: ['file.name', 'project_id', 'publication_id', 'action', 'actor_id', 'channel', 'created_at_ms'],
        },
        {
            filename: 'Publication Plans.base', record_kind: 'publication_plan', name: 'Publication Plans',
            order: ['file.name', 'project_id', 'publication_id', 'plan_version', 'relation', 'level', 'target_memory_id', 'is_major', 'is_current'],
        },
        {
            filename: 'Publication Attempts.base', record_kind: 'publication_attempt', name: 'Publication Attempts',
            order: ['file.name', 'project_id', 'publication_id', 'plan_version', 'outcome', 'result_memory_id', 'result_version', 'error_code'],
        },
    ];
    for (const dashboard of dashboard_specs) {
        add_file(
            files,
            `${projection_root}/Dashboards/${dashboard.filename}`,
            dashboard_content(dashboard.record_kind, dashboard.name, dashboard.order, dashboard.filters),
            'dashboard',
            dashboard.name,
        );
    }

    const pending_confirmations = snapshot.confirmations.filter((row) => string_value(row, 'status') === 'pending').length;
    const open_conflicts = snapshot.conflicts.filter((row) => string_value(row, 'status') === 'open').length;
    const dependency_warnings = snapshot.dependencies
        .filter((row) => ['needs_review', 'invalidated'].includes(string_value(row, 'status'))).length;
    const pending_hierarchy_reviews = snapshot.history_publications
        .filter((row) => string_value(row, 'status') === 'awaiting_hierarchy').length;
    const pending_content_reviews = snapshot.history_publications
        .filter((row) => string_value(row, 'status') === 'needs_review').length;
    const pending_central_confirmations = snapshot.history_publications
        .filter((row) => string_value(row, 'status') === 'pending_confirmation').length;
    add_file(files, `${projection_root}/Home.md`, markdown_note(
        base_fields('home', 'home', [
            ['project_count', snapshot.projects.length],
            ['project_link_count', snapshot.project_links.length],
            ['role_count', snapshot.roles.length],
            ['task_count', snapshot.tasks.length],
            ['memory_count', snapshot.memories.length],
            ['thread_count', snapshot.threads.length],
            ['pending_confirmation_count', pending_confirmations],
            ['open_conflict_count', open_conflicts],
            ['dependency_warning_count', dependency_warnings],
            ['history_publication_count', snapshot.history_publications.length],
            ['pending_hierarchy_review_count', pending_hierarchy_reviews],
            ['pending_content_review_count', pending_content_reviews],
            ['pending_central_confirmation_count', pending_central_confirmations],
        ]),
        [
            '# LongMemory 中央记忆',
            '',
            '> [!info] 只读投影视图',
            '> SQLite 中央记忆库是唯一真源。本目录由投影器生成；请不要直接修改生成页。需要提交建议时，请使用 Proposals/inbox。',
            '',
            '## 状态概览',
            '',
            `- 项目：${snapshot.projects.length}`,
            `- 项目联动方向：${snapshot.project_links.length}`,
            `- 角色：${snapshot.roles.length}`,
            `- 任务：${snapshot.tasks.length}`,
            `- 记忆：${snapshot.memories.length}`,
            `- 版本：${snapshot.versions.length}`,
            `- 对话任务：${snapshot.threads.length}`,
            `- 待确认：${pending_confirmations}`,
            `- 未解决冲突：${open_conflicts}`,
            `- 需要处理的依赖：${dependency_warnings}`,
            `- 历史回溯发布：${snapshot.history_publications.length}`,
            `- 待层级确认：${pending_hierarchy_reviews}`,
            `- 待内容审核：${pending_content_reviews}`,
            `- 待中央确认：${pending_central_confirmations}`,
            '',
            '## 可浏览视图',
            '',
            ...dashboard_specs.flatMap((dashboard) => [
                `### ${dashboard.name}`,
                '',
                `![[${projection_root}/Dashboards/${dashboard.filename}]]`,
                '',
            ]),
            '## 提案区',
            '',
            `- [[${projection_root}/Proposals/README|使用说明]]`,
            `- [[${projection_root}/Proposals/TEMPLATE|提案模板]]`,
            `- 提案收件箱：${inline_code(`${projection_root}/Proposals/inbox/`)}`,
        ],
    ), 'home', 'home');

    add_file(files, `${projection_root}/Proposals/README.md`, markdown_note(
        base_fields('guide', 'proposal-readme', [['title', 'LongMemory proposal inbox']]),
        [
            '# LongMemory 提案区',
            '',
            '中央记忆和本 Vault 中的生成页均不是在这里直接编辑的。SQLite 是唯一真源。',
            '',
            '如需新增、修订、锁定、撤回记忆，或处理确认与冲突：',
            '',
            `1. 复制 [[${projection_root}/Proposals/TEMPLATE|提案模板]]。`,
            `2. 将副本放入 ${inline_code(`${projection_root}/Proposals/inbox/`)}。`,
            '3. 填写目标记录、理由、证据和期望动作。',
            '4. 交由 LongMemory 的管理流程审阅并写入 SQLite。',
            '',
            '> [!warning] 提案不等于批准',
            '> 投影器不会读取提案、不会根据提案修改数据库，也不会把提案当作用户确认。重大规则仍需通过受控确认流程。',
            '',
            '> [!important] 唯一可人工编辑区域',
            `> 只有 ${inline_code(`${projection_root}/Proposals/inbox/`)} 是人工文件区。其他 LongMemory 生成文件若被修改，投影器会拒绝覆盖。`,
        ],
    ), 'guide', 'proposal-readme');

    add_file(files, `${projection_root}/Proposals/TEMPLATE.md`, markdown_note(
        base_fields('guide', 'proposal-template', [['title', 'LongMemory proposal template']]),
        [
            '# LongMemory 记忆变更提案',
            '',
            '> 将本文件复制到 `inbox/` 后再填写。不要直接修改模板。',
            '',
            '## 目标',
            '',
            '- 动作：新增 / 修订 / 锁定 / 撤回 / 解决冲突 / 其他',
            '- 目标 memory_id / confirmation_id / conflict_id：',
            '- 预期当前版本：',
            '',
            '## 建议内容',
            '',
            '- 标题：',
            '- 摘要：',
            '- 准确正文：',
            '',
            '## 理由与影响',
            '',
            '- 为什么需要变更：',
            '- 可能影响哪些任务、作品或结论：',
            '- 是否属于重大规则：',
            '',
            '## 证据',
            '',
            '- 来源 URI / 对话 / 文件：',
            '- 精确定位：',
            '- 必要摘录或说明：',
            '',
            '## 人工决定',
            '',
            '_此区由受控管理流程填写。仅创建本提案不构成批准。_',
        ],
    ), 'guide', 'proposal-template');

    return [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

const projection_kinds = new Set<projection_kind>([
    'home',
    'project',
    'project_link',
    'role',
    'task',
    'memory',
    'memory_version',
    'thread',
    'source',
    'confirmation',
    'conflict',
    'dependency',
    'history_publication',
    'hierarchy_proposal',
    'governance_decision',
    'publication_plan',
    'publication_attempt',
    'dashboard',
    'guide',
]);

function object_value(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ObsidianProjectionOwnershipError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exact_keys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new ObsidianProjectionOwnershipError(`${label} has unknown or missing fields`);
    }
}

function valid_checksum(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function assert_managed_path(relative_path: string, projection_root: string, proposal_inbox: string): void {
    if (relative_path.length > 32_768
        || normalize_relative_path(relative_path, 'manifest path') !== relative_path) {
        throw new ObsidianProjectionOwnershipError(`unsafe managed path: ${relative_path}`);
    }
    const entry_key = ownership_key(relative_path);
    const projection_prefix = `${ownership_key(projection_root)}/`;
    const inbox_key = ownership_key(proposal_inbox);
    if (!entry_key.startsWith(projection_prefix)) {
        throw new ObsidianProjectionOwnershipError(`managed path is outside projection_root: ${relative_path}`);
    }
    if (entry_key === inbox_key || entry_key.startsWith(`${inbox_key}/`)) {
        throw new ObsidianProjectionOwnershipError('proposal inbox cannot be manifest-managed');
    }
}

function canonical_managed_path(
    projection_root: string,
    kind: projection_kind,
    record_id: string,
): string {
    if (['project', 'project_link', 'role', 'task', 'memory', 'thread', 'source', 'confirmation', 'conflict', 'dependency',
        'history_publication', 'hierarchy_proposal', 'governance_decision',
        'publication_plan', 'publication_attempt']
        .includes(kind)) {
        return entity_path(projection_root, kind, record_id);
    }
    if (kind === 'memory_version') {
        const separator = record_id.lastIndexOf('@');
        const memory_id = record_id.slice(0, separator);
        const version_text = record_id.slice(separator + 1);
        const version = Number(version_text);
        if (separator <= 0 || !/^\d+$/u.test(version_text) || !Number.isSafeInteger(version) || version <= 0) {
            throw new ObsidianProjectionOwnershipError('memory_version record_id is invalid');
        }
        return memory_version_path(projection_root, memory_id, version);
    }
    if (kind === 'home' && record_id === 'home') return `${projection_root}/Home.md`;
    if (kind === 'guide' && record_id === 'proposal-readme') return `${projection_root}/Proposals/README.md`;
    if (kind === 'guide' && record_id === 'proposal-template') return `${projection_root}/Proposals/TEMPLATE.md`;
    if (kind === 'dashboard') {
        const dashboards: Record<string, string> = {
            Projects: 'Projects.base',
            'Project Links': 'Project Links.base',
            Roles: 'Roles.base',
            Tasks: 'Tasks.base',
            'Current Memories': 'Current Memories.base',
            'Memory Versions': 'Versions.base',
            Threads: 'Threads.base',
            Sources: 'Sources.base',
            'Pending Confirmations': 'Pending Confirmations.base',
            'Open Conflicts': 'Open Conflicts.base',
            Dependencies: 'Dependencies.base',
            'History Publications': 'History Publications.base',
            'Pending Hierarchy Review': 'Pending Hierarchy Review.base',
            'Pending Content Review': 'Pending Content Review.base',
            'Pending Central Confirmation': 'Pending Central Confirmation.base',
            'Hierarchy Proposals': 'Hierarchy Proposals.base',
            'Governance Decisions': 'Governance Decisions.base',
            'Publication Plans': 'Publication Plans.base',
            'Publication Attempts': 'Publication Attempts.base',
        };
        const filename = dashboards[record_id];
        if (filename) return `${projection_root}/Dashboards/${filename}`;
    }
    throw new ObsidianProjectionOwnershipError(`unsupported managed identity: ${kind}:${record_id}`);
}

function parse_manifest(
    decoded: unknown,
    scope_fingerprint: string,
    vault_root_fingerprint: string,
    projection_root: string,
    proposal_inbox: string,
): projection_manifest {
    const value = object_value(decoded, 'projection manifest');
    exact_keys(value, [
        'generator', 'schema_version', 'scope_fingerprint', 'vault_root_fingerprint',
        'projection_root', 'source_fingerprint', 'proposal_inbox', 'managed_files',
    ], 'projection manifest');
    if (value.generator !== GENERATOR || value.schema_version !== MANIFEST_SCHEMA) {
        throw new ObsidianProjectionOwnershipError('projection manifest generator or schema does not match');
    }
    if (value.scope_fingerprint !== scope_fingerprint) {
        throw new ObsidianProjectionOwnershipError('projection manifest belongs to a different tenant/user scope');
    }
    if (value.vault_root_fingerprint !== vault_root_fingerprint) {
        throw new ObsidianProjectionOwnershipError('projection manifest belongs to a different vault');
    }
    if (value.projection_root !== projection_root || value.proposal_inbox !== proposal_inbox) {
        throw new ObsidianProjectionOwnershipError('projection manifest root does not match this projection');
    }
    if (!valid_checksum(value.source_fingerprint)) {
        throw new ObsidianProjectionOwnershipError('projection manifest has an invalid source fingerprint');
    }
    if (!Array.isArray(value.managed_files) || value.managed_files.length > MAX_MANAGED_FILES) {
        throw new ObsidianProjectionOwnershipError('projection manifest managed_files must be an array');
    }
    const managed_files: manifest_file[] = [];
    const seen = new Set<string>();
    for (const [index, item] of value.managed_files.entries()) {
        const entry = object_value(item, `managed_files[${String(index)}]`);
        exact_keys(entry, ['path', 'sha256', 'kind', 'record_id'], `managed_files[${String(index)}]`);
        if (typeof entry.path !== 'string') {
            throw new ObsidianProjectionOwnershipError(`managed_files[${String(index)}] has an unsafe path`);
        }
        assert_managed_path(entry.path, projection_root, proposal_inbox);
        const entry_key = ownership_key(entry.path);
        if (seen.has(entry_key)) {
            throw new ObsidianProjectionOwnershipError(`duplicate managed path: ${entry.path}`);
        }
        if (!valid_checksum(entry.sha256)) {
            throw new ObsidianProjectionOwnershipError(`managed_files[${String(index)}] has an invalid checksum`);
        }
        if (typeof entry.kind !== 'string' || !projection_kinds.has(entry.kind as projection_kind)) {
            throw new ObsidianProjectionOwnershipError(`managed_files[${String(index)}] has an invalid kind`);
        }
        if (typeof entry.record_id !== 'string' || Buffer.byteLength(entry.record_id) > 65_536) {
            throw new ObsidianProjectionOwnershipError(`managed_files[${String(index)}] has an invalid record_id`);
        }
        if (canonical_managed_path(projection_root, entry.kind as projection_kind, entry.record_id) !== entry.path) {
            throw new ObsidianProjectionOwnershipError(
                `managed_files[${String(index)}] path does not match kind/record_id`,
            );
        }
        seen.add(entry_key);
        managed_files.push({
            path: entry.path,
            sha256: entry.sha256,
            kind: entry.kind as projection_kind,
            record_id: entry.record_id,
        });
    }
    return {
        generator: GENERATOR,
        schema_version: MANIFEST_SCHEMA,
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        source_fingerprint: value.source_fingerprint,
        proposal_inbox,
        managed_files,
    };
}

type loaded_state_file = { bytes: string; checksum: string };

function load_state_file(
    state_root: string,
    relative_path: string,
    maximum_bytes: number,
    label: string,
): loaded_state_file | null {
    assert_existing_components_are_safe(state_root, relative_path);
    const absolute = inside_vault(state_root, relative_path);
    const stat = lstat_if_present(absolute);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ObsidianProjectionOwnershipError(`${label} must be a regular file`);
    }
    if (stat.size > maximum_bytes) {
        throw new ObsidianProjectionOwnershipError(`${label} exceeds its size limit`);
    }
    const bytes = readFileSync(absolute, 'utf8');
    return { bytes, checksum: sha256(bytes) };
}

function decode_state_json(bytes: string, label: string): unknown {
    try {
        return JSON.parse(bytes) as unknown;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ObsidianProjectionOwnershipError(`${label} is invalid JSON: ${reason}`);
    }
}

function manifest_bytes(manifest: projection_manifest): string {
    return `${stable_json(manifest, 2)}\n`;
}

function load_manifest(
    state_root: string,
    manifest_path: string,
    scope_fingerprint: string,
    vault_root_fingerprint: string,
    projection_root: string,
    proposal_inbox: string,
): { manifest: projection_manifest | null; checksum: string | null; bytes: string | null } {
    const loaded = load_state_file(
        state_root, manifest_path, MAX_STATE_FILE_BYTES, 'projection ownership manifest',
    );
    if (!loaded) return { manifest: null, checksum: null, bytes: null };
    const manifest = parse_manifest(
        decode_state_json(loaded.bytes, 'projection ownership manifest'),
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        proposal_inbox,
    );
    const canonical = manifest_bytes(manifest);
    if (canonical !== loaded.bytes) {
        throw new ObsidianProjectionOwnershipError('projection ownership manifest is not canonical');
    }
    return { manifest, checksum: loaded.checksum, bytes: loaded.bytes };
}

function parse_journal(
    decoded: unknown,
    scope_fingerprint: string,
    vault_root_fingerprint: string,
    projection_root: string,
    proposal_inbox: string,
): projection_journal {
    const value = object_value(decoded, 'projection recovery journal');
    exact_keys(value, [
        'generator', 'schema_version', 'credential_detector_version', 'transaction_id', 'scope_fingerprint',
        'vault_root_fingerprint', 'projection_root', 'base_manifest_checksum',
        'base_manifest', 'next_manifest_checksum', 'next_manifest', 'writes', 'removals',
    ], 'projection recovery journal');
    if (value.generator !== GENERATOR || value.schema_version !== JOURNAL_SCHEMA) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal generator or schema does not match');
    }
    if (value.credential_detector_version !== obvious_credential_detector_version) {
        throw new ObsidianProjectionOwnershipError(
            'projection recovery journal credential detector version does not match',
        );
    }
    if (!valid_checksum(value.transaction_id)
        || value.scope_fingerprint !== scope_fingerprint
        || value.vault_root_fingerprint !== vault_root_fingerprint
        || value.projection_root !== projection_root) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal scope is invalid');
    }
    if (value.base_manifest_checksum !== null && !valid_checksum(value.base_manifest_checksum)) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal base checksum is invalid');
    }
    if (!valid_checksum(value.next_manifest_checksum)) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal next checksum is invalid');
    }
    const base_manifest = value.base_manifest === null ? null : parse_manifest(
        value.base_manifest, scope_fingerprint, vault_root_fingerprint, projection_root, proposal_inbox,
    );
    const next_manifest = parse_manifest(
        value.next_manifest, scope_fingerprint, vault_root_fingerprint, projection_root, proposal_inbox,
    );
    if ((base_manifest === null) !== (value.base_manifest_checksum === null)) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal base manifest is inconsistent');
    }
    if (base_manifest && sha256(manifest_bytes(base_manifest)) !== value.base_manifest_checksum) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal base manifest checksum mismatches');
    }
    if (sha256(manifest_bytes(next_manifest)) !== value.next_manifest_checksum) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal next manifest checksum mismatches');
    }
    if (!Array.isArray(value.writes) || !Array.isArray(value.removals)
        || value.writes.length > MAX_MANAGED_FILES || value.removals.length > MAX_MANAGED_FILES) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal operation lists are invalid');
    }
    const base_by_path = new Map((base_manifest?.managed_files ?? []).map((entry) => [entry.path, entry]));
    const next_by_path = new Map(next_manifest.managed_files.map((entry) => [entry.path, entry]));
    const touched = new Set<string>();
    const writes: journal_write[] = value.writes.map((item, index) => {
        const row = object_value(item, `writes[${String(index)}]`);
        exact_keys(row, ['path', 'before_sha256', 'after_sha256', 'content'], `writes[${String(index)}]`);
        if (typeof row.path !== 'string' || typeof row.content !== 'string'
            || (row.before_sha256 !== null && !valid_checksum(row.before_sha256))
            || !valid_checksum(row.after_sha256)) {
            throw new ObsidianProjectionOwnershipError(`writes[${String(index)}] is invalid`);
        }
        assert_managed_path(row.path, projection_root, proposal_inbox);
        if (Buffer.byteLength(row.content) > MAX_GENERATED_FILE_BYTES || sha256(row.content) !== row.after_sha256) {
            throw new ObsidianProjectionOwnershipError(`writes[${String(index)}] content is invalid`);
        }
        const next = next_by_path.get(row.path);
        const base = base_by_path.get(row.path);
        if (!next || next.sha256 !== row.after_sha256
            || (row.before_sha256 === null ? base !== undefined : base?.sha256 !== row.before_sha256)) {
            throw new ObsidianProjectionOwnershipError(`writes[${String(index)}] is not authorized by manifests`);
        }
        const key = ownership_key(row.path);
        if (touched.has(key)) throw new ObsidianProjectionOwnershipError(`duplicate journal path: ${row.path}`);
        touched.add(key);
        return {
            path: row.path,
            before_sha256: row.before_sha256,
            after_sha256: row.after_sha256,
            content: row.content,
        };
    });
    const removals: journal_removal[] = value.removals.map((item, index) => {
        const row = object_value(item, `removals[${String(index)}]`);
        exact_keys(row, ['path', 'before_sha256'], `removals[${String(index)}]`);
        if (typeof row.path !== 'string' || !valid_checksum(row.before_sha256)) {
            throw new ObsidianProjectionOwnershipError(`removals[${String(index)}] is invalid`);
        }
        assert_managed_path(row.path, projection_root, proposal_inbox);
        const base = base_by_path.get(row.path);
        if (!base || base.sha256 !== row.before_sha256 || next_by_path.has(row.path)) {
            throw new ObsidianProjectionOwnershipError(`removals[${String(index)}] is not authorized by manifests`);
        }
        const key = ownership_key(row.path);
        if (touched.has(key)) throw new ObsidianProjectionOwnershipError(`duplicate journal path: ${row.path}`);
        touched.add(key);
        return { path: row.path, before_sha256: row.before_sha256 };
    });
    return {
        generator: GENERATOR,
        schema_version: JOURNAL_SCHEMA,
        credential_detector_version: obvious_credential_detector_version,
        transaction_id: value.transaction_id,
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        base_manifest_checksum: value.base_manifest_checksum,
        base_manifest,
        next_manifest_checksum: value.next_manifest_checksum,
        next_manifest,
        writes,
        removals,
    };
}

function journal_bytes(journal: projection_journal): string {
    return `${stable_json(journal, 2)}\n`;
}

function load_journal(
    state_root: string,
    journal_path: string,
    scope_fingerprint: string,
    vault_root_fingerprint: string,
    projection_root: string,
    proposal_inbox: string,
): { journal: projection_journal; checksum: string } | null {
    const loaded = load_state_file(
        state_root, journal_path, MAX_JOURNAL_BYTES, 'projection recovery journal',
    );
    if (!loaded) return null;
    const journal = parse_journal(
        decode_state_json(loaded.bytes, 'projection recovery journal'),
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        proposal_inbox,
    );
    if (journal_bytes(journal) !== loaded.bytes) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal is not canonical');
    }
    return { journal, checksum: loaded.checksum };
}

type journal_result = { written: string[]; removed: string[]; preserved: string[] };

function assert_journal_credentials_safe(journal: projection_journal): void {
    const credential = find_obvious_credentials({
        obsidian_projection_journal_writes: journal.writes.map((operation) => operation.content),
    })[0];
    if (credential) {
        throw new ObsidianProjectionOwnershipError(
            `projection recovery journal contains prohibited credential material at ${credential.path} (${credential.kind})`,
        );
    }
}

function execute_journal(
    vault_root: string,
    state_root: string,
    manifest_path: string,
    journal_path: string,
    journal: projection_journal,
    expected_journal_checksum: string,
    fault_inject?: ObsidianProjectionOptions['fault_inject'],
): journal_result {
    assert_journal_credentials_safe(journal);
    const current_manifest = load_state_file(
        state_root, manifest_path, MAX_STATE_FILE_BYTES, 'projection ownership manifest',
    );
    if (current_manifest?.checksum !== journal.next_manifest_checksum
        && current_manifest?.checksum !== journal.base_manifest_checksum
        && !(current_manifest === null && journal.base_manifest_checksum === null)) {
        throw new ObsidianProjectionOwnershipError('ownership manifest changed during projection recovery');
    }
    ensure_directory(vault_root, journal.next_manifest.proposal_inbox);
    fault_inject?.('after_inbox', journal.next_manifest.proposal_inbox);
    const written: string[] = [];
    for (const operation of journal.writes) {
        const stat = assert_regular_file_or_absent(vault_root, operation.path);
        const actual = stat ? file_checksum(inside_vault(vault_root, operation.path)) : null;
        if (actual === operation.after_sha256) {
            // The prior attempt completed this atomic rename before crashing.
        } else if (actual === operation.before_sha256) {
            atomic_write(vault_root, operation.path, operation.content);
            written.push(operation.path);
        } else {
            throw new ObsidianProjectionOwnershipError(
                `projection target changed during recovery: ${operation.path}`,
            );
        }
        fault_inject?.('after_write', operation.path);
    }
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const operation of journal.removals) {
        const stat = assert_regular_file_or_absent(vault_root, operation.path);
        if (!stat) {
            // The prior attempt already completed the removal.
        } else if (file_checksum(inside_vault(vault_root, operation.path)) === operation.before_sha256) {
            durable_unlink(inside_vault(vault_root, operation.path));
            removed.push(operation.path);
        } else {
            preserved.push(operation.path);
        }
        fault_inject?.('after_remove', operation.path);
    }
    const before_commit = load_state_file(
        state_root, manifest_path, MAX_STATE_FILE_BYTES, 'projection ownership manifest',
    );
    if (before_commit?.checksum !== journal.next_manifest_checksum) {
        if (before_commit?.checksum !== journal.base_manifest_checksum
            && !(before_commit === null && journal.base_manifest_checksum === null)) {
            throw new ObsidianProjectionOwnershipError('ownership manifest changed before transaction commit');
        }
        atomic_write(state_root, manifest_path, manifest_bytes(journal.next_manifest));
    }
    fault_inject?.('after_manifest_commit', manifest_path);
    const committed = load_state_file(
        state_root, manifest_path, MAX_STATE_FILE_BYTES, 'projection ownership manifest',
    );
    if (committed?.checksum !== journal.next_manifest_checksum) {
        throw new ObsidianProjectionOwnershipError('projection ownership manifest commit was not durable');
    }
    const current_journal = load_state_file(
        state_root, journal_path, MAX_JOURNAL_BYTES, 'projection recovery journal',
    );
    if (current_journal?.checksum !== expected_journal_checksum) {
        throw new ObsidianProjectionOwnershipError('projection recovery journal changed during execution');
    }
    durable_unlink(inside_vault(state_root, journal_path));
    return { written, removed, preserved };
}

function assert_regular_file_or_absent(vault_root: string, relative_path: string): ReturnType<typeof lstatSync> | undefined {
    assert_existing_components_are_safe(vault_root, relative_path);
    const stat = lstat_if_present(inside_vault(vault_root, relative_path));
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
        throw new ObsidianProjectionOwnershipError(`projection target is not a regular file: ${relative_path}`);
    }
    return stat;
}

function recheck_file(vault_root: string, relative_path: string, expected_checksum: string | null): void {
    const stat = assert_regular_file_or_absent(vault_root, relative_path);
    const actual = stat ? file_checksum(inside_vault(vault_root, relative_path)) : null;
    if (actual !== expected_checksum) {
        throw new ObsidianProjectionOwnershipError(`projection target changed after preflight: ${relative_path}`);
    }
}

export function project_central_memory_to_obsidian(
    options: ObsidianProjectionOptions,
): ObsidianProjectionReport {
    if (options.vault_root.trim().length === 0) throw new Error('vault_root cannot be empty');
    if (options.tenant_id.length === 0 || options.user_id.length === 0) {
        throw new Error('tenant_id and user_id cannot be empty');
    }
    const projection_root = normalize_relative_path(
        options.projection_root ?? DEFAULT_PROJECTION_ROOT,
        'projection_root',
    );
    const proposal_inbox = `${projection_root}/Proposals/inbox`;
    const requested_vault_root = path.resolve(options.vault_root);
    const requested_state_root = path.resolve(
        options.state_root ?? `${requested_vault_root}.${DEFAULT_STATE_DIRECTORY}`,
    );
    assert_roots_are_separate(requested_vault_root, requested_state_root);
    assert_root_is_safe(requested_vault_root, 'vault_root');
    assert_root_is_safe(requested_state_root, 'state_root');
    if (!lstat_if_present(requested_vault_root)) mkdirSync(requested_vault_root, { recursive: true });
    if (!lstat_if_present(requested_state_root)) mkdirSync(requested_state_root, { recursive: true, mode: 0o700 });
    assert_root_is_safe(requested_vault_root, 'vault_root');
    assert_root_is_safe(requested_state_root, 'state_root');
    const vault_root = realpathSync.native(requested_vault_root);
    const state_root = realpathSync.native(requested_state_root);
    assert_roots_are_separate(vault_root, state_root);
    const vault_root_fingerprint = sha256(
        process.platform === 'win32' ? vault_root.toLocaleLowerCase('en-US') : vault_root,
    );
    const scope_fingerprint = sha256(stable_json({
        projection_root,
        tenant_id: options.tenant_id,
        user_id: options.user_id,
        vault_root_fingerprint,
    }));
    const manifest_path = `${OWNERSHIP_STATE_DIRECTORY}/${scope_fingerprint}.manifest.json`;
    const journal_path = `${TRANSACTION_STATE_DIRECTORY}/${scope_fingerprint}.journal.json`;

    const recovered: journal_result = { written: [], removed: [], preserved: [] };
    const pending = load_journal(
        state_root,
        journal_path,
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        proposal_inbox,
    );
    if (pending) {
        const result = execute_journal(
            vault_root,
            state_root,
            manifest_path,
            journal_path,
            pending.journal,
            pending.checksum,
            options.fault_inject,
        );
        recovered.written.push(...result.written);
        recovered.removed.push(...result.removed);
        recovered.preserved.push(...result.preserved);
    }
    const loaded = load_manifest(
        state_root,
        manifest_path,
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        proposal_inbox,
    );
    const snapshot = read_snapshot(options.database, options.tenant_id, options.user_id);
    const normalized = normalized_snapshot(snapshot);
    const credential = find_obvious_credentials({ obsidian_projection_snapshot: normalized })[0];
    if (credential) {
        throw new ObsidianProjectionOwnershipError(
            `central-memory projection contains prohibited credential material at ${credential.path} (${credential.kind})`,
        );
    }
    const source_fingerprint = sha256(stable_json(normalized));
    const desired = build_projection(snapshot, projection_root);
    if (desired.length > MAX_MANAGED_FILES
        || desired.some((file) => Buffer.byteLength(file.content) > MAX_GENERATED_FILE_BYTES)) {
        throw new ObsidianProjectionOwnershipError('generated projection exceeds its file or size limit');
    }
    const prior_by_path = new Map((loaded.manifest?.managed_files ?? []).map((entry) => [entry.path, entry]));

    const writes: Array<{ file: desired_file; expected_checksum: string | null }> = [];
    const unchanged: string[] = [];
    for (const file of desired) {
        const stat = assert_regular_file_or_absent(vault_root, file.path);
        const prior = prior_by_path.get(file.path);
        if (!stat) {
            writes.push({ file, expected_checksum: null });
            continue;
        }
        const actual_checksum = file_checksum(inside_vault(vault_root, file.path));
        if (!prior) {
            throw new ObsidianProjectionOwnershipError(
                `refusing to overwrite an unknown file at a generated target: ${file.path}. `
                + `Move user content to ${proposal_inbox}/.`,
            );
        }
        if (actual_checksum === file.sha256) {
            unchanged.push(file.path);
        } else if (actual_checksum === prior.sha256) {
            writes.push({ file, expected_checksum: actual_checksum });
        } else {
            throw new ObsidianProjectionOwnershipError(
                `managed file was modified outside LongMemory: ${file.path}. `
                + `Move the intended change to ${proposal_inbox}/ before projecting again.`,
            );
        }
    }

    const desired_paths = new Set(desired.map((file) => file.path));
    const removals: Array<{ path: string; expected_checksum: string }> = [];
    const preserved: string[] = [];
    for (const prior of loaded.manifest?.managed_files ?? []) {
        if (desired_paths.has(prior.path)) continue;
        assert_existing_components_are_safe(vault_root, prior.path);
        const stat = lstat_if_present(inside_vault(vault_root, prior.path));
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) {
            preserved.push(prior.path);
            continue;
        }
        const actual_checksum = file_checksum(inside_vault(vault_root, prior.path));
        if (actual_checksum === prior.sha256) removals.push({ path: prior.path, expected_checksum: actual_checksum });
        else preserved.push(prior.path);
    }

    assert_existing_components_are_safe(vault_root, proposal_inbox);
    const inbox_stat = lstat_if_present(inside_vault(vault_root, proposal_inbox));
    if (inbox_stat && (!inbox_stat.isDirectory() || inbox_stat.isSymbolicLink())) {
        throw new ObsidianProjectionOwnershipError(`proposal inbox is not a safe directory: ${proposal_inbox}`);
    }

    const manifest: projection_manifest = {
        generator: GENERATOR,
        schema_version: MANIFEST_SCHEMA,
        scope_fingerprint,
        vault_root_fingerprint,
        projection_root,
        source_fingerprint,
        proposal_inbox,
        managed_files: desired.map(({ path: file_path, sha256: checksum, kind, record_id }) => ({
            path: file_path,
            sha256: checksum,
            kind,
            record_id,
        })),
    };
    const next_manifest_bytes = manifest_bytes(manifest);
    const next_manifest_checksum = sha256(next_manifest_bytes);
    let applied: journal_result = { written: [], removed: [], preserved: [] };
    if (loaded.bytes !== next_manifest_bytes || writes.length > 0 || removals.length > 0) {
        const journal_seed = {
            scope_fingerprint,
            vault_root_fingerprint,
            projection_root,
            credential_detector_version: obvious_credential_detector_version,
            base_manifest_checksum: loaded.checksum,
            next_manifest_checksum,
            writes: writes.map((operation) => ({
                path: operation.file.path,
                before_sha256: operation.expected_checksum,
                after_sha256: operation.file.sha256,
            })),
            removals,
        };
        const journal: projection_journal = {
            generator: GENERATOR,
            schema_version: JOURNAL_SCHEMA,
            credential_detector_version: obvious_credential_detector_version,
            transaction_id: sha256(stable_json(journal_seed)),
            scope_fingerprint,
            vault_root_fingerprint,
            projection_root,
            base_manifest_checksum: loaded.checksum,
            base_manifest: loaded.manifest,
            next_manifest_checksum,
            next_manifest: manifest,
            writes: writes.map((operation) => ({
                path: operation.file.path,
                before_sha256: operation.expected_checksum,
                after_sha256: operation.file.sha256,
                content: operation.file.content,
            })),
            removals: removals.map((operation) => ({
                path: operation.path,
                before_sha256: operation.expected_checksum,
            })),
        };
        assert_journal_credentials_safe(journal);
        const prepared_bytes = journal_bytes(journal);
        if (Buffer.byteLength(prepared_bytes) > MAX_JOURNAL_BYTES) {
            throw new ObsidianProjectionOwnershipError('projection recovery journal exceeds its size limit');
        }
        if (load_state_file(state_root, journal_path, MAX_JOURNAL_BYTES, 'projection recovery journal')) {
            throw new ObsidianProjectionOwnershipError('a projection recovery journal is already pending');
        }
        atomic_write(state_root, journal_path, prepared_bytes);
        options.fault_inject?.('after_prepare', journal_path);
        applied = execute_journal(
            vault_root,
            state_root,
            manifest_path,
            journal_path,
            journal,
            sha256(prepared_bytes),
            options.fault_inject,
        );
    } else {
        ensure_directory(vault_root, proposal_inbox);
    }

    const written_set = new Set([...recovered.written, ...applied.written]);

    return {
        written: [...written_set].sort(),
        unchanged: unchanged.filter((file_path) => !written_set.has(file_path)),
        removed: [...new Set([...recovered.removed, ...applied.removed])].sort(),
        preserved: [...new Set([...preserved, ...recovered.preserved, ...applied.preserved])].sort(),
        manifest_path: inside_vault(state_root, manifest_path),
        state_root,
        source_fingerprint,
    };
}
