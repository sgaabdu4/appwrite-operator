import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHeuristicInvestigationPlan, parseToolName, searchCatalog } from '../src/heuristics.js';
import type { CatalogEntry } from '../src/types.js';

test('parseToolName classifies Appwrite read and delete tools', () => {
    assert.deepEqual(parseToolName('functions_list_runtimes'), {
        actionVerb: 'list',
        classification: 'read',
        resourceName: 'runtimes',
        serviceName: 'functions',
    });

    assert.deepEqual(parseToolName('functions_delete_execution'), {
        actionVerb: 'delete',
        classification: 'delete',
        resourceName: 'execution',
        serviceName: 'functions',
    });
});

test('searchCatalog prefers runnable read-only tools', () => {
    const catalog: CatalogEntry[] = [
        {
            actionVerb: 'list',
            backendId: 'mock',
            backendLabel: 'Mock',
            classification: 'read',
            description: 'List available runtimes.',
            inputSchema: { type: 'object' },
            required: [],
            resourceName: 'runtimes',
            serviceName: 'functions',
            toolName: 'functions_list_runtimes',
        },
        {
            actionVerb: 'get',
            backendId: 'mock',
            backendLabel: 'Mock',
            classification: 'read',
            description: 'Get one execution.',
            inputSchema: {
                properties: { execution_id: { type: 'string' }, function_id: { type: 'string' } },
                type: 'object',
            },
            required: ['function_id', 'execution_id'],
            resourceName: 'execution',
            serviceName: 'functions',
            toolName: 'functions_get_execution',
        },
    ];

    const matches = searchCatalog(catalog, {
        argumentHints: {},
        backendIds: undefined,
        includeMutating: false,
        limit: 5,
        query: 'show functions runtimes',
        serviceHints: ['functions'],
    });

    assert.equal(matches[0]?.toolName, 'functions_list_runtimes');
});

test('buildHeuristicInvestigationPlan skips tools with missing required arguments', () => {
    const catalog: CatalogEntry[] = [
        {
            actionVerb: 'get',
            backendId: 'mock',
            backendLabel: 'Mock',
            classification: 'read',
            description: 'Get one execution.',
            inputSchema: {
                properties: { execution_id: { type: 'string' }, function_id: { type: 'string' } },
                type: 'object',
            },
            required: ['function_id', 'execution_id'],
            resourceName: 'execution',
            serviceName: 'functions',
            toolName: 'functions_get_execution',
        },
        {
            actionVerb: 'list',
            backendId: 'mock',
            backendLabel: 'Mock',
            classification: 'read',
            description: 'List available runtimes.',
            inputSchema: { type: 'object' },
            required: [],
            resourceName: 'runtimes',
            serviceName: 'functions',
            toolName: 'functions_list_runtimes',
        },
    ];

    const plan = buildHeuristicInvestigationPlan({
        argumentHints: {},
        backendIds: ['mock'],
        candidateLimit: 5,
        catalog,
        goal: 'show functions runtimes',
        maxSteps: 3,
        serviceHints: ['functions'],
    });

    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]?.toolName, 'functions_list_runtimes');
});
