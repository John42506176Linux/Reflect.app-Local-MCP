# Reflect MCP Server

Connect your [Reflect](https://reflect.app) notes to Claude Desktop.

## Prerequisites

Before installing, make sure you have:

- **Reflect Desktop** - Must be installed (but does not need to be running)
  - Download from [reflect.app](https://reflect.app)

- **Claude Desktop** - Required to use MCP servers
  - Download from [claude.ai](https://claude.ai)

- **Node.js** - Version 18 or higher recommended
  - Download from [nodejs.org](https://nodejs.org)

## Quick Start

**1. Install the server:**

```bash
npx reflect-mcp install
```

**2. Add to Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "reflect": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
```

**3. Restart Claude Desktop**

That's it! First time you use a Reflect tool, your browser will open to authenticate.

## Commands

```bash
reflect-mcp install [db-path]    # Install as auto-start service
reflect-mcp uninstall            # Remove auto-start service
reflect-mcp status               # Check service status
reflect-mcp [db-path]            # Run server manually
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `db-path` | Path to Reflect SQLite database | `~/Library/Application Support/Reflect/File System/000/t/00/00000000` |
| `--port <port>` | Server port | `3000` |

## Examples

```bash
# Install with default settings
npx reflect-mcp install

# Install with custom database path
npx reflect-mcp install ~/custom/path/to/reflect/db

# Install with custom port
npx reflect-mcp install --port 4000

# Check if service is running
npx reflect-mcp status

# Remove auto-start
npx reflect-mcp uninstall
```

## Tools Available

- `get_graphs` - List all Reflect graphs
- `get_backlinks` - Get backlinks for a note
- `get_daily_notes` - Get recent daily notes
- `get_daily_note_by_date` - Get daily note for specific date
- `get_backlinked_notes` - Get notes with most backlinks
- `get_tags` - Get all tags with usage counts
- `get_notes_with_tag` - Get notes with a specific tag
- `get_note` - Get a note by title
- `create_note` - Create a new note

## License

MIT
