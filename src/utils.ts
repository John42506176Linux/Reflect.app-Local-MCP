/**
 * Utility functions for the Reflect MCP Server
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Base path for Reflect local database (macOS only; no known Linux path)
const REFLECT_BASE_PATH = os.platform() === "darwin"
  ? "~/Library/Application Support/Reflect/File System"
  : null;

/**
 * Expands ~ to the user's home directory
 */
export function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Searches for the Reflect local database file.
 * Only works on macOS where the Reflect app path is known.
 * Returns the first valid database path found, or null if not found.
 */
export function findLocalDatabase(): string | null {
  if (!REFLECT_BASE_PATH) {
    return null;
  }

  const basePath = expandPath(REFLECT_BASE_PATH);
  
  if (!fs.existsSync(basePath)) {
    return null;
  }
  
  // Search for database files in the File System directory
  // Structure is typically: File System/XXX/t/XX/XXXXXXXX
  // Reflect may have multiple database partitions (000, 001, etc.)
  // so we find all SQLite files and return the most recently modified one.
  try {
    const entries = fs.readdirSync(basePath);
    let bestPath: string | null = null;
    let bestMtime = 0;
    
    for (const entry of entries) {
      const entryPath = path.join(basePath, entry);
      const tPath = path.join(entryPath, "t");
      
      if (fs.existsSync(tPath) && fs.statSync(tPath).isDirectory()) {
        const tEntries = fs.readdirSync(tPath);
        
        for (const tEntry of tEntries) {
          const subPath = path.join(tPath, tEntry);
          
          if (fs.statSync(subPath).isDirectory()) {
            const dbFiles = fs.readdirSync(subPath);
            
            for (const dbFile of dbFiles) {
              const dbPath = path.join(subPath, dbFile);
              
              if (fs.statSync(dbPath).isFile()) {
                try {
                  const header = Buffer.alloc(16);
                  const fd = fs.openSync(dbPath, 'r');
                  fs.readSync(fd, header, 0, 16, 0);
                  fs.closeSync(fd);
                  
                  if (header.toString('utf8', 0, 15) === 'SQLite format 3') {
                    const mtime = fs.statSync(dbPath).mtimeMs;
                    if (mtime > bestMtime) {
                      bestMtime = mtime;
                      bestPath = dbPath;
                    }
                  }
                } catch {
                  // Not a readable file, skip
                }
              }
            }
          }
        }
      }
    }
    
    return bestPath;
  } catch {
    return null;
  }
}

/**
 * Gets the default database path, searching for it if not provided.
 * Returns empty string on non-macOS platforms where no default is known.
 */
export function getDefaultDbPath(): string {
  const found = findLocalDatabase();
  if (found) {
    return found;
  }
  if (os.platform() === "darwin") {
    return expandPath("~/Library/Application Support/Reflect/File System/001/t/00/00000000");
  }
  return "";
}

// For backwards compatibility
export const DEFAULT_DB_PATH = getDefaultDbPath();

/**
 * Strips HTML tags from a string, converting <br> to newlines
 */
export function stripHtml(html: string | null): string {
  if (!html) return "";
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/\n\s*\n/g, "\n\n");
  return text.trim();
}

/**
 * Formats a timestamp in milliseconds to an ISO date string
 */
export function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

/**
 * Gets today's date in YYYY-MM-DD format for a specific timezone
 */
export function getDateForTimezone(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}
