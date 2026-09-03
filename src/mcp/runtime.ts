/*
*      __                      __  ___
*     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
*    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
*   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
*  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                     /____/                                 /____/
 *
 *  cavira oss (c) 2026  -  nullure (c) 2026
 *  ----------------------------------------------------------
 *  file  : src/mcp/runtime.ts
 *  usage : implements the LongMemory runtime component
 */


import { basename, resolve } from 'node:path';
import { create_memory, type long_memory } from '../core/create_memory.js';
import type { ConnectorRegistry } from '../core/connectors/connector_registry.js';
import { project_memory } from '../core/project/project_memory.js';
import { mcp_audit_log } from './security/audit.js';
import { create_embedding_environment } from '../core/embeddings/environment.js';
import {
    central_thread_scoped_tool_names,
    create_tool_allowlist,
    default_mcp_tool_names,
    mcp_profile_tools,
    parse_mcp_profile,
    type mcp_profile,
    type mcp_tool_name,
} from './security/tool_allowlist.js';
import type { mcp_access } from './security/permissions.js';

export type mcp_runtime_config = {
    memory?: long_memory;
    db_path?: string;
    tenant_id?: string;
    user_id?: string;
    project_id?: string | null;
    team_ids?: readonly string[];
    roles?: readonly string[];
    agent_id?: string | null;
    central_thread_id?: string | null;
    framework?: string | null;
    cwd?: string;
    read_only?: boolean;
    allowed_tools?: readonly mcp_tool_name[];
    profile?: mcp_profile;
    audit?: mcp_audit_log;
    audit_path?: string | null;
    connector_registry?: ConnectorRegistry;
    env?: NodeJS.ProcessEnv;
};

const current_project = (cwd: string) => basename(resolve(cwd)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'current';

export class mcp_runtime {
    readonly memory: long_memory;
    readonly access: mcp_access;
    readonly audit: mcp_audit_log;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly profile: mcp_profile;
    private readonly owns_memory: boolean;
    private readonly tenant_id: string;
    private readonly connector_registry?: ConnectorRegistry;
    private readonly projects = new Map<string, project_memory>();

    constructor(config: mcp_runtime_config = {}) {
        this.cwd = resolve(config.cwd ?? process.cwd());
        this.env = config.env ?? process.env;
        this.tenant_id = config.tenant_id ?? 'default';
        this.connector_registry = config.connector_registry;
        const embeddings = create_embedding_environment(this.env);
        const project_id = config.project_id === 'current' ? current_project(this.cwd) : config.project_id ?? null;
        const roles = config.roles ?? [];
        const central_thread_id = config.central_thread_id ?? null;
        const profile = parse_mcp_profile(config.profile);
        const restricted_profile_tools = mcp_profile_tools(profile);
        const role_default_tools: readonly mcp_tool_name[] = roles.includes('central_memory_approver')
            ? [
                ...default_mcp_tool_names,
                'longmemory_central_confirmation',
                'longmemory_history_governance',
                ...(roles.includes('central_memory_admin')
                    ? ['longmemory_central_project_link' as const]
                    : []),
            ]
            : default_mcp_tool_names;
        if (restricted_profile_tools && config.allowed_tools) {
            const profile_set = new Set<mcp_tool_name>(restricted_profile_tools);
            const broadened = config.allowed_tools.find((name) => !profile_set.has(name));
            if (broadened) {
                throw new Error(`MCP profile ${profile} cannot allow tool ${broadened}`);
            }
        }
        const allowed_tools = restricted_profile_tools
            ? config.allowed_tools ?? restricted_profile_tools
            : config.allowed_tools ?? (central_thread_id || roles.includes('central_memory_cross_thread')
                ? role_default_tools
                : role_default_tools.filter((name) =>
                    !(central_thread_scoped_tool_names as readonly string[]).includes(name)));
        this.memory = config.memory ?? create_memory({
            store: config.db_path ? 'sqlite' : 'memory',
            db_path: config.db_path,
            tenant_id: this.tenant_id,
            user_id: config.user_id ?? 'default',
            readonly: config.read_only ?? false,
            ...(embeddings ? { embedding_provider: embeddings.embedding_provider, multilingual_embedding_provider: embeddings.multilingual_embedding_provider, embedding_dimension: embeddings.embedding_dimension } : {}),
        });
        this.owns_memory = !config.memory;
        this.profile = profile;
        this.access = {
            user_id: config.user_id ?? 'default',
            project_id,
            team_ids: config.team_ids ?? [],
            roles,
            agent_id: config.agent_id ?? null,
            central_thread_id,
            framework: config.framework ?? null,
            read_only: config.read_only ?? false,
            allowed_tools: create_tool_allowlist(allowed_tools),
        };
        const default_audit_path = config.db_path && config.db_path !== ':memory:'
            ? `${config.db_path}.mcp-audit.jsonl`
            : null;
        this.audit = config.audit ?? new mcp_audit_log(
            config.audit_path === undefined ? default_audit_path : config.audit_path,
        );
    }

    async project(project_id?: string | null): Promise<project_memory> {
        const id = this.resolve_project_id(project_id);
        const cached = this.projects.get(id);
        if (cached) return cached;
        const worlds = await this.memory.listWorlds();
        const root = worlds.find((world) => world.metadata.hierarchy === 'project' && world.metadata.project_id === id);
        if (this.access.read_only && !root) {
            throw new Error(`MCP server is read-only; unknown project cannot be created: ${id}`);
        }
        const name = root?.name ?? id;
        const description = String(root?.metadata.description ?? `LongMemory project ${id}`);
        const manager = new project_memory({
            memory: this.memory,
            tenant_id: this.tenant_id,
            project_id: id,
            name,
            description,
            connector_registry: this.connector_registry,
            readonly: this.access.read_only,
        });
        await manager.createProject({ tenant_id: this.tenant_id, project_id: id, name, description });
        this.projects.set(id, manager);
        return manager;
    }

    resolve_project_id(project_id?: string | null): string {
        return project_id ?? this.access.project_id ?? current_project(this.cwd);
    }

    async list_projects(): Promise<Array<Record<string, unknown>>> {
        const worlds = await this.memory.listWorlds();
        const allowed = this.access.project_id;
        const roots = worlds.filter((world) => world.metadata.hierarchy === 'project' && (!allowed || world.metadata.project_id === allowed));
        return roots.map((world) => ({
            tenant_id: String(world.metadata.tenant_id ?? this.tenant_id),
            organization_id: String(world.metadata.organization_id ?? this.tenant_id),
            project_id: String(world.metadata.project_id),
            name: world.name,
            description: String(world.metadata.description ?? ''),
            root_world_id: world.id,
            world_ids: Object.fromEntries(worlds.filter((child) => child.parent_world_id === world.id).map((child) => [String(child.metadata.hierarchy), child.id])),
            created_at: world.created_at,
            updated_at: world.updated_at,
        }));
    }

    async close(): Promise<void> {
        for (const manager of this.projects.values()) await manager.close();
        if (this.owns_memory) await this.memory.close();
    }
}
