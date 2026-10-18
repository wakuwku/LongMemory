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
 *  file  : tools/check-integrations.mjs
 *  usage : validates LongMemory integration manifests and build outputs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function required(path) {
    if (!existsSync(resolve(root, path))) failures.push(`required integration file is missing: ${path}`);
}

function parse(path) {
    try {
        return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    } catch (error) {
        failures.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

for (const path of [
    'integrations/README.md',
    'integrations/codex-longmemory/LICENSE',
    'integrations/codex-longmemory/README.md',
    'integrations/codex-longmemory/.codex-plugin/plugin.json',
    'integrations/codex-longmemory/.mcp.json',
    'integrations/codex-longmemory/hooks/hooks.json',
    'integrations/codex-longmemory/scripts/document-memory-startup.mjs',
    'integrations/codex-longmemory/scripts/codex-memory-hook.mjs',
    'integrations/codex-longmemory/scripts/codex-memory-mcp.mjs',
    'integrations/codex-longmemory/scripts/plugin-runtime.mjs',
    'integrations/codex-longmemory/skills/longmemory/SKILL.md',
    'integrations/n8n-nodes-longmemory/LICENSE',
    'integrations/n8n-nodes-longmemory/README.md',
    'integrations/n8n-nodes-longmemory/package.json',
]) required(path);

const plugin_root = resolve(root, 'integrations/codex-longmemory');
const plugin = parse('integrations/codex-longmemory/.codex-plugin/plugin.json');
if (plugin) {
    if (plugin.name !== 'longmemory') failures.push('Codex plugin name must be longmemory');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(plugin.version ?? ''))) {
        failures.push('Codex plugin version must be valid semantic versioning');
    }
    for (const key of ['skills', 'mcpServers']) {
        const value = plugin[key];
        if (typeof value !== 'string' || !value.startsWith('./') || !existsSync(resolve(plugin_root, value))) {
            failures.push(`Codex plugin ${key} path is missing or invalid`);
        }
    }
}

const mcp = parse('integrations/codex-longmemory/.mcp.json');
const server = mcp?.mcpServers?.longmemory;
if (!server || server.command !== 'node' || !Array.isArray(server.args) || server.args.length !== 1) {
    failures.push('Codex plugin MCP configuration must declare one local Node launcher');
} else {
    const launcher = resolve(plugin_root, String(server.args[0]));
    if (!launcher.startsWith(plugin_root) || !existsSync(launcher)) failures.push('Codex plugin MCP launcher is outside or missing from the plugin');
}

const hooks = parse('integrations/codex-longmemory/hooks/hooks.json');
if (JSON.stringify(Object.keys(hooks?.hooks ?? {})) !== JSON.stringify(['SessionStart'])) {
    failures.push('Codex plugin must register only the optional SessionStart invitation');
}
const startup = hooks?.hooks?.SessionStart;
if (!Array.isArray(startup) || startup.length !== 1 || startup[0]?.matcher !== 'startup'
    || !Array.isArray(startup[0]?.hooks) || startup[0].hooks.length !== 1) {
    failures.push('Codex plugin must register exactly one startup-only command');
} else {
    const command = startup[0].hooks[0];
    if (command.type !== 'command' || !command.command?.includes('document-memory-startup.mjs')
        || !command.commandWindows?.includes('document-memory-startup.mjs')) {
        failures.push('Codex startup hook must use the document-memory invitation launcher');
    }
}
if (existsSync(resolve(plugin_root, 'hooks.json')) || plugin?.hooks !== undefined) {
    failures.push('Codex plugin must use the single hooks/hooks.json entry, without a duplicate legacy registration');
}

const marketplace = parse('.agents/plugins/marketplace.json');
const entry = marketplace?.plugins?.find?.((candidate) => candidate?.name === 'longmemory');
if (!entry || entry.policy?.installation !== 'AVAILABLE' || entry.policy?.authentication !== 'ON_INSTALL') {
    failures.push('repository marketplace must expose longmemory with explicit installation and authentication policy');
} else if (resolve(root, entry.source?.path ?? '') !== plugin_root) {
    failures.push('repository marketplace longmemory source does not target the bundled Codex plugin');
}

const n8n = parse('integrations/n8n-nodes-longmemory/package.json');
if (n8n) {
    if (n8n.license !== 'MIT') failures.push('n8n community package must retain its required MIT license');
    for (const relative of [...(n8n.n8n?.credentials ?? []), ...(n8n.n8n?.nodes ?? [])]) {
        required(`integrations/n8n-nodes-longmemory/${relative}`);
        const source = relative.replace(/^dist\//, '').replace(/\.js$/, '.ts');
        required(`integrations/n8n-nodes-longmemory/${source}`);
    }
}

if (failures.length > 0) {
    console.error(`Integration validation failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log('LongMemory integration manifests and build outputs are consistent.');
}
