import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

import process from 'node:process';

import { resolveBackendEnvironment } from './config.js';
import { parseToolName } from './heuristics.js';
import {
    isObject,
    type BackendConfig,
    type BackendStatus,
    type CatalogEntry,
    type JsonObject,
    type OperatorConfig,
} from './types.js';

export class ManagedBackend {
    private catalog: CatalogEntry[] = [];
    private client: Client | null = null;
    private lastConnectedAt: string | undefined;
    private lastError: string | undefined;
    private stderrLines: string[] = [];
    private transport: StdioClientTransport | null = null;

    constructor(private readonly config: BackendConfig) { }

    async callTool(
        toolName: string,
        argumentsObject: JsonObject = {},
    ): Promise<CallToolResult> {
        await this.ensureConnected();
        const client = this.client;

        if (!client) {
            throw new Error(`Backend ${this.config.id} is not connected.`);
        }

        const result = await client.callTool({
            arguments: argumentsObject,
            name: toolName,
        });

        if (result.isError) {
            this.lastError = `Tool ${toolName} returned an Appwrite error.`;
        }

        return result;
    }

    async close(): Promise<void> {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.transport = null;
        }
    }

    async ensureConnected(): Promise<void> {
        if (this.client && this.transport) {
            return;
        }

        const client = new Client({
            name: 'appwrite-operator',
            version: '0.1.0',
        });
        const transportOptions: ConstructorParameters<typeof StdioClientTransport>[0] = {
            command: this.config.command,
            env: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
                ...resolveBackendEnvironment(this.config),
            },
            stderr: 'pipe',
        };
        if (this.config.args) {
            transportOptions.args = this.config.args;
        }
        if (this.config.cwd) {
            transportOptions.cwd = this.config.cwd;
        }

        const transport = new StdioClientTransport(transportOptions);

        if (transport.stderr) {
            transport.stderr.on('data', (chunk: Buffer | string) => {
                const text = chunk.toString();
                for (const line of text.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }

                    this.stderrLines.push(trimmed);
                    if (this.stderrLines.length > 100) {
                        this.stderrLines.shift();
                    }
                }
            });
        }

        client.onerror = (error) => {
            this.lastError = error.message;
        };

        client.onclose = () => {
            this.client = null;
            this.transport = null;
        };

        try {
            await withTimeout(
                (async () => {
                    await client.connect(transport);
                    const tools = await listAllTools(client);
                    this.catalog = tools.map((tool) => toCatalogEntry(tool, this.config));
                })(),
                30_000,
                `Backend ${this.config.id} connection timed out after 30s.`,
            );
            this.client = client;
            this.transport = transport;
            this.lastConnectedAt = new Date().toISOString();
            this.lastError = undefined;
        } catch (error) {
            this.lastError = toErrorMessage(error, this.stderrLines);
            await transport.close();
            throw new Error(
                `Failed to connect backend ${this.config.id}: ${this.lastError}`,
            );
        }
    }

    getCatalog(): CatalogEntry[] {
        return this.catalog;
    }

    getId(): string {
        return this.config.id;
    }

    getLabel(): string {
        return this.config.label ?? this.config.id;
    }

    getStatus(): BackendStatus {
        const services = [...new Set(this.catalog.map((entry) => entry.serviceName))].sort();
        const status: BackendStatus = {
            connected: this.client !== null,
            id: this.config.id,
            label: this.getLabel(),
            services,
            toolCount: this.catalog.length,
        };

        if (this.lastConnectedAt) {
            status.lastConnectedAt = this.lastConnectedAt;
        }
        if (this.lastError) {
            status.lastError = this.lastError;
        }

        return status;
    }

    async refreshCatalog(): Promise<CatalogEntry[]> {
        await this.ensureConnected();
        const client = this.client;

        if (!client) {
            throw new Error(`Backend ${this.config.id} is not connected.`);
        }

        const tools = await listAllTools(client);
        this.catalog = tools.map((tool) => toCatalogEntry(tool, this.config));
        return this.catalog;
    }
}

export class BackendRegistry {
    private readonly backends = new Map<string, ManagedBackend>();

    constructor(config: OperatorConfig) {
        for (const backendConfig of config.backends) {
            this.backends.set(backendConfig.id, new ManagedBackend(backendConfig));
        }
    }

    async callTool(
        backendId: string,
        toolName: string,
        argumentsObject: JsonObject = {},
    ): Promise<CallToolResult> {
        return this.getBackend(backendId).callTool(toolName, argumentsObject);
    }

    async closeAll(): Promise<void> {
        for (const backend of this.backends.values()) {
            await backend.close();
        }
    }

    async getCatalogEntries(backendIds?: string[]): Promise<CatalogEntry[]> {
        const selected = this.getBackends(backendIds);
        const results: CatalogEntry[] = [];

        for (const backend of selected) {
            await backend.ensureConnected();
            const cached = backend.getCatalog();
            results.push(...(cached.length > 0 ? cached : await backend.refreshCatalog()));
        }

        return results;
    }

    listBackendSummaries(): Array<{ id: string; label: string }> {
        return [...this.backends.values()].map((backend) => ({
            id: backend.getId(),
            label: backend.getLabel(),
        }));
    }

    async listStatuses(refresh = false): Promise<BackendStatus[]> {
        const statuses: BackendStatus[] = [];

        for (const backend of this.backends.values()) {
            if (refresh) {
                try {
                    await backend.refreshCatalog();
                } catch {
                    // Preserve the backend status and error message from the failed refresh.
                }
            }

            statuses.push(backend.getStatus());
        }

        return statuses;
    }

    async resolveCatalogEntry(
        backendId: string,
        toolName: string,
    ): Promise<CatalogEntry | null> {
        const backend = this.getBackend(backendId);
        await backend.ensureConnected();
        const cached = backend.getCatalog().find((entry) => entry.toolName === toolName);
        if (cached) {
            return cached;
        }

        const catalog = await backend.refreshCatalog();
        return catalog.find((entry) => entry.toolName === toolName) ?? null;
    }

    private getBackend(backendId: string): ManagedBackend {
        const backend = this.backends.get(backendId);
        if (!backend) {
            throw new Error(`Unknown backend ${backendId}.`);
        }

        return backend;
    }

    private getBackends(backendIds?: string[]): ManagedBackend[] {
        if (!backendIds || backendIds.length === 0) {
            return [...this.backends.values()];
        }

        return backendIds.map((backendId) => this.getBackend(backendId));
    }
}

async function listAllTools(client: Client): Promise<Tool[]> {
    const collected: Tool[] = [];
    let cursor: string | undefined;

    do {
        const { nextCursor, tools } = cursor
            ? await client.listTools({ cursor })
            : await client.listTools();
        collected.push(...tools);
        cursor = nextCursor;
    } while (cursor);

    return collected;
}

function toCatalogEntry(tool: Tool, backend: BackendConfig): CatalogEntry {
    const parsed = parseToolName(tool.name);
    const inputSchema = isObject(tool.inputSchema) ? tool.inputSchema : {};
    const rawRequired = 'required' in inputSchema ? inputSchema.required : undefined;
    const required = Array.isArray(rawRequired)
        ? rawRequired.filter((value): value is string => typeof value === 'string')
        : [];

    return {
        actionVerb: parsed.actionVerb,
        backendId: backend.id,
        backendLabel: backend.label ?? backend.id,
        classification: parsed.classification,
        description: tool.description ?? '',
        inputSchema,
        required,
        resourceName: parsed.resourceName,
        serviceName: parsed.serviceName,
        toolName: tool.name,
    };
}

function toErrorMessage(error: unknown, stderrLines: string[]): string {
    const suffix = stderrLines.length > 0 ? ` stderr: ${stderrLines.at(-1)}` : '';
    if (error instanceof Error) {
        return `${error.message}${suffix}`;
    }

    return `${String(error)}${suffix}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error as Error); },
        );
    });
}
