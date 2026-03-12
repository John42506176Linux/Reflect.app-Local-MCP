#!/usr/bin/env node
/**
 * Reflect MCP Server - CLI Entry Point
 * 
 * Run with: npx reflect-mcp <db-path>
 * Install: npx reflect-mcp install <db-path>
 */

import { startReflectMCPServer } from "./server.js";
import { DEFAULT_DB_PATH, expandPath } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import { execSync } from "child_process";

/**
 * Check if a port is in use
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find a free port starting from startPort.
 * Returns the first available port within maxAttempts tries,
 * or throws if none is found.
 */
async function findFreePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = startPort + i;
    if (!(await isPortInUse(candidate))) {
      return candidate;
    }
  }
  throw new Error(
    `No free port found in range ${startPort}–${startPort + maxAttempts - 1}`
  );
}


const REFLECT_CLIENT_ID = "55798f25d5a24efb95e4174fff3d219e";
const LAUNCH_AGENT_LABEL = "com.reflect-mcp";
const LAUNCH_AGENT_DIR = path.join(os.homedir(), "Library/LaunchAgents");
const LAUNCH_AGENT_PATH = path.join(LAUNCH_AGENT_DIR, `${LAUNCH_AGENT_LABEL}.plist`);

// Get the command and arguments
const args = process.argv.slice(2);
const command = args[0];

// Handle commands
(async () => {
  if (command === "install") {
    await install(args.slice(1));
  } else if (command === "uninstall") {
    uninstall();
  } else if (command === "status") {
    status();
  } else if (command === "--help" || command === "-h") {
    showHelp();
  } else {
    // Default: run the server
    await runServer(args);
  }
})();

function showHelp(): void {
  console.log(`
Reflect MCP Server - Connect your Reflect notes to Claude

Usage:
  reflect-mcp [db-path] [--port <port>]     Run the server
  reflect-mcp install [db-path]             Install as auto-start service
  reflect-mcp uninstall                     Remove auto-start service
  reflect-mcp status                        Check service status

Arguments:
  db-path     Path to Reflect SQLite database
              (default: ${DEFAULT_DB_PATH})

Options:
  --port <port>   Port to run server on (default: 3000)

Examples:
  reflect-mcp install                       # Install with default db path
  reflect-mcp install ~/my/reflect/db       # Install with custom db path
  reflect-mcp uninstall                     # Remove auto-start
  reflect-mcp                               # Run server manually
`);
  process.exit(0);
}

async function install(installArgs: string[]): Promise<void> {
  let dbPath = DEFAULT_DB_PATH;
  let port = 3000;

  // Parse install arguments
  for (let i = 0; i < installArgs.length; i++) {
    if (installArgs[i] === "--port" && installArgs[i + 1]) {
      port = parseInt(installArgs[++i]);
    } else if (!installArgs[i].startsWith("--")) {
      dbPath = installArgs[i];
    }
  }

  const expandedDbPath = expandPath(dbPath);
  const nodePath = process.execPath;
  const cliPath = process.argv[1];

  console.log("📦 Installing Reflect MCP Server as auto-start service...\n");

  // Create Launch Agent directory if needed
  if (!fs.existsSync(LAUNCH_AGENT_DIR)) {
    fs.mkdirSync(LAUNCH_AGENT_DIR, { recursive: true });
  }

  // Stop existing service if running
  try {
    execSync(`launchctl stop ${LAUNCH_AGENT_LABEL} 2>/dev/null`, { stdio: "ignore" });
    execSync(`launchctl unload ${LAUNCH_AGENT_PATH} 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Ignore errors - service might not exist yet
  }

  // Create plist content
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
        <string>${expandedDbPath}</string>
        <string>--port</string>
        <string>${port}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/reflect-mcp.log</string>
    <key>StandardOutPath</key>
    <string>/tmp/reflect-mcp.log</string>
</dict>
</plist>`;

  // Write plist file
  fs.writeFileSync(LAUNCH_AGENT_PATH, plist);
  console.log(`✅ Created: ${LAUNCH_AGENT_PATH}`);

  // Load and start the service
  try {
    execSync(`launchctl load ${LAUNCH_AGENT_PATH}`);
    execSync(`launchctl start ${LAUNCH_AGENT_LABEL}`);
    console.log("✅ Service installed and started!\n");
  } catch (error) {
    console.error("❌ Failed to start service:", error);
    process.exit(1);
  }

  console.log(`🚀 Reflect MCP Server will now auto-start on login`);
  console.log(`   Server: http://localhost:${port}`);
  console.log(`   Database: ${expandedDbPath}`);
  console.log(`   Logs: tail -f /tmp/reflect-mcp.log\n`);

  console.log(`📋 Add to Claude Desktop config (~/.config/claude/claude_desktop_config.json):`);
  console.log(`{
  "mcpServers": {
    "reflect": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "--port", "4209", "http://localhost:${port}/mcp"]
    }
  }
}`);
  console.log(`   Note: Make sure the port (${port}) matches the port you used when installing the server.`);
  console.log(`   Important: Add "--port", "4209" (or a different port like "4210", "4211", etc.) to avoid conflicts if you have multiple MCP clients running.`);
}

function uninstall(): void {
  console.log("🗑️  Removing Reflect MCP Server auto-start service...\n");

  try {
    execSync(`launchctl stop ${LAUNCH_AGENT_LABEL} 2>/dev/null`, { stdio: "ignore" });
    execSync(`launchctl unload ${LAUNCH_AGENT_PATH} 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Ignore errors
  }

  if (fs.existsSync(LAUNCH_AGENT_PATH)) {
    fs.unlinkSync(LAUNCH_AGENT_PATH);
    console.log(`✅ Removed: ${LAUNCH_AGENT_PATH}`);
  }

  console.log("✅ Service uninstalled. Server will no longer auto-start.");
}

function status(): void {
  console.log("📊 Reflect MCP Server Status\n");

  // Check if plist exists
  if (fs.existsSync(LAUNCH_AGENT_PATH)) {
    console.log(`✅ Launch Agent installed: ${LAUNCH_AGENT_PATH}`);
  } else {
    console.log("❌ Launch Agent not installed");
    console.log("   Run: reflect-mcp install");
    return;
  }

  // Check if service is running
  try {
    const result = execSync(`launchctl list | grep ${LAUNCH_AGENT_LABEL}`, { encoding: "utf-8" });
    if (result.includes(LAUNCH_AGENT_LABEL)) {
      const parts = result.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      
      if (pid !== "-") {
        console.log(`✅ Service running (PID: ${pid})`);
      } else if (exitCode === "0") {
        console.log("⚠️  Service stopped (last exit: success)");
      } else {
        console.log(`❌ Service stopped (last exit code: ${exitCode})`);
      }
    }
  } catch {
    console.log("❌ Service not loaded");
  }

  console.log(`\n📝 Logs: tail -f /tmp/reflect-mcp.log`);
}

async function runServer(serverArgs: string[]): Promise<void> {
  let dbPath = DEFAULT_DB_PATH;
  let requestedPort = 3000;

  for (let i = 0; i < serverArgs.length; i++) {
    if (serverArgs[i] === "--port" && serverArgs[i + 1]) {
      requestedPort = parseInt(serverArgs[++i]);
    } else if (!serverArgs[i].startsWith("--")) {
      dbPath = serverArgs[i];
    }
  }

  // Find the first free port at or above the requested port.
  // This allows multiple MCP clients to each get their own HTTP server
  // without killing other running instances.
  let port: number;
  try {
    port = await findFreePort(requestedPort);
  } catch (err) {
    console.error(`[reflect-mcp] ${err}`);
    process.exit(1);
  }

  if (port !== requestedPort) {
    console.error(
      `[reflect-mcp] Requested port ${requestedPort} is in use — using port ${port} instead`
    );
  }

  try {
    await startReflectMCPServer({
      clientId: REFLECT_CLIENT_ID,
      port,
      dbPath,
    });
    console.error(`[reflect-mcp] HTTP server running on http://localhost:${port}`);
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}
