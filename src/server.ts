import type { ResourceLink } from '@modelcontextprotocol/server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { BackendRegistry } from './backend.js';
import { searchCatalog } from './heuristics.js';
import { InvestigationStore } from './investigationStore.js';
import { executeInvestigationPlan, planInvestigation } from './planner.js';
import type {
    InvestigationRecord,
    JsonObject,
    JsonValue,
    LoadedOperatorConfig,
    SearchResult,
} from './types.js';

const instructions = [
    'Use appwrite_investigate for read-only troubleshooting across one or more Appwrite backends.',
    'Use appwrite_search_tools when you need to discover the exact hidden Appwrite tool name before calling it directly.',
    'Use appwrite_call_tool only when you already know the backend and exact Appwrite tool to run.',
    'For non-read-only Appwrite actions, appwrite_call_tool requires confirmWrite=true.',
    'Large investigation transcripts are available as operator resources instead of being fully embedded in tool responses.',
].join(' ');

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.boolean(),
        z.null(),
        z.number(),
        z.string(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
    z.string(),
    jsonValueSchema,
);

export function createOperatorServer(
    loadedConfig: LoadedOperatorConfig,
): {
    registry: BackendRegistry;
    server: McpServer;
    store: InvestigationStore;
} {
    const registry = new BackendRegistry(loadedConfig.config);
    const store = new InvestigationStore();

    const server = new McpServer(
        {
            name: 'appwrite-operator',
            version: '0.1.0',
        },
        {
            instructions,
        },
    );

    server.registerResource(
        'operator-catalog',
        new ResourceTemplate('operator://catalog/{backendId}', {
            list: async () => ({
                resources: registry.listBackendSummaries().map((backend) => ({
                    name: `${backend.label} catalog`,
                    uri: `operator://catalog/${backend.id}`,
                })),
            }),
        }),
        {
            description: 'Full hidden Appwrite tool catalog for a configured backend.',
            mimeType: 'application/json',
            title: 'Operator Backend Catalog',
        },
        async (uri, { backendId }) => {
            const resolvedBackendId = firstTemplateValue(backendId);
            const catalog = await registry.getCatalogEntries([resolvedBackendId]);
            return {
                contents: [
                    {
                        mimeType: 'application/json',
                        text: JSON.stringify(catalog, null, 2),
                        uri: uri.href,
                    },
                ],
            };
        },
    );

    server.registerResource(
        'operator-investigation',
        new ResourceTemplate('operator://investigations/{investigationId}', {
            list: async () => ({
                resources: store.list().map((record) => ({
                    name: `Investigation ${record.id}`,
                    uri: `operator://investigations/${record.id}`,
                })),
            }),
        }),
        {
            description: 'Stored Appwrite investigation transcript and step results.',
            mimeType: 'application/json',
            title: 'Investigation Transcript',
        },
        async (uri, { investigationId }) => {
            const record = store.get(firstTemplateValue(investigationId));
            return {
                contents: [
                    {
                        mimeType: 'application/json',
                        text: JSON.stringify(record ?? { error: 'Investigation not found.' }, null, 2),
                        uri: uri.href,
                    },
                ],
            };
        },
    );

    server.registerTool(
        'appwrite_list_backends',
        {
            annotations: {
                readOnlyHint: true,
                title: 'List Appwrite Backends',
            },
            description: 'List configured Appwrite backends and optionally refresh their hidden tool catalogs.',
            inputSchema: z.object({
                refresh: z.boolean().default(false),
            }),
        },
        async ({ refresh }) => {
            const statuses = await registry.listStatuses(refresh);
            const text =
                statuses.length > 0
                    ? statuses
                        .map((status) => {
                            const parts = [
                                `${status.id} (${status.label})`,
                                status.connected ? 'connected' : 'disconnected',
                                `tools=${status.toolCount}`,
                            ];
                            if (status.lastError) {
                                parts.push(`error=${status.lastError}`);
                            }
                            return `- ${parts.join(', ')}`;
                        })
                        .join('\n')
                    : 'No Appwrite backends configured.';

            return {
                content: [{ type: 'text', text }],
                structuredContent: { backends: statuses },
            };
        },
    );

    server.registerTool(
        'appwrite_search_tools',
        {
            annotations: {
                readOnlyHint: true,
                title: 'Search Appwrite Tool Catalog',
            },
            description: 'Search the hidden Appwrite tool catalog by goal, service, and backend before making an exact call.',
            inputSchema: z.object({
                argumentHints: jsonObjectSchema.optional(),
                backendIds: z.array(z.string()).optional(),
                includeMutating: z.boolean().default(false),
                limit: z.number().int().positive().default(loadedConfig.defaults.searchLimit),
                query: z.string().min(3),
                serviceHints: z.array(z.string()).optional(),
            }),
        },
        async ({ argumentHints, backendIds, includeMutating, limit, query, serviceHints }) => {
            const catalog = await registry.getCatalogEntries(backendIds);
            const matches = searchCatalog(catalog, {
                argumentHints,
                backendIds,
                includeMutating,
                limit,
                query,
                serviceHints,
            });

            const content: Array<{ text: string; type: 'text' } | ResourceLink> = [
                {
                    text: formatSearchResults(matches),
                    type: 'text',
                },
            ];

            for (const backendId of [...new Set(matches.map((match) => match.backendId))]) {
                content.push({
                    description: `Full hidden tool catalog for ${backendId}`,
                    mimeType: 'application/json',
                    name: `${backendId} catalog`,
                    type: 'resource_link',
                    uri: `operator://catalog/${backendId}`,
                });
            }

            return {
                content,
                structuredContent: { matches },
            };
        },
    );

    server.registerTool(
        'appwrite_call_tool',
        {
            annotations: {
                destructiveHint: true,
                title: 'Appwrite Direct Tool Call',
            },
            description: 'Call one exact hidden Appwrite tool on one exact backend. Non-read-only tools require confirmWrite=true.',
            inputSchema: z.object({
                arguments: jsonObjectSchema.default({}),
                backendId: z.string(),
                confirmWrite: z.boolean().default(false),
                toolName: z.string(),
            }),
        },
        async ({ arguments: argumentsObject, backendId, confirmWrite, toolName }) => {
            const catalogEntry = await registry.resolveCatalogEntry(backendId, toolName);
            if (!catalogEntry) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Tool ${toolName} was not found on backend ${backendId}. Use appwrite_search_tools first.`,
                        },
                    ],
                    isError: true,
                };
            }

            if (catalogEntry.classification !== 'read' && !confirmWrite) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Tool ${toolName} is ${catalogEntry.classification}. Re-run appwrite_call_tool with confirmWrite=true if you intend to mutate Appwrite state.`,
                        },
                    ],
                    isError: true,
                };
            }

            const result = await registry.callTool(backendId, toolName, argumentsObject);
            return {
                content: [
                    {
                        text: `backend=${backendId} tool=${toolName}`,
                        type: 'text',
                    },
                    ...result.content,
                ],
                isError: result.isError,
                structuredContent: {
                    backendId,
                    classification: catalogEntry.classification,
                    result: result.structuredContent ?? null,
                    toolName,
                },
            };
        },
    );

    server.registerTool(
        'appwrite_investigate',
        {
            annotations: {
                readOnlyHint: true,
                title: 'Appwrite Investigation',
            },
            description: 'Plan and run a bounded read-only Appwrite investigation, using sampling when available and deterministic heuristics otherwise.',
            inputSchema: z.object({
                argumentHints: jsonObjectSchema.optional(),
                backendIds: z.array(z.string()).optional(),
                goal: z.string().min(5),
                includeToolMatches: z.boolean().default(false),
                maxSteps: z.number().int().positive().max(12).optional(),
                serviceHints: z.array(z.string()).optional(),
            }),
        },
        async ({ argumentHints, backendIds, goal, includeToolMatches, maxSteps, serviceHints }, ctx) => {
            const catalog = await registry.getCatalogEntries(backendIds);
            const candidateLimit = loadedConfig.defaults.candidateToolLimit;
            const plan = await planInvestigation({
                argumentHints,
                backendIds,
                candidateLimit,
                catalog,
                goal,
                maxSteps: maxSteps ?? loadedConfig.defaults.maxInvestigationSteps,
                sampler: createSamplingFunction(ctx),
                serviceHints,
            });

            if (plan.steps.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'No runnable read-only Appwrite steps matched the goal and provided hints. Use appwrite_search_tools to inspect the hidden catalog and then appwrite_call_tool for an exact call.',
                        },
                    ],
                    isError: true,
                };
            }

            const results = await executeInvestigationPlan(plan, async (step) =>
                registry.callTool(step.backendId, step.toolName, step.arguments),
            );
            const record = store.save(goal, { plan, results });
            const content: Array<{ text: string; type: 'text' } | ResourceLink> = [
                {
                    text: formatInvestigation(record),
                    type: 'text',
                },
                {
                    description: 'Full investigation transcript and step results.',
                    mimeType: 'application/json',
                    name: `Investigation ${record.id}`,
                    type: 'resource_link',
                    uri: `operator://investigations/${record.id}`,
                },
            ];

            const structuredContent: {
                investigation: InvestigationRecord;
                toolMatches?: SearchResult[];
            } = { investigation: record };

            if (includeToolMatches) {
                structuredContent.toolMatches = searchCatalog(catalog, {
                    argumentHints,
                    backendIds,
                    includeMutating: false,
                    limit: loadedConfig.defaults.searchLimit,
                    query: goal,
                    serviceHints,
                });
            }

            return {
                content,
                structuredContent,
            };
        },
    );

    return { registry, server, store };
}

function formatInvestigation(record: InvestigationRecord): string {
    const lines = [
        `goal: ${record.goal}`,
        `planner: ${record.plan.planner}`,
        `summary: ${record.plan.summary}`,
        `steps: ${record.plan.steps.length}`,
    ];

    for (const [index, result] of record.results.entries()) {
        const preview = result.text.length > 220 ? `${result.text.slice(0, 220)}...` : result.text;
        lines.push(
            `${index + 1}. ${result.backendId}/${result.toolName} -> ${result.ok ? 'ok' : 'error'}: ${preview}`,
        );
    }

    return lines.join('\n');
}

function formatSearchResults(matches: SearchResult[]): string {
    if (matches.length === 0) {
        return 'No Appwrite tools matched that search.';
    }

    return matches
        .map((match, index) => {
            const required = match.required.length > 0 ? match.required.join(', ') : 'none';
            const missing =
                match.missingRequired.length > 0
                    ? ` missing=${match.missingRequired.join(', ')}`
                    : '';
            return `${index + 1}. backend=${match.backendId} tool=${match.toolName} class=${match.classification} required=${required}${missing} score=${match.score}`;
        })
        .join('\n');
}

type SamplingResponse = {
    content?: unknown;
};

type SamplingContext = {
    mcpReq?: {
        requestSampling?: (params: {
            maxTokens?: number;
            messages: Array<{
                content: { text: string; type: 'text' };
                role: 'user';
            }>;
        }) => Promise<SamplingResponse>;
    };
};

function createSamplingFunction(
    ctx: unknown,
): ((prompt: string) => Promise<string | null>) | undefined {
    const requestSampling = isSamplingContext(ctx)
        ? ctx.mcpReq?.requestSampling
        : undefined;

    if (!requestSampling) {
        return undefined;
    }

    return async (prompt: string) => {
        try {
            const response = await requestSampling({
                maxTokens: 1200,
                messages: [
                    {
                        content: { text: prompt, type: 'text' },
                        role: 'user',
                    },
                ],
            });
            return extractSamplingText(response.content);
        } catch {
            return null;
        }
    };
}

function extractSamplingText(content: unknown): string | null {
    if (typeof content === 'string') {
        return content;
    }

    if (isObject(content) && typeof content.text === 'string') {
        return content.text;
    }

    if (Array.isArray(content)) {
        const textParts = content
            .map((item) => (isObject(item) && typeof item.text === 'string' ? item.text : null))
            .filter((value): value is string => value !== null);
        return textParts.length > 0 ? textParts.join('\n') : null;
    }

    return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSamplingContext(value: unknown): value is SamplingContext {
    return (
        isObject(value) &&
        isObject(value.mcpReq) &&
        typeof value.mcpReq.requestSampling === 'function'
    );
}

function firstTemplateValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? '';
    }

    return value ?? '';
}
