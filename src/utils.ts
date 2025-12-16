/**
 * Utility functions for the Reflect MCP Server
 */

import * as path from "path";
import * as os from "os";

// Reflect local database path
export const DEFAULT_DB_PATH = "~/Library/Application Support/Reflect/File System/000/t/00/00000000";

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

