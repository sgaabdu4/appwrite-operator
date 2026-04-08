export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type OperatorDefaults = {
    candidateToolLimit: number;
    maxInvestigationSteps: number;
    searchLimit: number;
};

export type BackendConfig = {
    args?: string[];
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    id: string;
    label?: string;
};

export type OperatorConfig = {
    backends: BackendConfig[];
    defaults?: Partial<OperatorDefaults>;
};

export type LoadedOperatorConfig = {
    config: OperatorConfig;
    configPath: string;
    defaults: OperatorDefaults;
    envPath: string;
};

export type ToolClassification = 'delete' | 'read' | 'unknown' | 'write';

export type CatalogEntry = {
    actionVerb: string;
    backendId: string;
    backendLabel: string;
    classification: ToolClassification;
    description: string;
    inputSchema: Record<string, unknown>;
    required: string[];
    resourceName: string;
    serviceName: string;
    toolName: string;
};

export type BackendStatus = {
    connected: boolean;
    id: string;
    label: string;
    lastConnectedAt?: string;
    lastError?: string;
    services: string[];
    toolCount: number;
};

export type SearchResult = CatalogEntry & {
    missingRequired: string[];
    score: number;
};

export type InvestigationStep = {
    arguments: JsonObject;
    backendId: string;
    reason: string;
    toolName: string;
};

export type InvestigationPlan = {
    planner: 'heuristic' | 'sampling';
    selectedBackendIds: string[];
    steps: InvestigationStep[];
    summary: string;
};

export type InvestigationStepResult = {
    arguments: JsonObject;
    backendId: string;
    ok: boolean;
    text: string;
    toolName: string;
};

export type InvestigationRecord = {
    createdAt: string;
    goal: string;
    id: string;
    plan: InvestigationPlan;
    results: InvestigationStepResult[];
};

export type SamplingPlanShape = {
    selectedBackendIds?: unknown;
    steps?: unknown;
    summary?: unknown;
};

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
