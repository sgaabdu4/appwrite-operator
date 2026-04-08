# Appwrite Operator MCP

A small-surface MCP server that hides one or more full Appwrite MCP backends behind a short operator toolset.

## What It Does

- Starts directly from `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`, and `APPWRITE_ENDPOINT`
- Spawns one hidden `mcp-server-appwrite --all` backend
- Exposes a short public tool surface instead of thousands of raw tools
- Keeps larger investigation transcripts in MCP resources instead of bloating tool output

## Public Tools

- `appwrite_list_backends`
- `appwrite_search_tools`
- `appwrite_call_tool`
- `appwrite_investigate`

## Setup

```bash
cd appwrite-operator
npm install
npm run build
npm test
```

## Single Backend Shortcut

The operator starts directly from server env vars. No `appwrite-operator.config.json` and no `.env` file are required:

```json
{
  "servers": {
    "appwrite-operator": {
      "command": "node",
      "args": ["/absolute/path/to/appwrite-operator/build/src/index.js"],
      "env": {
        "APPWRITE_PROJECT_ID": "your-project-id",
        "APPWRITE_API_KEY": "your-api-key",
        "APPWRITE_ENDPOINT": "https://your-appwrite-endpoint/v1"
      }
    }
  }
}
```

## VS Code MCP Example

This project does not modify your existing MCP config automatically. After building, point your MCP client at the compiled server.

```json
{
  "servers": {
    "appwrite-operator": {
      "command": "node",
      "args": ["/absolute/path/to/appwrite-operator/build/src/index.js"],
      "env": {
        "APPWRITE_OPERATOR_CONFIG": "/absolute/path/to/appwrite-operator/appwrite-operator.config.json",
        "APPWRITE_OPERATOR_ENV": "/absolute/path/to/appwrite-operator/.env"
      }
    }
  }
}
```

## Notes

- The hidden backend command defaults to `uvx mcp-server-appwrite --all`
- `appwrite_investigate` uses sampling when the MCP client supports it and falls back to deterministic heuristics otherwise
- `appwrite_call_tool` requires `confirmWrite: true` for non-read-only Appwrite tools
