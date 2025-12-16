/**
 * Example FastMCP server with custom OAuth Proxy
 *
 * This example shows how to configure a custom OAuth provider
 *
 * Run with: npx tsx src/index.ts
 */

import "dotenv/config";
import { OAuthProxy } from "fastmcp/auth";
import { FastMCP, Logger } from "fastmcp";
import { z } from "zod";
import Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";

// Reflect local database path
const DEFAULT_DB_PATH = "~/Library/Application Support/Reflect/File System/000/t/00/00000000";

function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function stripHtml(html: string | null): string {
  if (!html) return "";
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/\n\s*\n/g, "\n\n");
  return text.trim();
}

function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function getDateForTimezone(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // Returns YYYY-MM-DD format
}

// Create OAuth Proxy with custom provider configuration
const authProxy = new OAuthProxy({
  baseUrl: "http://localhost:3000",
  scopes: ["read:graph", "write:graph"],
  upstreamAuthorizationEndpoint: "https://reflect.app/oauth",
  upstreamClientId: process.env.REFLECT_CLIENT_ID || "",
  upstreamClientSecret: process.env.REFLECT_CLIENT_SECRET || "",
  upstreamTokenEndpoint: "https://reflect.app/api/oauth/token",
});

class CustomLogger implements Logger {
  debug(...args: unknown[]): void {
    console.log("[DEBUG]", new Date().toISOString(), ...args);
  }

  error(...args: unknown[]): void {
    console.error("[ERROR]", new Date().toISOString(), ...args);
  }

  info(...args: unknown[]): void {
    console.info("[INFO]", new Date().toISOString(), ...args);
  }

  log(...args: unknown[]): void {
    console.log("[LOG]", new Date().toISOString(), ...args);
  }

  warn(...args: unknown[]): void {
    console.warn("[WARN]", new Date().toISOString(), ...args);
  }
}

// Get auth server metadata to use in both configs
const authServerMetadata = authProxy.getAuthorizationServerMetadata();

const server = new FastMCP({
  name: "Custom OAuth Proxy Server",
  logger: new CustomLogger(),
  oauth: {
    // OAuth Authorization Server metadata for /.well-known/oauth-authorization-server
    authorizationServer: authServerMetadata,
    enabled: true,
    // OAuth Protected Resource metadata for /.well-known/oauth-protected-resource
    // This is REQUIRED for MCP clients like Claude Desktop to discover how to authenticate
    protectedResource: {
      // The resource identifier - must match your server's base URL
      resource: "http://localhost:3000",
      // List of trusted authorization servers (issuer values)
      authorizationServers: [authServerMetadata.issuer],
      // Scopes supported by this resource
      scopesSupported: ["read:graph", "write:graph"],
    },
    proxy: authProxy,
  },
  authenticate: async (request) => {
    console.log("[Auth] === AUTHENTICATE CALLED ===");
    console.log("[Auth] Request method:", request.method);
    console.log("[Auth] Request URL:", request.url);
    
    const authHeader = request.headers.authorization;

    // No auth header - return undefined to let OAuth proxy handle it
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[Auth] No Bearer token - returning undefined to trigger OAuth flow");
      return undefined;
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix
    console.log("[Auth] Token received, length:", token.length);

    // Verify the FastMCP JWT and load the upstream Reflect tokens
    try {
      const upstreamTokens = await authProxy.loadUpstreamTokens(token);
      
      if (!upstreamTokens) {
        console.log("[Auth] Invalid or expired token - returning undefined to trigger re-auth");
        return undefined;
      }

      console.log("[Auth] Authenticated! Reflect token expires in:", upstreamTokens.expiresIn, "seconds");

      // Return session with Reflect access token for use in tools
      return {
        accessToken: upstreamTokens.accessToken,
        refreshToken: upstreamTokens.refreshToken,
        expiresIn: upstreamTokens.expiresIn,
      };
    } catch (error) {
      console.error("[Auth] Error loading upstream tokens:", error);
      // Return undefined to trigger OAuth flow instead of crashing
      return undefined;
    }
  },
  version: "1.0.0",
});

// Tool: Get all Reflect graphs
server.addTool({
  name: "get_graphs",
  description: "Get a list of all Reflect graphs accessible with the current access token",
  parameters: z.object({}),
  execute: async (_args, { session }) => {
    if (!session) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Not authenticated. Please complete OAuth flow first." }),
          },
        ],
      };
    }

    const { accessToken } = session as { accessToken: string };

    try {
      const response = await fetch("https://reflect.app/api/graphs", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get backlinks for a note from local Reflect SQLite database
server.addTool({
  name: "get_backlinks",
  description: "Get backlinks for a note from the local Reflect database. Returns notes that link to the specified note.",
  parameters: z.object({
    subject: z.string().describe("The subject/title of the note to get backlinks for"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    limit: z.number().default(10).describe("Maximum number of backlinks to return"),
  }),
  execute: async (args) => {
    const { subject, graphId, limit } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT bl.contextHtml, bl.label, bl.updatedAt, source.subject AS from_subject
        FROM noteBacklinks bl
        JOIN notes target ON bl.toNoteId = target.id
        JOIN notes source ON bl.fromNoteId = source.id
        WHERE target.subject = ? AND target.graphId = ?
        ORDER BY bl.updatedAt DESC
        LIMIT ?
      `);

      const results = stmt.all(subject, graphId, limit) as any[];
      db.close();

      const backlinks = results.map((row) => ({
        fromSubject: row.from_subject,
        label: row.label,
        contextText: stripHtml(row.contextHtml),
        updatedAt: formatDate(row.updatedAt),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ subject, graphId, backlinks }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get recent daily notes
server.addTool({
  name: "get_daily_notes",
  description: "Get the most recent daily notes from the local Reflect database",
  parameters: z.object({
    limit: z.number().default(5).describe("Number of recent daily notes to return"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
  }),
  execute: async (args) => {
    const { limit, graphId } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT id, subject, documentText, editedAt, tags, dailyDate, graphId
        FROM notes 
        WHERE isDaily = 1 AND isDeleted = 0 AND LENGTH(documentText) > 0 AND graphId = ?
        ORDER BY dailyDate DESC
        LIMIT ?
      `);

      const rows = stmt.all(graphId, limit) as any[];
      db.close();

      const dailyNotes = rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        documentText: row.documentText?.slice(0, 500) || "",
        editedAt: formatDate(row.editedAt),
        tags: row.tags ? JSON.parse(row.tags) : [],
        dailyDate: formatDate(row.dailyDate),
        graphId: row.graphId,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ graphId, count: dailyNotes.length, dailyNotes }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get daily note by date
server.addTool({
  name: "get_daily_note_by_date",
  description: "Get the daily note for a specific date from the local Reflect database",
  parameters: z.object({
    date: z.string().describe("The date in YYYY-MM-DD format"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
  }),
  execute: async (args) => {
    const { date, graphId } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      // Convert YYYY-MM-DD to milliseconds timestamp at midnight
      const dateObj = new Date(date + "T00:00:00");
      const dateMs = dateObj.getTime();

      const stmt = db.prepare(`
        SELECT id, subject, documentText, editedAt, tags, dailyDate, graphId
        FROM notes 
        WHERE isDaily = 1 AND isDeleted = 0 AND graphId = ? AND dailyDate = ?
      `);

      const result = stmt.get(graphId, dateMs) as any;
      db.close();

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `No daily note found for ${date}`, date, graphId }),
            },
          ],
        };
      }

      const dailyNote = {
        id: result.id,
        subject: result.subject,
        documentText: result.documentText,
        editedAt: formatDate(result.editedAt),
        tags: result.tags ? JSON.parse(result.tags) : [],
        dailyDate: formatDate(result.dailyDate),
        graphId: result.graphId,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ date, graphId, dailyNote }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get notes with most backlinks
server.addTool({
  name: "get_backlinked_notes",
  description: "Get notes that have at least a minimum number of backlinks from the local Reflect database",
  parameters: z.object({
    minBacklinks: z.number().default(5).describe("Minimum number of backlinks a note must have"),
    limit: z.number().default(10).describe("Maximum number of notes to return"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
  }),
  execute: async (args) => {
    const { minBacklinks, limit, graphId } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT n.id, n.subject, COUNT(bl.id) as backlink_count, n.documentText
        FROM notes n
        JOIN noteBacklinks bl ON bl.toNoteId = n.id
        WHERE n.isDeleted = 0 AND n.subject != 'Audio Memos' AND n.subject != 'Links' AND n.graphId = ?
        GROUP BY n.id
        HAVING COUNT(bl.id) >= ?
        ORDER BY backlink_count DESC
        LIMIT ?
      `);

      const results = stmt.all(graphId, minBacklinks, limit) as any[];
      db.close();

      const notes = results.map((row) => ({
        id: row.id,
        subject: row.subject,
        backlinkCount: row.backlink_count,
        documentText: row.documentText?.slice(0, 200) || "",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ graphId, minBacklinks, count: notes.length, notes }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get all tags with usage counts
server.addTool({
  name: "get_tags",
  description: "Get all unique tags with their usage counts from the local Reflect database",
  parameters: z.object({
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    limit: z.number().default(50).describe("Maximum number of tags to return"),
  }),
  execute: async (args) => {
    const { graphId, limit } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT tags FROM notes 
        WHERE isDeleted = 0 AND graphId = ? AND tags IS NOT NULL AND tags != '[]'
      `);

      const rows = stmt.all(graphId) as any[];
      db.close();

      const tagCounts: Record<string, number> = {};
      for (const row of rows) {
        try {
          const tags = JSON.parse(row.tags) as string[];
          for (const tag of tags) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        } catch {
          continue;
        }
      }

      // Sort by count descending
      const sortedTags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ graphId, totalTags: Object.keys(tagCounts).length, tags: sortedTags }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get notes with a specific tag
server.addTool({
  name: "get_notes_with_tag",
  description: "Get notes that have a specific tag from the local Reflect database",
  parameters: z.object({
    tag: z.string().describe("The tag to search for"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    limit: z.number().default(20).describe("Maximum number of notes to return"),
  }),
  execute: async (args) => {
    const { tag, graphId, limit } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT id, subject, tags, editedAt, LENGTH(documentText) as docLen, documentText
        FROM notes 
        WHERE isDeleted = 0 AND graphId = ? AND tags LIKE ?
        ORDER BY editedAt DESC
        LIMIT ?
      `);

      const results = stmt.all(graphId, `%"${tag}"%`, limit) as any[];
      db.close();

      const notes = results.map((row) => ({
        id: row.id,
        subject: row.subject,
        tags: row.tags ? JSON.parse(row.tags) : [],
        editedAt: formatDate(row.editedAt),
        documentLength: row.docLen,
        documentText: row.documentText?.slice(0, 300) || "",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ tag, graphId, count: notes.length, notes }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Get a note by title
server.addTool({
  name: "get_note",
  description: "Get a note by its title (subject) from the local Reflect database",
  parameters: z.object({
    title: z.string().describe("The title/subject of the note to retrieve"),
    graphId: z.string().default("rapheal-brain").describe("The graph ID to search in"),
  }),
  execute: async (args) => {
    const { title, graphId } = args;

    try {
      const dbFile = expandPath(DEFAULT_DB_PATH);
      const db = new Database(dbFile, { readonly: true });

      const stmt = db.prepare(`
        SELECT id, subject, documentText, tags, editedAt, createdAt
        FROM notes 
        WHERE isDeleted = 0 AND graphId = ? AND subject = ?
      `);

      const result = stmt.get(graphId, title) as any;
      db.close();

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Note '${title}' not found`, title, graphId }),
            },
          ],
        };
      }

      const note = {
        id: result.id,
        subject: result.subject,
        documentText: result.documentText,
        tags: result.tags ? JSON.parse(result.tags) : [],
        editedAt: formatDate(result.editedAt),
        createdAt: formatDate(result.createdAt),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ title, graphId, note }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

// Tool: Create a new note in Reflect via API
server.addTool({
  name: "create_note",
  description: "Create a new note in Reflect. Must add the tasks field if there are any actionable items to add. Pass in the user's timezone to ensure the note is created with the correct date. Check what tags the user has already created, and determine which tag to use for this content, or create a new tag if no tags fit the content.",
  parameters: z.object({
    subject: z.string().describe("The title/subject of the note. Example: 'Meeting Summary - Project Planning'"),
    content: z.string().describe("The markdown content for the note. This is the main body of the note."),
    graph_id: z.string().describe("The unique identifier of the Reflect graph where the note should be created."),
    timezone: z.string().describe("The user's timezone in IANA format. Example: 'America/New_York', 'Europe/London', 'Asia/Tokyo'. Used to determine the correct date for the daily note backlink."),
    tag: z.string().describe("The tag to add to the note. Example: 'personal'"),
    tasks: z.array(z.string()).optional().describe("A list of tasks to add to the note. Must add this field if there are any actionable items. Example: ['Review PR', 'Schedule meeting']"),
  }),
  execute: async (args, { session }) => {
    if (!session) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Not authenticated. Please complete OAuth flow first." }),
          },
        ],
      };
    }

    const { accessToken } = session as { accessToken: string };
    const { subject, content, graph_id, timezone, tag, tasks } = args;

    // Get today's date in the user's timezone
    const todayDate = getDateForTimezone(timezone);

    // Build the content with backlinked date at top and nested list format
    const contentParts: string[] = [];
    
    // Add the tag as backlink
    contentParts.push(`#ai-generated\n`);
    contentParts.push(`- [[${tag}]]\n`);
    
    // Add content as indented block under the date
    // Each line of content needs to be indented with 2 spaces to stay nested
    const contentLines = content.split('\n');
    const indentedContent = contentLines.map(line => `  ${line}`).join('\n');
    contentParts.push(indentedContent);
    
    // Add tasks as indented list items if provided
    if (tasks && tasks.length > 0) {
      contentParts.push('');
      contentParts.push('  ## Tasks');
      const formattedTasks = tasks.map(task => `  - + ${task}`).join('\n');
      contentParts.push(formattedTasks);
    }
    
    const fullContent = contentParts.join('\n');

    try {
      const response = await fetch(`https://reflect.app/api/graphs/${graph_id}/notes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subject: subject,
          content_markdown: fullContent,
          pinned: false,
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      
      const data = await response.json();
      
      // Append a backlink to this note in the daily notes under the tag
      const dailyNoteResponse = await fetch(`https://reflect.app/api/graphs/${graph_id}/daily-notes`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date: todayDate,
          text: `[[${subject}]]`,
          transform_type: "list-append",
          list_name: `[[${tag}]]`,
        }),
      });
      
      if (!dailyNoteResponse.ok) {
        const errorText = await dailyNoteResponse.text();
        console.error(`Failed to append to daily notes: ${dailyNoteResponse.status}, ${errorText}`);
        // Don't throw - the note was still created successfully
      }
      
      const message = `Note "${subject}" created with tag [[${tag}]]${tasks?.length ? ` and ${tasks.length} task(s)` : ''} and linked in daily notes`;
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              note: data,
              message: message
            }, null, 2),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: String(e) }),
          },
        ],
      };
    }
  },
});

await server.start({
  httpStream: { port: 3000 },
  transportType: "httpStream",
});

console.log(`
🚀 Reflect MCP Server is running on http://localhost:3000

=== OAuth Endpoints ===
Protected Resource Metadata: http://localhost:3000/.well-known/oauth-protected-resource
Authorization Server Metadata: http://localhost:3000/.well-known/oauth-authorization-server
OAuth Callback URL: http://localhost:3000/oauth/callback
OAuth Register (DCR): http://localhost:3000/oauth/register
OAuth Authorize: http://localhost:3000/oauth/authorize
OAuth Token: http://localhost:3000/oauth/token

=== Auth Server Config ===
Issuer: ${authServerMetadata.issuer}
Authorization Endpoint: ${authServerMetadata.authorizationEndpoint}
Token Endpoint: ${authServerMetadata.tokenEndpoint}
`);
