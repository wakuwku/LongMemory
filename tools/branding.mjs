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
 *  file  : tools/branding.mjs
 *  usage : validates and applies LongMemory source headers
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apply = process.argv.slice(2).includes('--apply');
const logo = [
    '     __                      __  ___',
    '    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __',
    '   / /   / __ \\/ __ \\/ __ `/ /|_/ / _ \\/ __ `__ \\/ __ \\/ ___/ / / /',
    '  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /',
    ' /_____/\\____/_/ /_/\\__, /_/  /_/\\___/_/ /_/ /_/\\____/_/   \\__, /',
    '                    /____/                                 /_____/',
];

function repository_files() {
    const output = execFileSync('git', [
        'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], { cwd: root, encoding: 'utf8' });
    return output.split('\0').filter(Boolean).sort();
}

const block_extensions = new Set(['.c', '.cc', '.cpp', '.css', '.h', '.hpp', '.js', '.jsx', '.mjs', '.cjs', '.scss', '.ts', '.tsx']);
const hash_extensions = new Set(['.ps1', '.py', '.sh', '.toml', '.yaml', '.yml']);
const hash_names = new Set([
    '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.gitignore',
    '.prettierignore', 'Dockerfile', 'Makefile',
]);

function style_for(path) {
    const extension = extname(path).toLowerCase();
    if (block_extensions.has(extension)) return 'block';
    if (hash_extensions.has(extension) || hash_names.has(basename(path))) return 'hash';
    if (extension === '.md' || extension === '.html') return 'html';
    return null;
}

function usage_for(path) {
    const leaf = basename(path).replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').trim();
    if (/\.test\.[^.]+$/i.test(path)) return `tests the LongMemory ${leaf.replace(/ test$/i, '')} component`;
    if (path.startsWith('docs/')) return `documents LongMemory ${leaf}`;
    if (path.startsWith('.github/workflows/')) return `automates the LongMemory ${leaf} workflow`;
    if (path.startsWith('integrations/')) return `supports the LongMemory ${leaf} integration`;
    if (path.startsWith('tools/')) return `supports LongMemory ${leaf}`;
    return `implements the LongMemory ${leaf} component`;
}

function render_header(path, style) {
    const usage = usage_for(path);
    if (style === 'block') {
        return [
            '/*',
            ...logo.map((line, index) => index === 5 ? line : `* ${line}`),
            ' *',
            ' *  cavira oss (c) 2026  -  nullure (c) 2026',
            ' *  ----------------------------------------------------------',
            ` *  file  : ${path}`,
            ` *  usage : ${usage}`,
            ' */',
            '',
        ].join('\n');
    }
    if (style === 'html') {
        return [
            '<!--',
            ...logo,
            '',
            ' cavira oss (c) 2026  -  nullure (c) 2026',
            ' ==========================================================',
            ` file  : ${path}`,
            ` usage : ${usage}`,
            '-->',
            '',
        ].join('\n');
    }
    return [
        ...logo.map((line) => `# ${line}`),
        '#',
        '#  cavira oss (c) 2026  -  nullure (c) 2026',
        '#  ----------------------------------------------------------',
        `#  file  : ${path}`,
        `#  usage : ${usage}`,
        '',
    ].join('\n');
}

function insert_header(path, content, style) {
    const header = render_header(path, style);
    if (style !== 'hash') return `${header}\n${content}`;
    const lines = content.split(/\r?\n/);
    if (lines[0]?.startsWith('#!') || lines[0]?.startsWith('# syntax=')) {
        return `${lines[0]}\n${header}\n${lines.slice(1).join('\n')}`;
    }
    return `${header}\n${content}`;
}

function strip_leading_headers(content, style) {
    let prefix = '';
    let body = content;
    if (style === 'hash') {
        const first_newline = body.indexOf('\n');
        const first_line = first_newline >= 0 ? body.slice(0, first_newline) : body;
        if (first_line.startsWith('#!') || first_line.startsWith('# syntax=')) {
            prefix = `${first_line}\n`;
            body = first_newline >= 0 ? body.slice(first_newline + 1) : '';
        }
    }
    const pattern = style === 'block'
        ? /^\/\*[\s\S]*?\*\/\r?\n*/
        : style === 'html'
            ? /^<!--[\s\S]*?-->\r?\n*/
            : /^(?:#[^\r\n]*(?:\r?\n|$))+\r?\n*/;
    for (;;) {
        const match = body.match(pattern);
        if (!match || !match[0].includes('cavira oss (c) 2026')) break;
        body = body.slice(match[0].length);
    }
    return `${prefix}${body}`;
}

const missing = [];
for (const path of repository_files()) {
    const style = style_for(path);
    if (!style || path === 'pnpm-lock.yaml'
        || path === 'integrations/n8n-nodes-longmemory/eslint.config.mjs'
        || path === 'dashboard/next-env.d.ts') continue;
    const absolute = resolve(root, path);
    const content = readFileSync(absolute, 'utf8');
    const prefix = content.slice(0, 2_048);
    const header_count = prefix.match(/cavira oss \(c\) 2026/g)?.length ?? 0;
    if (header_count === 1 && prefix.includes(`file  : ${path}`)) continue;
    missing.push(path);
    if (apply) writeFileSync(absolute, insert_header(path, strip_leading_headers(content, style), style), 'utf8');
}

if (missing.length > 0 && !apply) {
    console.error(`Branding header missing or stale in ${missing.length} file(s):`);
    for (const path of missing) console.error(`- ${path}`);
    process.exitCode = 1;
} else if (apply) {
    console.log(`Applied LongMemory headers to ${missing.length} file(s).`);
} else {
    console.log('LongMemory branding headers are current.');
}
