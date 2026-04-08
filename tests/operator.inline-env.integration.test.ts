import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

const currentFile = fileURLToPath(import.meta.url);
const testsDir = path.dirname(currentFile);
const projectRoot = path.resolve(testsDir, '..');
const operatorEntry = path.join(projectRoot, 'src', 'index.ts');
const mockBackendEntry = path.join(projectRoot, 'tests', 'fixtures', 'mock-appwrite-backend.ts');

test('operator supports direct Appwrite env mode without a config file', async (t) => {
  const client = new Client({ name: 'operator-inline-env-client', version: '0.1.0' });
  const transport = new StdioClientTransport({
    args: [operatorEntry],
    command: 'tsx',
    cwd: projectRoot,
    env: {
      APPWRITE_API_KEY: 'inline-key',
      APPWRITE_ENDPOINT: 'https://inline.example/v1',
      APPWRITE_OPERATOR_BACKEND_ARGS_JSON: JSON.stringify([mockBackendEntry]),
      APPWRITE_OPERATOR_BACKEND_COMMAND: 'tsx',
      APPWRITE_PROJECT_ID: 'inline-project',
    },
    stderr: 'pipe',
  });

  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const result = await client.callTool({
    arguments: { refresh: true },
    name: 'appwrite_list_backends',
  });

  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

  assert.match(text, /appwrite \(Appwrite\), connected, tools=4/i);
});