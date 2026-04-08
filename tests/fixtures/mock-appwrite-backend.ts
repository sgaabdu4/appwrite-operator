import process from 'node:process';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

async function main(): Promise<void> {
    const server = new McpServer({
        name: 'mock-appwrite-backend',
        version: '0.1.0',
    });

    server.registerTool(
        'functions_list_runtimes',
        {
            description: 'List available function runtimes.',
            inputSchema: z.object({}),
        },
        async () => ({
            content: [{ type: 'text', text: 'node-22\npython-3.12' }],
            structuredContent: { runtimes: ['node-22', 'python-3.12'] },
        }),
    );

    server.registerTool(
        'functions_get_execution',
        {
            description: 'Get one function execution by id.',
            inputSchema: z.object({
                execution_id: z.string(),
                function_id: z.string(),
            }),
        },
        async ({ execution_id, function_id }) => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ execution_id, function_id, status: 'completed' }),
                },
            ],
            structuredContent: {
                execution_id,
                function_id,
                status: 'completed',
            },
        }),
    );

    server.registerTool(
        'storage_list_files',
        {
            description: 'List files in a storage bucket.',
            inputSchema: z.object({
                bucket_id: z.string().optional(),
            }),
        },
        async ({ bucket_id }) => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ bucket_id: bucket_id ?? 'default', files: ['invoice.pdf', 'avatar.png'] }),
                },
            ],
            structuredContent: {
                bucket_id: bucket_id ?? 'default',
                files: ['invoice.pdf', 'avatar.png'],
            },
        }),
    );

    server.registerTool(
        'functions_delete_execution',
        {
            annotations: {
                destructiveHint: true,
                title: 'Delete Execution',
            },
            description: 'Delete a function execution.',
            inputSchema: z.object({
                execution_id: z.string(),
                function_id: z.string(),
            }),
        },
        async ({ execution_id, function_id }) => ({
            content: [
                {
                    type: 'text',
                    text: `deleted ${function_id}/${execution_id}`,
                },
            ],
            structuredContent: {
                deleted: true,
                execution_id,
                function_id,
            },
        }),
    );

    const transport = new StdioServerTransport();
    process.on('SIGINT', async () => {
        await server.close();
        process.exit(0);
    });
    await server.connect(transport);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
