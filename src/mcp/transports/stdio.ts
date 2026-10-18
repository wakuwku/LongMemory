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
 *  file  : src/mcp/transports/stdio.ts
 *  usage : implements the LongMemory stdio component
 */


import { StdioServerTransport as stdio_server_transport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { create_longmemory_mcp, type mcp_server_config } from '../mcp_server.js';

// SDK stdio does not close on EOF or watch stdout errors. Preserve its protocol
// callbacks while making lost clients release the runtime (and its SQLite handle).
class lifecycle_stdio_transport extends stdio_server_transport {
    readonly closed: Promise<void>;
    private finish_closed!: () => void;
    private closing?: Promise<void>;
    private readonly pending_sends = new Set<(error: Error) => void>();
    private readonly on_input_closed = () => { void this.close(); };
    private readonly on_input_error = () => { void this.close(); };
    private readonly on_output_error = (error: Error) => {
        this.onerror?.(error);
        void this.close();
    };

    constructor(private readonly input: Readable, private readonly output: Writable) {
        super(input, output);
        this.closed = new Promise((resolve) => { this.finish_closed = resolve; });
    }

    override async start(): Promise<void> {
        if (this.closing) throw new Error('Stdio transport is closed');
        this.input.once('end', this.on_input_closed);
        this.input.once('close', this.on_input_closed);
        this.input.on('error', this.on_input_error);
        this.output.once('finish', this.on_input_closed);
        this.output.once('close', this.on_input_closed);
        this.output.on('error', this.on_output_error);
        await super.start();
        if (this.input.readableEnded || this.input.destroyed
            || this.output.writableEnded || this.output.destroyed) await this.close();
    }

    override close(): Promise<void> {
        if (!this.closing) {
            // Assign the promise before SDK onclose can re-enter close().
            this.closing = Promise.resolve().then(async () => {
                this.input.off('end', this.on_input_closed);
                this.input.off('close', this.on_input_closed);
                this.input.off('error', this.on_input_error);
                this.output.off('finish', this.on_input_closed);
                this.output.off('close', this.on_input_closed);
                this.output.off('error', this.on_output_error);
                for (const reject of this.pending_sends) reject(new Error('Stdio transport is closed'));
                this.pending_sends.clear();
                try { await super.close(); } finally { this.finish_closed(); }
            });
        }
        return this.closing;
    }

    override send(message: JSONRPCMessage): Promise<void> {
        if (this.closing) return Promise.reject(new Error('Stdio transport is closed'));
        return new Promise((resolve, reject) => {
            const fail = (error: Error) => { this.pending_sends.delete(fail); reject(error); };
            this.pending_sends.add(fail);
            try {
                // The write callback settles on flush/error, unlike waiting only
                // for drain, which can hang forever after an output pipe breaks.
                this.output.write(serializeMessage(message), (error?: Error | null) => {
                    this.pending_sends.delete(fail);
                    if (error) { reject(error); void this.close(); } else resolve();
                });
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
                void this.close();
            }
        });
    }
}

export type stdio_mcp = ReturnType<typeof create_longmemory_mcp> & {
    transport: stdio_server_transport;
    closed: Promise<void>;
    start(): Promise<void>;
    close(): Promise<void>;
};

export function create_stdio_mcp(
    config: mcp_server_config = {},
    input: Readable = process.stdin,
    output: Writable = process.stdout,
): stdio_mcp {
    const mcp = create_longmemory_mcp(config);
    const transport = new lifecycle_stdio_transport(input, output);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= Promise.resolve().then(async () => {
            try { await mcp.server.close(); } finally {
                try { await transport.close(); } finally {
                    if (!config.runtime) await mcp.runtime.close();
                }
            }
        });
        return closing;
    };
    const closed = transport.closed.then(close);
    // EOF can arrive before a caller awaits closed; still expose its failure to
    // callers without producing an unhandled rejection during construction.
    void closed.catch(() => {});
    return {
        ...mcp,
        transport,
        closed,
        start: async () => {
            try { await mcp.server.connect(transport); } catch (error) {
                await close();
                throw error;
            }
        },
        close,
    };
}

export async function run_mcp_stdio(config: mcp_server_config = {}): Promise<void> {
    const mcp = create_stdio_mcp(config);
    const stop = () => { void mcp.close().catch(() => {}); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        await mcp.start();
        await mcp.closed;
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await mcp.close();
    }
}
