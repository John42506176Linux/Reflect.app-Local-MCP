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
const platform = os.platform();

// macOS LaunchAgent paths
const LAUNCH_AGENT_LABEL = "com.reflect-mcp";
const LAUNCH_AGENT_DIR = path.join(os.homedir(), "Library/LaunchAgents");
const LAUNCH_AGENT_PATH = path.join(LAUNCH_AGENT_DIR, `${LAUNCH_AGENT_LABEL}.plist`);

// Linux systemd user service paths
const SYSTEMD_SERVICE_NAME = "reflect-mcp";
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config/systemd/user");
const SYSTEMD_SERVICE_PATH = path.join(SYSTEMD_USER_DIR, `${SYSTEMD_SERVICE_NAME}.service`);

function requireSupportedPlatform(): void {
  if (platform !== "darwin" && platform !== "linux") {
    console.error(`❌ Service management is not supported on ${platform}.`);
    console.error("   Supported platforms: macOS (darwin), Linux");
    console.error("   You can still run the server directly: reflect-mcp [db-path]");
    process.exit(1);
  }
}

// Get the command and arguments
const args = process.argv.slice(2);
const command = args[0];

// Handle commands
(async () => {
  if (command === "install") {
    requireSupportedPlatform();
    await install(args.slice(1));
  } else if (command === "uninstall") {
    requireSupportedPlatform();
    uninstall();
  } else if (command === "status") {
    requireSupportedPlatform();
    status();
  } else if (command === "--help" || command === "-h") {
    showHelp();
  } else {
    // Default: run the server
    await runServer(args);
  }
})();

function showHelp(): void {
  const dbDefault = DEFAULT_DB_PATH
    ? `(default: ${DEFAULT_DB_PATH})`
    : "(required on Linux — no default path)";

  console.log(`
Reflect MCP Server - Connect your Reflect notes to Claude

Usage:
  reflect-mcp [db-path] [--port <port>]     Run the server
  reflect-mcp install [db-path]             Install as auto-start service
  reflect-mcp uninstall                     Remove auto-start service
  reflect-mcp status                        Check service status

Arguments:
  db-path     Path to Reflect SQLite database
              ${dbDefault}

Options:
  --port <port>   Port to run server on (default: 3000)

Examples:
  reflect-mcp install                       # Install with default db path (macOS)
  reflect-mcp install ~/my/reflect/db       # Install with custom db path
  reflect-mcp uninstall                     # Remove auto-start
  reflect-mcp                               # Run server manually
`);
  process.exit(0);
}

async function install(installArgs: string[]): Promise<void> {
  let dbPath: string | undefined;
  let port = 3000;

  // Parse install arguments
  for (let i = 0; i < installArgs.length; i++) {
    if (installArgs[i] === "--port" && installArgs[i + 1]) {
      port = parseInt(installArgs[++i]);
    } else if (!installArgs[i].startsWith("--")) {
      dbPath = installArgs[i];
    }
  }

  // On Linux there's no known default path -- require explicit db-path
  if (!dbPath) {
    if (platform === "linux") {
      console.error("❌ On Linux, you must specify the database path:");
      console.error("   reflect-mcp install /path/to/reflect.db");
      process.exit(1);
    }
    dbPath = DEFAULT_DB_PATH;
  }

  const expandedDbPath = expandPath(dbPath);
  const nodePath = process.execPath;
  const cliPath = process.argv[1];

  console.log("📦 Installing Reflect MCP Server as auto-start service...\n");

  if (platform === "darwin") {
    installDarwin(nodePath, cliPath, expandedDbPath, port);
  } else {
    installLinux(nodePath, cliPath, expandedDbPath, port);
  }

  console.log(`🚀 Reflect MCP Server will now auto-start on login`);
  console.log(`   Server: http://localhost:${port}`);
  console.log(`   Database: ${expandedDbPath}`);
  if (platform === "darwin") {
    console.log(`   Logs: tail -f /tmp/reflect-mcp.log\n`);
  } else {
    console.log(`   Logs: journalctl --user -u ${SYSTEMD_SERVICE_NAME} -f\n`);
  }

  console.log(`📋 Add to Claude Desktop config (~/.config/claude/claude_desktop_config.json):`);
  console.log(`{
  "mcpServers": {
    "reflect": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:${port}/mcp", "--port", "4209"]
    }
  }
}`);
  console.log(`   Note: Make sure the port (${port}) matches the port you used when installing the server.`);
  console.log(`   Important: Add "--port", "4209" (or a different port like "4210", "4211", etc.) to avoid conflicts if you have multiple MCP clients running.`);
}

function installDarwin(nodePath: string, cliPath: string, expandedDbPath: string, port: number): void {
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

  fs.writeFileSync(LAUNCH_AGENT_PATH, plist);
  console.log(`✅ Created: ${LAUNCH_AGENT_PATH}`);

  try {
    execSync(`launchctl load ${LAUNCH_AGENT_PATH}`);
    execSync(`launchctl start ${LAUNCH_AGENT_LABEL}`);
    console.log("✅ Service installed and started!\n");
  } catch (error) {
    console.error("❌ Failed to start service:", error);
    process.exit(1);
  }
}

function installLinux(nodePath: string, cliPath: string, expandedDbPath: string, port: number): void {
  if (!fs.existsSync(SYSTEMD_USER_DIR)) {
    fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  }

  // Stop existing service if running
  try {
    execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME} 2>/dev/null`, { stdio: "ignore" });
    execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME} 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Ignore errors - service might not exist yet
  }

  const unit = `[Unit]
Description=Reflect MCP Server
After=network.target

[Service]
ExecStart=${nodePath} ${cliPath} ${expandedDbPath} --port ${port}
Restart=always
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(SYSTEMD_SERVICE_PATH, unit);
  console.log(`✅ Created: ${SYSTEMD_SERVICE_PATH}`);

  try {
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}`);
    console.log("✅ Service installed and started!\n");
  } catch (error) {
    console.error("❌ Failed to start service:", error);
    console.error("   Make sure systemd user services are available (systemctl --user).");
    process.exit(1);
  }
}

function uninstall(): void {
  console.log("🗑️  Removing Reflect MCP Server auto-start service...\n");

  if (platform === "darwin") {
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
  } else {
    try {
      execSync(`systemctl --user disable --now ${SYSTEMD_SERVICE_NAME} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }

    if (fs.existsSync(SYSTEMD_SERVICE_PATH)) {
      fs.unlinkSync(SYSTEMD_SERVICE_PATH);
      console.log(`✅ Removed: ${SYSTEMD_SERVICE_PATH}`);
    }

    try {
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    } catch {
      // Ignore errors
    }
  }

  console.log("✅ Service uninstalled. Server will no longer auto-start.");
}

function status(): void {
  console.log("📊 Reflect MCP Server Status\n");

  if (platform === "darwin") {
    statusDarwin();
  } else {
    statusLinux();
  }
}

function statusDarwin(): void {
  if (fs.existsSync(LAUNCH_AGENT_PATH)) {
    console.log(`✅ Launch Agent installed: ${LAUNCH_AGENT_PATH}`);
  } else {
    console.log("❌ Launch Agent not installed");
    console.log("   Run: reflect-mcp install");
    return;
  }

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

function statusLinux(): void {
  if (!fs.existsSync(SYSTEMD_SERVICE_PATH)) {
    console.log("❌ Systemd service not installed");
    console.log("   Run: reflect-mcp install /path/to/reflect.db");
    return;
  }

  console.log(`✅ Systemd service installed: ${SYSTEMD_SERVICE_PATH}`);

  try {
    const result = execSync(
      `systemctl --user is-active ${SYSTEMD_SERVICE_NAME} 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();

    if (result === "active") {
      console.log("✅ Service running");
    } else {
      console.log(`⚠️  Service not active (state: ${result})`);
    }
  } catch {
    // is-active exits non-zero when inactive/failed
    try {
      const result = execSync(
        `systemctl --user show ${SYSTEMD_SERVICE_NAME} --property=ActiveState --value 2>/dev/null`,
        { encoding: "utf-8" },
      ).trim();
      console.log(`❌ Service ${result || "not loaded"}`);
    } catch {
      console.log("❌ Service not loaded");
    }
  }

  console.log(`\n📝 Logs: journalctl --user -u ${SYSTEMD_SERVICE_NAME} -f`);
}

async function runServer(serverArgs: string[]): Promise<void> {
  let dbPath: string | undefined;
  let requestedPort = 3000;

  for (let i = 0; i < serverArgs.length; i++) {
    if (serverArgs[i] === "--port" && serverArgs[i + 1]) {
      requestedPort = parseInt(serverArgs[++i]);
    } else if (!serverArgs[i].startsWith("--")) {
      dbPath = serverArgs[i];
    }
  }

  if (!dbPath) {
    if (platform === "linux") {
      console.error("❌ On Linux, you must specify the database path:");
      console.error("   reflect-mcp /path/to/reflect.db");
      process.exit(1);
    }
    dbPath = DEFAULT_DB_PATH;
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
