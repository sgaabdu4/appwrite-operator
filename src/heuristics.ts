import type {
    CatalogEntry,
    InvestigationPlan,
    InvestigationStep,
    JsonObject,
    SearchResult,
    ToolClassification,
} from './types.js';

const VERBS = ['list', 'get', 'create', 'update', 'delete'] as const;
const VERB_SET = new Set<string>(VERBS);

export type SearchCatalogOptions = {
    argumentHints: JsonObject | undefined;
    backendIds: string[] | undefined;
    includeMutating: boolean;
    limit: number;
    query: string;
    serviceHints: string[] | undefined;
};

export type HeuristicPlanOptions = {
    argumentHints: JsonObject | undefined;
    backendIds: string[] | undefined;
    candidateLimit: number;
    catalog: CatalogEntry[];
    goal: string;
    maxSteps: number;
    serviceHints: string[] | undefined;
};

export function buildHeuristicInvestigationPlan(
    options: HeuristicPlanOptions,
): InvestigationPlan {
    const matches = searchCatalog(options.catalog, {
        argumentHints: options.argumentHints,
        backendIds: options.backendIds,
        includeMutating: false,
        limit: options.candidateLimit,
        query: options.goal,
        serviceHints: options.serviceHints,
    }).filter((entry) => entry.classification === 'read');

    const runnable = matches.filter((entry) => entry.missingRequired.length === 0);
    const selected = runnable.slice(0, options.maxSteps);

    const steps: InvestigationStep[] = selected.map((entry) => ({
        arguments: pickMatchingArguments(entry, options.argumentHints),
        backendId: entry.backendId,
        reason: `Heuristic match score ${entry.score} for ${entry.toolName}.`,
        toolName: entry.toolName,
    }));

    const selectedBackendIds = [...new Set(steps.map((step) => step.backendId))];
    const summary =
        steps.length > 0
            ? `Heuristic fallback selected ${steps.length} read-only Appwrite tool${steps.length === 1 ? '' : 's'}.`
            : 'Heuristic fallback could not find a runnable read-only Appwrite tool with the provided hints.';

    return {
        planner: 'heuristic',
        selectedBackendIds,
        steps,
        summary,
    };
}

export function parseToolName(toolName: string): {
    actionVerb: string;
    classification: ToolClassification;
    resourceName: string;
    serviceName: string;
} {
    const tokens = toolName.toLowerCase().split('_').filter(Boolean);
    const verbIndex = tokens.findIndex((token) => VERB_SET.has(token));

    if (verbIndex < 0) {
        return {
            actionVerb: 'unknown',
            classification: 'unknown',
            resourceName: '',
            serviceName: toolName,
        };
    }

    const actionVerb = tokens[verbIndex] ?? 'unknown';
    return {
        actionVerb,
        classification: classifyVerb(actionVerb),
        resourceName: tokens.slice(verbIndex + 1).join('_'),
        serviceName: tokens.slice(0, verbIndex).join('_'),
    };
}

export function searchCatalog(
    catalog: CatalogEntry[],
    options: SearchCatalogOptions,
): SearchResult[] {
    const serviceHintSet = new Set(
        (options.serviceHints ?? []).map((entry) => normalizeToken(entry)),
    );
    const backendIdSet = options.backendIds ? new Set(options.backendIds) : null;
    const queryTokens = tokenize(options.query);
    const queryLower = options.query.toLowerCase();

    const ranked = catalog
        .filter((entry) => {
            if (backendIdSet && !backendIdSet.has(entry.backendId)) {
                return false;
            }

            if (!options.includeMutating && entry.classification !== 'read') {
                return false;
            }

            if (serviceHintSet.size === 0) {
                return true;
            }

            return serviceHintSet.has(normalizeToken(entry.serviceName));
        })
        .map((entry) => {
            const missingRequired = getMissingRequiredArguments(
                entry,
                options.argumentHints,
            );
            return {
                ...entry,
                missingRequired,
                score: computeScore(entry, queryTokens, queryLower, serviceHintSet, missingRequired),
            } satisfies SearchResult;
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.toolName.localeCompare(right.toolName));

    return ranked.slice(0, options.limit);
}

export function getMissingRequiredArguments(
    entry: CatalogEntry,
    argumentHints?: JsonObject,
): string[] {
    const availableKeys = new Set(Object.keys(argumentHints ?? {}));
    return entry.required.filter((key) => !availableKeys.has(key));
}

export function pickMatchingArguments(
    entry: CatalogEntry,
    argumentHints?: JsonObject,
): JsonObject {
    if (!argumentHints) {
        return {};
    }

    const selected: JsonObject = {};
    for (const key of Object.keys(argumentHints)) {
        if (entry.required.includes(key) || hasSchemaProperty(entry, key)) {
            const value = argumentHints[key];
            if (value !== undefined) {
                selected[key] = value;
            }
        }
    }

    return selected;
}

export function tokenize(value: string): string[] {
    return [...new Set(
        value
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length >= 2),
    )];
}

function classifyVerb(actionVerb: string): ToolClassification {
    switch (actionVerb) {
        case 'get':
        case 'list':
            return 'read';
        case 'create':
        case 'update':
            return 'write';
        case 'delete':
            return 'delete';
        default:
            return 'unknown';
    }
}

function computeScore(
    entry: CatalogEntry,
    queryTokens: string[],
    queryLower: string,
    serviceHints: Set<string>,
    missingRequired: string[],
): number {
    const haystackTokens = new Set(
        tokenize(
            [
                entry.toolName,
                entry.description,
                entry.serviceName,
                entry.resourceName,
            ].join(' '),
        ),
    );

    let score = 0;
    let needsSubstring = false;
    for (const qToken of queryTokens) {
        if (haystackTokens.has(qToken)) {
            score += 5;
        } else {
            needsSubstring = true;
        }
    }

    if (needsSubstring) {
        const haystackArray = [...haystackTokens];
        for (const qToken of queryTokens) {
            if (!haystackTokens.has(qToken) && haystackArray.some((hToken) => hToken.includes(qToken) || qToken.includes(hToken))) {
                score += 3;
            }
        }
    }

    if (serviceHints.has(normalizeToken(entry.serviceName))) {
        score += 8;
    }

    if (entry.classification === 'read') {
        score += 2;
    }

    if (missingRequired.length === 0) {
        score += 3;
    } else {
        score -= missingRequired.length * 6;
    }

    if (queryLower.includes(entry.toolName.toLowerCase())) {
        score += 10;
    }

    return score;
}

function hasSchemaProperty(entry: CatalogEntry, key: string): boolean {
    const properties = entry.inputSchema.properties;
    return isStringRecord(properties) && Object.hasOwn(properties, key);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
