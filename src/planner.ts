import type { CallToolResult } from '@modelcontextprotocol/client';

import { buildHeuristicPlanFromCandidates, pickMatchingArguments, searchCatalog } from './heuristics.js';
import {
    isObject,
    type CatalogEntry,
    type InvestigationPlan,
    type InvestigationStep,
    type InvestigationStepResult,
    type JsonObject,
    type SamplingPlanShape,
} from './types.js';

export type InvestigationPlannerOptions = {
    argumentHints: JsonObject | undefined;
    backendIds: string[] | undefined;
    candidateLimit: number;
    catalog: CatalogEntry[];
    goal: string;
    maxSteps: number;
    sampler: SamplingFunction | undefined;
    serviceHints: string[] | undefined;
};

export type SamplingFunction = (prompt: string) => Promise<string | null>;

export async function planInvestigation(
    options: InvestigationPlannerOptions,
): Promise<InvestigationPlan> {
    const candidateTools = searchCatalog(options.catalog, {
        argumentHints: options.argumentHints,
        backendIds: options.backendIds,
        includeMutating: false,
        limit: options.candidateLimit,
        query: options.goal,
        serviceHints: options.serviceHints,
    });

    const heuristicPlan = buildHeuristicPlanFromCandidates(candidateTools, options);

    if (!options.sampler) {
        return heuristicPlan;
    }

    const sampled = await buildSamplingPlan({
        argumentHints: options.argumentHints,
        backendIds: options.backendIds,
        candidateTools,
        goal: options.goal,
        maxSteps: options.maxSteps,
        sampler: options.sampler,
    });

    return sampled ?? heuristicPlan;
}

export async function executeInvestigationPlan(
    plan: InvestigationPlan,
    executeStep: (step: InvestigationStep) => Promise<CallToolResult>,
): Promise<InvestigationStepResult[]> {
    const results: InvestigationStepResult[] = [];

    for (const step of plan.steps) {
        try {
            const result = await executeStep(step);
            results.push({
                arguments: step.arguments,
                backendId: step.backendId,
                ok: !result.isError,
                text: flattenToolResult(result),
                toolName: step.toolName,
            });
        } catch (error) {
            results.push({
                arguments: step.arguments,
                backendId: step.backendId,
                ok: false,
                text: error instanceof Error ? error.message : String(error),
                toolName: step.toolName,
            });
        }
    }

    return results;
}

export function flattenToolResult(result: CallToolResult): string {
    const lines: string[] = [];

    for (const item of result.content) {
        switch (item.type) {
            case 'audio':
                lines.push(`[audio:${item.mimeType}]`);
                break;
            case 'image':
                lines.push(`[image:${item.mimeType}]`);
                break;
            case 'resource':
                lines.push(`[resource:${item.resource.uri}]`);
                break;
            case 'resource_link':
                lines.push(`[resource_link:${item.uri}]`);
                break;
            case 'text':
                lines.push(item.text);
                break;
            default:
                lines.push(JSON.stringify(item));
                break;
        }
    }

    if (lines.length === 0 && result.structuredContent) {
        return JSON.stringify(result.structuredContent, null, 2);
    }

    return lines.join('\n').trim();
}

async function buildSamplingPlan(options: {
    argumentHints: JsonObject | undefined;
    backendIds: string[] | undefined;
    candidateTools: CatalogEntry[];
    goal: string;
    maxSteps: number;
    sampler: SamplingFunction;
}): Promise<InvestigationPlan | null> {
    if (options.candidateTools.length === 0) {
        return null;
    }

    const prompt = createSamplingPrompt(options);
    const responseText = await options.sampler(prompt);
    if (!responseText) {
        return null;
    }

    const parsed = parseSamplingResponse(responseText);
    if (!parsed) {
        return null;
    }

    const candidateMap = new Map(
        options.candidateTools.map((entry) => [`${entry.backendId}:${entry.toolName}`, entry]),
    );
    const allowedBackendIds = new Set(options.candidateTools.map((entry) => entry.backendId));

    const steps = sanitizeSampledSteps(
        parsed,
        candidateMap,
        allowedBackendIds,
        options.argumentHints,
        options.maxSteps,
    );

    if (steps.length === 0) {
        return null;
    }

    return {
        planner: 'sampling',
        selectedBackendIds: [...new Set(steps.map((step) => step.backendId))],
        steps,
        summary:
            typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
                ? parsed.summary
                : `Sampling selected ${steps.length} read-only Appwrite investigation steps.`,
    };
}

function createSamplingPrompt(options: {
    argumentHints: JsonObject | undefined;
    backendIds: string[] | undefined;
    candidateTools: CatalogEntry[];
    goal: string;
    maxSteps: number;
}): string {
    const requestedBackends = options.backendIds?.join(', ') ?? 'auto';
    const argumentHintBlock = JSON.stringify(options.argumentHints ?? {}, null, 2);
    const toolBlock = options.candidateTools
        .map((entry) => {
            const required = entry.required.length > 0 ? entry.required.join(', ') : 'none';
            return [
                `backend=${entry.backendId}`,
                `tool=${entry.toolName}`,
                `service=${entry.serviceName}`,
                `required=${required}`,
                `description=${entry.description || 'none'}`,
            ].join(' | ');
        })
        .join('\n');

    return [
        'You are planning a read-only Appwrite investigation.',
        'Only choose tools from the candidate list below.',
        'Never invent Appwrite ids, emails, or arguments.',
        'Only use arguments that appear in the provided argumentHints object.',
        `Investigation goal: ${options.goal}`,
        `Requested backends: ${requestedBackends}`,
        `Maximum steps: ${options.maxSteps}`,
        'argumentHints:',
        argumentHintBlock,
        'Candidate tools:',
        toolBlock,
        'Return JSON only with this shape:',
        '{"selectedBackendIds":["backend-id"],"steps":[{"backendId":"backend-id","toolName":"service_action","arguments":{},"reason":"why"}],"summary":"short summary"}',
    ].join('\n');
}

function parseSamplingResponse(responseText: string): SamplingPlanShape | null {
    const jsonText = extractJsonObject(responseText);
    if (!jsonText) {
        return null;
    }

    try {
        return JSON.parse(jsonText) as SamplingPlanShape;
    } catch {
        return null;
    }
}

function extractJsonObject(value: string): string | null {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) {
        return null;
    }

    return value.slice(start, end + 1);
}

function sanitizeSampledSteps(
    parsed: SamplingPlanShape,
    candidateMap: Map<string, CatalogEntry>,
    allowedBackendIds: Set<string>,
    argumentHints: JsonObject | undefined,
    maxSteps: number,
): InvestigationStep[] {
    if (!Array.isArray(parsed.steps)) {
        return [];
    }

    const sanitized: InvestigationStep[] = [];

    for (const rawStep of parsed.steps) {
        if (!isObject(rawStep)) {
            continue;
        }

        const backendId = typeof rawStep.backendId === 'string' ? rawStep.backendId : null;
        const toolName = typeof rawStep.toolName === 'string' ? rawStep.toolName : null;
        const reason = typeof rawStep.reason === 'string' ? rawStep.reason : 'Sampling-selected Appwrite read-only step.';

        if (!backendId || !toolName || !allowedBackendIds.has(backendId)) {
            continue;
        }

        const catalogEntry = candidateMap.get(`${backendId}:${toolName}`);
        if (!catalogEntry || catalogEntry.classification !== 'read') {
            continue;
        }

        const argumentsObject = sanitizeArguments(
            rawStep.arguments,
            catalogEntry,
            argumentHints,
        );

        if (catalogEntry.required.some((key) => !(key in argumentsObject))) {
            continue;
        }

        sanitized.push({
            arguments: argumentsObject,
            backendId,
            reason,
            toolName,
        });

        if (sanitized.length >= maxSteps) {
            break;
        }
    }

    return sanitized;
}

function sanitizeArguments(
    rawArguments: unknown,
    catalogEntry: CatalogEntry,
    argumentHints?: JsonObject,
): JsonObject {
    if (!isObject(rawArguments) || !argumentHints) {
        return pickMatchingArguments(catalogEntry, argumentHints);
    }

    const sanitized: JsonObject = {};
    for (const [key] of Object.entries(rawArguments)) {
        if (!(key in argumentHints)) {
            continue;
        }

        const value = argumentHints[key];
        if (value !== undefined) {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

