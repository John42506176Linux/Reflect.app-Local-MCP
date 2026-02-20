/**
 * Utility functions for the Reflect MCP Server
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Base path for Reflect local database
const REFLECT_BASE_PATH = "~/Library/Application Support/Reflect/File System";

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
 * Searches for the Reflect local database file
 * Returns the first valid database path found, or null if not found
 */
export function findLocalDatabase(): string | null {
  const basePath = expandPath(REFLECT_BASE_PATH);
  
  if (!fs.existsSync(basePath)) {
    return null;
  }
  
  // Search for database files in the File System directory
  // Structure is typically: File System/XXX/t/XX/XXXXXXXX
  try {
    const entries = fs.readdirSync(basePath);
    
    for (const entry of entries) {
      const entryPath = path.join(basePath, entry);
      const tPath = path.join(entryPath, "t");
      
      if (fs.existsSync(tPath) && fs.statSync(tPath).isDirectory()) {
        // Look for subdirectories in t/
        const tEntries = fs.readdirSync(tPath);
        
        for (const tEntry of tEntries) {
          const subPath = path.join(tPath, tEntry);
          
          if (fs.statSync(subPath).isDirectory()) {
            // Look for database files (8-char hex names)
            const dbFiles = fs.readdirSync(subPath);
            
            for (const dbFile of dbFiles) {
              const dbPath = path.join(subPath, dbFile);
              
              // Check if it's a valid SQLite database (starts with SQLite header)
              if (fs.statSync(dbPath).isFile()) {
                try {
                  const header = Buffer.alloc(16);
                  const fd = fs.openSync(dbPath, 'r');
                  fs.readSync(fd, header, 0, 16, 0);
                  fs.closeSync(fd);
                  
                  // SQLite files start with "SQLite format 3"
                  if (header.toString('utf8', 0, 15) === 'SQLite format 3') {
                    return dbPath;
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
  } catch {
    return null;
  }
  
  return null;
}

/**
 * Gets the default database path, searching for it if not provided
 */
export function getDefaultDbPath(): string {
  const found = findLocalDatabase();
  if (found) {
    return found;
  }
  // Fallback to a common path pattern
  return expandPath("~/Library/Application Support/Reflect/File System/000/t/00/00000000");
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
