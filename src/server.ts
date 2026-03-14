/**
 * Reflect MCP Server Factory
 * 
 * Updated by Twice 🦸‍♂️
 * Now handling multiple concurrent clients!
 * 
 * Creates and configures the FastMCP server with PKCE OAuth
 */

import { FastMCP } from "fastmcp";
import { PKCEOAuthProxy } from "./pkcehandler.js";
import { registerTools } from "./tools/index.js";

export interface ServerConfig {
  clientId: string;
  port?: number;
  dbPath?: string;
}

export async function startReflectMCPServer(config: ServerConfig): Promise<void> {
  const port = config.port || 3000;
  const baseUrl = `http://localhost:${port}`;

  // Create PKCE OAuth Proxy (no client_secret required!)
  const pkceProxy = new PKCEOAuthProxy({
    baseUrl,
    clientId: config.clientId,
    authorizationEndpoint: "https://reflect.app/oauth",
    tokenEndpoint: "https://reflect.app/api/oauth/token",
    scopes: ["read:graph", "write:graph"],
  });

  // Get auth server metadata
  const authServerMetadata = pkceProxy.getAuthorizationServerMetadata();

  // Create FastMCP server
  const server = new FastMCP({
    name: "Reflect MCP Server",
    oauth: {
      authorizationServer: authServerMetadata,
      enabled: true,
      protectedResource: {
        resource: baseUrl,
        authorizationServers: [authServerMetadata.issuer],
        scopesSupported: ["read:graph", "write:graph"],
      },
      proxy: pkceProxy as any,
    },
    authenticate: async (request) => {
      const authHeader = request.headers.authorization;

      if (!authHeader?.startsWith("Bearer ")) {
        console.warn("[Auth] Missing or invalid Authorization header - triggering 401");
        // Throw Response to trigger re-authentication (per FastMCP docs)
        throw new Response(null, {
          status: 401,
          statusText: "Unauthorized - Bearer token required",
        });
      }

      const token = authHeader.slice(7);

      try {
        const tokenData = await pkceProxy.loadUpstreamTokens(token);

        if (!tokenData) {
          console.warn("[Auth] Token validation failed for:", token.slice(0, 8) + "... - triggering 401");
          // Throw Response to trigger re-authentication (per FastMCP docs)
          throw new Response(null, {
            status: 401,
            statusText: "Unauthorized - Invalid or expired token",
          });
        }

        console.log("[Auth] Token validated");

        return {
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
        };
      } catch (error) {
        // Re-throw if it's already a Response (our auth failures above)
        if (error instanceof Response) {
          throw error;
        }
        console.error("[Auth] Error validating token:", error);
        throw new Response(null, {
          status: 401,
          statusText: "Unauthorized - Token validation error",
        });
      }
    },
    version: "1.0.0",
  });

  // Register all tools (pass proxy so tools can invalidate tokens on upstream 401)
  registerTools(server, config.dbPath, pkceProxy);

  // Start server
  await server.start({
    httpStream: {
      port,
      stateless: false,
    },
    transportType: "httpStream",
  });
}

/**
 * Start the Reflect MCP server in stdio mode.
 * Used when an HTTP server is already running on the port (e.g. a second MCP client).
 * Reads the cached OAuth token from disk instead of running the full OAuth flow.
 */
export async function startReflectMCPServerStdio(config: ServerConfig): Promise<void> {
  const port = config.port || 3000;
  const baseUrl = `http://localhost:${port}`;

  // Instantiate proxy only to read tokens from disk — no HTTP server needed
  const pkceProxy = new PKCEOAuthProxy({
    baseUrl,
    clientId: config.clientId,
    authorizationEndpoint: "https://reflect.app/oauth",
    tokenEndpoint: "https://reflect.app/api/oauth/token",
    scopes: ["read:graph", "write:graph"],
  });

  const server = new FastMCP({
    name: "Reflect MCP Server",
    // For stdio, FastMCP calls authenticate(undefined). We load the token from disk.
    authenticate: async (_request) => {
      const tokenData = pkceProxy.getFirstValidToken();
      if (!tokenData) {
        console.error("[Auth] No valid token on disk. Connect via HTTP mode first to complete OAuth.");
        throw new Error("No valid token. Please authenticate via HTTP mode first.");
      }
      console.error("[Auth] Stdio mode: token loaded from disk");
      return {
        accessToken: tokenData.accessToken,
      };
    },
    version: "1.0.0",
  });

  registerTools(server, config.dbPath);

  await server.start({ transportType: "stdio" });
}

// Also export for programmatic use
export { PKCEOAuthProxy } from "./pkcehandler.js";
export * from "./utils.js";
