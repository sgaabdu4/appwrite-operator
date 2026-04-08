import process from 'node:process';

import type {
  BackendConfig,
  LoadedOperatorConfig,
  OperatorConfig,
  OperatorDefaults,
} from './types.js';

const DEFAULTS: OperatorDefaults = {
  candidateToolLimit: 12,
  maxInvestigationSteps: 4,
  searchLimit: 8,
};

const ENV_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

export async function loadOperatorConfig(): Promise<LoadedOperatorConfig> {
  const inlineConfig = buildInlineEnvironmentConfig();
  if (!inlineConfig) {
    throw new Error(
      'Set APPWRITE_PROJECT_ID and APPWRITE_API_KEY in the MCP server env. APPWRITE_ENDPOINT is optional.',
    );
  }

  return {
    config: inlineConfig,
    configPath: '<inline-env>',
    defaults: { ...DEFAULTS, ...inlineConfig.defaults },
    envPath: '<inline-env>',
  };
}

function buildInlineEnvironmentConfig(): OperatorConfig | null {
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;

  if (!projectId || !apiKey) {
    return null;
  }

  const endpoint = process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1';
  const backendCommand = process.env.APPWRITE_OPERATOR_BACKEND_COMMAND ?? 'uvx';
  const backendArgs = readInlineBackendArgs();

  return {
    backends: [
      {
        args: backendArgs,
        command: backendCommand,
        env: {
          APPWRITE_API_KEY: apiKey,
          APPWRITE_ENDPOINT: endpoint,
          APPWRITE_PROJECT_ID: projectId,
        },
        id: 'appwrite',
        label: 'Appwrite',
      },
    ],
  };
}

export function resolveBackendEnvironment(
  backend: BackendConfig,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(backend.env ?? {})) {
    const match = value.match(ENV_PLACEHOLDER);

    if (!match) {
      resolved[key] = value;
      continue;
    }

    const envName = match[1];
    if (!envName) {
      throw new Error(`Backend ${backend.id} has an invalid environment placeholder.`);
    }
    const envValue = process.env[envName];

    if (!envValue) {
      throw new Error(
        `Backend ${backend.id} requires environment variable ${envName}.`,
      );
    }

    resolved[key] = envValue;
  }

  return resolved;
}

function readInlineBackendArgs(): string[] {
  const argsJson = process.env.APPWRITE_OPERATOR_BACKEND_ARGS_JSON;
  if (argsJson) {
    const parsed = JSON.parse(argsJson) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }

    throw new Error('APPWRITE_OPERATOR_BACKEND_ARGS_JSON must be a JSON array of strings.');
  }

  const args = process.env.APPWRITE_OPERATOR_BACKEND_ARGS;
  if (args) {
    return args.split(/\s+/).filter(Boolean);
  }

  return ['mcp-server-appwrite', '--all'];
}
