#!/usr/bin/env node
import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/server';

import { loadOperatorConfig } from './config.js';
import { createOperatorServer } from './server.js';

async function main(): Promise<void> {
    const loadedConfig = await loadOperatorConfig();
    const { registry, server } = createOperatorServer(loadedConfig);
    const transport = new StdioServerTransport();

    const shutdown = async (): Promise<void> => {
        await registry.closeAll();
        await server.close();
    };

    process.on('SIGINT', async () => {
        await shutdown();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await shutdown();
        process.exit(0);
    });

    try {
        await server.connect(transport);
    } catch (error) {
        await shutdown();
        throw error;
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
