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
 *  file  : tools/check-release-files.mjs
 *  usage : rejects private artifacts and incomplete LongMemory release trees
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function repository_files(tracked_only = false) {
    const args = tracked_only
        ? ['ls-files', '-z']
        : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
        .split('\0').filter(Boolean).sort();
}

function parse_json(path) {
    try {
        return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    } catch (error) {
        failures.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

const required = [
    'README.md', 'LICENSE', 'NOTICE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tools/branding.mjs', 'tools/check-integrations.mjs', 'tools/check-release-files.mjs',
    '.agents/plugins/marketplace.json',
    'integrations/codex-longmemory/.codex-plugin/plugin.json',
    'integrations/codex-longmemory/.mcp.json',
    'integrations/codex-longmemory/hooks/hooks.json',
    'integrations/codex-longmemory/scripts/codex-memory-hook.mjs',
    'integrations/codex-longmemory/scripts/codex-memory-mcp.mjs',
    'integrations/codex-longmemory/skills/longmemory/SKILL.md',
];
for (const path of required) if (!existsSync(resolve(root, path))) failures.push(`required release file is missing: ${path}`);

const files = repository_files();
const tracked = repository_files(true);
const forbidden_prefixes = ['artifacts/', 'KnowledgeVault/', '.longmemory/'];
const forbidden_extensions = new Set(['.db', '.sqlite', '.sqlite3', '.tgz', '.vsix']);
for (const path of tracked) {
    if (forbidden_prefixes.some((prefix) => path.startsWith(prefix))) {
        failures.push(`private or generated path is tracked: ${path}`);
    }
    const lower = path.toLowerCase();
    if (forbidden_extensions.has(extname(lower)) || /\.(db|sqlite|sqlite3)-(wal|shm|journal)$/.test(lower)) {
        failures.push(`database or package artifact is tracked: ${path}`);
    }
    if (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith('.example')) {
        failures.push(`environment file is tracked: ${path}`);
    }
}

const binary_extensions = new Set(['.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.svg', '.webp']);
const private_patterns = [
    ['local user profile', /C:\\Users\\Administrator|C:\/Users\/Administrator/i],
    ['local workspace path', /D:\\codex_project|D:\/codex_project|D:\\小说|D:\/小说/i],
    ['private Codex task URL', /codex:\/\/threads\/[0-9a-f-]{36}/i],
];
const credential_patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const path of files) {
    const absolute = resolve(root, path);
    if (binary_extensions.has(extname(path).toLowerCase()) || statSync(absolute).size > 5_000_000) continue;
    const content = readFileSync(absolute, 'utf8');
    for (const [label, pattern] of private_patterns) {
        if (pattern.test(content)) failures.push(`${path} contains a ${label}`);
    }
    if (!/\.test\.[^.]+$/i.test(path) && credential_patterns.some((pattern) => pattern.test(content))) {
        failures.push(`${path} contains a high-confidence credential pattern`);
    }
}

const package_json = parse_json('package.json');
if (package_json) {
    if (package_json.private === true) failures.push('root package must not be private for release');
    if (package_json.license !== 'Apache-2.0') failures.push('root package license must remain Apache-2.0');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(package_json.version ?? ''))) {
        failures.push('root package version must be valid semantic versioning');
    }
    for (const path of package_json.files ?? []) {
        if (path === 'dist') continue;
        if (!existsSync(resolve(root, path))) failures.push(`package.json files entry is missing: ${path}`);
    }
}

const marketplace = parse_json('.agents/plugins/marketplace.json');
if (marketplace) {
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length < 1) {
        failures.push('repository marketplace must declare at least one plugin');
    } else {
        for (const entry of marketplace.plugins) {
            const source = entry?.source?.path;
            if (entry?.source?.source !== 'local' || typeof source !== 'string' || !source.startsWith('./')) {
                failures.push(`marketplace plugin ${String(entry?.name)} must use a repository-local source`);
                continue;
            }
            const plugin_root = resolve(root, source);
            const manifest_path = resolve(plugin_root, '.codex-plugin', 'plugin.json');
            if (!existsSync(manifest_path)) failures.push(`marketplace plugin source has no manifest: ${source}`);
            else {
                const manifest = JSON.parse(readFileSync(manifest_path, 'utf8'));
                if (manifest.name !== entry.name) failures.push(`marketplace and plugin names differ for ${String(entry.name)}`);
            }
        }
    }
}

try {
    execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'pipe' });
} catch (error) {
    failures.push(`git diff --check failed: ${error instanceof Error ? String(error.stderr ?? error.message).trim() : String(error)}`);
}

if (failures.length > 0) {
    console.error(`Release file validation failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`Release file validation passed for ${files.length} public files.`);
}
