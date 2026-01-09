/**
 * Reflect MCP Tools
 * 
 * All tools for interacting with Reflect notes
 */

import { FastMCP } from "fastmcp";
import { z } from "zod";
import Database from "better-sqlite3";
import { DEFAULT_DB_PATH, expandPath, stripHtml, formatDate, getDateForTimezone } from "../utils.js";

export function registerTools(server: FastMCP, dbPath?: string): void {
  const resolvedDbPath = expandPath(dbPath || DEFAULT_DB_PATH);
  // Tool: Get all Reflect graphs
  server.addTool({
    name: "get_graphs",
    description: "Get a list of all Reflect graphs.",
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
    description: "Get backlinks for a note from Reflect. Use  this tool to get more context about a note after calling the get_note tool.",
    parameters: z.object({
      subject: z.string().describe("The subject/title of the note to get backlinks for"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
      limit: z.number().default(10).describe("Maximum number of backlinks to return"),
    }),
    execute: async (args) => {
      const { subject, graph_id, limit } = args;

      try {
        const dbFile = resolvedDbPath;
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

        const results = stmt.all(subject, graph_id, limit) as any[];
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
              text: JSON.stringify({ subject, graph_id, backlinks }, null, 2),
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
    description: "Get the most recent daily notes from Reflect.",
    parameters: z.object({
      limit: z.number().default(5).describe("Number of recent daily notes to return"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    }),
    execute: async (args) => {
      const { limit, graph_id } = args;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        const stmt = db.prepare(`
          SELECT id, subject, documentText, editedAt, tags, dailyDate, graphId
          FROM notes 
          WHERE isDaily = 1 AND isDeleted = 0 AND LENGTH(documentText) > 0 AND graphId = ?
          ORDER BY dailyDate DESC
          LIMIT ?
        `);

        const rows = stmt.all(graph_id, limit) as any[];
        db.close();

        const dailyNotes = rows.map((row) => ({
          id: row.id,
          subject: row.subject,
          documentText: row.documentText?.slice(0, 500) || "",
          editedAt: formatDate(row.editedAt),
          tags: row.tags ? JSON.parse(row.tags) : [],
          dailyDate: formatDate(row.dailyDate),
          graph_id: row.graphId,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ graph_id, count: dailyNotes.length, dailyNotes }, null, 2),
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
    description: "Get the daily note for a specific date.",
    parameters: z.object({
      date: z.string().describe("The date in YYYY-MM-DD format"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    }),
    execute: async (args) => {
      const { date, graph_id } = args;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        const dateObj = new Date(date + "T00:00:00");
        const dateMs = dateObj.getTime();

        const stmt = db.prepare(`
          SELECT id, subject, documentText, editedAt, tags, dailyDate, graphId
          FROM notes 
          WHERE isDaily = 1 AND isDeleted = 0 AND graphId = ? AND dailyDate = ?
        `);

        const result = stmt.get(graph_id, dateMs) as any;
        db.close();

        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `No daily note found for ${date}`, date, graph_id }),
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
          graph_id: result.graph_id,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ date, graph_id, dailyNote }, null, 2),
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
    description: "Get notes that have at least a minimum number of backlinks from Reflect.",
    parameters: z.object({
      minBacklinks: z.number().default(5).describe("Minimum number of backlinks a note must have"),
      limit: z.number().default(10).describe("Maximum number of notes to return"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    }),
    execute: async (args) => {
      const { minBacklinks, limit, graph_id } = args;

      try {
        const dbFile = resolvedDbPath;
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

        const results = stmt.all(graph_id, minBacklinks, limit) as any[];
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
              text: JSON.stringify({ graph_id, minBacklinks, count: notes.length, notes }, null, 2),
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
    description: "Get all unique tags with their usage counts from Reflect.",
    parameters: z.object({
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
      limit: z.number().default(50).describe("Maximum number of tags to return"),
    }),
    execute: async (args) => {
      const { graph_id, limit } = args;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        const stmt = db.prepare(`
          SELECT tags FROM notes 
          WHERE isDeleted = 0 AND graphId = ? AND tags IS NOT NULL AND tags != '[]'
        `);

        const rows = stmt.all(graph_id) as any[];
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

        const sortedTags = Object.entries(tagCounts)
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ graph_id, totalTags: Object.keys(tagCounts).length, tags: sortedTags }, null, 2),
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
    description: "Get notes that have a specific tag from Reflect.",
    parameters: z.object({
      tag: z.string().describe("The tag to search for"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
      limit: z.number().default(20).describe("Maximum number of notes to return"),
    }),
    execute: async (args) => {
      const { tag, graph_id, limit } = args;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        const stmt = db.prepare(`
          SELECT id, subject, tags, editedAt, LENGTH(documentText) as docLen, documentText
          FROM notes 
          WHERE isDeleted = 0 AND graphId = ? AND tags LIKE ?
          ORDER BY editedAt DESC
          LIMIT ?
        `);

        const results = stmt.all(graph_id, `%"${tag}"%`, limit) as any[];
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
              text: JSON.stringify({ tag, graph_id, count: notes.length, notes }, null, 2),
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

  // Tool: Get a note by title (exact match first, then fuzzy fallback)
  server.addTool({
    name: "get_note",
    description: "Get a note by its title (subject) from Reflect.",
    parameters: z.object({
      title: z.string().describe("The title/subject of the note to retrieve"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
    }),
    execute: async (args) => {
      const { title, graph_id } = args;
      const FUZZY_LIMIT = 3;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        // Try exact match first
        const exactStmt = db.prepare(`
          SELECT id, subject, documentText, tags, editedAt, createdAt
          FROM notes 
          WHERE isDeleted = 0 AND graphId = ? AND subject = ?
        `);
        const exactResult = exactStmt.get(graph_id, title) as any;

        if (exactResult) {
          db.close();
          const note = {
            id: exactResult.id,
            subject: exactResult.subject,
            documentText: exactResult.documentText,
            tags: exactResult.tags ? JSON.parse(exactResult.tags) : [],
            editedAt: formatDate(exactResult.editedAt),
            createdAt: formatDate(exactResult.createdAt),
          };
          return {
            content: [
              {
                type: "text" as const,
                  text: JSON.stringify({ title, graph_id, note }, null, 2),
              },
            ],
          };
        }

        // No exact match - try fuzzy search
        const searchTerm = title.toLowerCase();
        const fuzzyStmt = db.prepare(`
          SELECT id, subject, documentText, tags, editedAt, createdAt,
            CASE 
              WHEN LOWER(subject) LIKE ? THEN 2
              WHEN LOWER(subject) LIKE ? THEN 1
              ELSE 0
            END as relevance
          FROM notes 
          WHERE isDeleted = 0 
            AND graphId = ? 
            AND (LOWER(subject) LIKE ? OR LOWER(subject) LIKE ?)
          ORDER BY relevance DESC, editedAt DESC
          LIMIT ?
        `);

        const fuzzyResults = fuzzyStmt.all(
          `${searchTerm}%`,     // starts with (score 2)
          `%${searchTerm}%`,    // contains (score 1)
          graph_id,
          `${searchTerm}%`,     // WHERE starts with
          `%${searchTerm}%`,    // WHERE contains
          FUZZY_LIMIT
        ) as any[];

        db.close();

        if (fuzzyResults.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ 
                  error: `No notes found matching '${title}'`, 
                  query: title, 
                  graph_id 
                }),
              },
            ],
          };
        }

        const notes = fuzzyResults.map((result: any) => ({
          id: result.id,
          subject: result.subject,
          documentText: result.documentText,
          tags: result.tags ? JSON.parse(result.tags) : [],
          editedAt: formatDate(result.editedAt),
          createdAt: formatDate(result.createdAt),
        }));

        // If only one fuzzy match, return it directly
        if (notes.length === 1) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ 
                  query: title, 
                  graph_id, 
                  note: notes[0],
                  matchType: "fuzzy" 
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ 
                query: title, 
                graph_id, 
                matchCount: notes.length,
                notes 
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

  // Tool: Search notes by subject (fuzzy search with multi-word support)
  server.addTool({
    name: "search_notes",
    description: "Search for notes by subject/title using fuzzy matching. Returns notes whose subjects match the search query.",
    parameters: z.object({
      query: z.string().describe("The search query to match against note subjects"),
      graph_id: z.string().default("rapheal-brain").describe("The graph ID to search in"),
      limit: z.number().default(10).describe("Maximum number of notes to return"),
      include_content: z.boolean().default(false).describe("Whether to search in note content as well as subjects"),
    }),
    execute: async (args) => {
      const { query, graph_id, limit, include_content } = args;

      try {
        const dbFile = resolvedDbPath;
        const db = new Database(dbFile, { readonly: true });

        // Split query into terms, treating dots, dashes, underscores as word separators
        // Filter out empty strings and very short terms
        const searchTerms = query
          .toLowerCase()
          .split(/[\s.,\-_\/\\]+/)
          .filter(term => term.length >= 2);

        if (searchTerms.length === 0) {
          db.close();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Search query too short or empty", query }),
              },
            ],
          };
        }

        // Build dynamic WHERE clause - notes must contain ALL search terms
        // in either subject or content (if include_content is true)
        const whereConditions: string[] = [];
        const params: any[] = [];

        for (const term of searchTerms) {
          if (include_content) {
            whereConditions.push(`(LOWER(subject) LIKE ? OR LOWER(documentText) LIKE ?)`);
            params.push(`%${term}%`, `%${term}%`);
          } else {
            whereConditions.push(`LOWER(subject) LIKE ?`);
            params.push(`%${term}%`);
          }
        }

        // Build relevance scoring - higher score for more matches in subject
        const relevanceParts: string[] = [];
        for (const term of searchTerms) {
          relevanceParts.push(`CASE WHEN LOWER(subject) LIKE '%${term}%' THEN 20 ELSE 0 END`);
          if (include_content) {
            relevanceParts.push(`CASE WHEN LOWER(documentText) LIKE '%${term}%' THEN 5 ELSE 0 END`);
          }
        }
        // Bonus for exact phrase match
        const fullQuery = query.toLowerCase();
        relevanceParts.push(`CASE WHEN LOWER(subject) = '${fullQuery}' THEN 100 ELSE 0 END`);
        relevanceParts.push(`CASE WHEN LOWER(subject) LIKE '${fullQuery}%' THEN 50 ELSE 0 END`);
        relevanceParts.push(`CASE WHEN LOWER(subject) LIKE '%${fullQuery}%' THEN 30 ELSE 0 END`);

        const relevanceExpr = relevanceParts.join(' + ');

        const sql = `
          SELECT id, subject, documentText, tags, editedAt, createdAt, isDaily,
            (${relevanceExpr}) as relevance
          FROM notes 
          WHERE isDeleted = 0 
            AND graphId = ?
            AND (${whereConditions.join(' AND ')})
          ORDER BY relevance DESC, editedAt DESC
          LIMIT ?
        `;

        const stmt = db.prepare(sql);
        const results = stmt.all(graph_id, ...params, limit) as any[];
        db.close();

        const notes = results.map((row: any) => ({
          id: row.id,
          subject: row.subject,
          preview: row.documentText?.slice(0, 200) || "",
          tags: row.tags ? JSON.parse(row.tags) : [],
          editedAt: formatDate(row.editedAt),
          isDaily: row.isDaily === 1,
          relevance: row.relevance,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ 
                query, 
                searchTerms,
                graph_id, 
                searchedContent: include_content,
                count: notes.length, 
                notes 
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

      const todayDate = getDateForTimezone(timezone);

      const contentParts: string[] = [];
      contentParts.push(`#ai-generated\n`);
      contentParts.push(`- [[${tag}]]\n`);
      
      const contentLines = content.split('\n');
      const indentedContent = contentLines.map(line => `  ${line}`).join('\n');
      contentParts.push(indentedContent);
      
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
}

