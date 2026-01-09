/**
 * Reflect MCP Server Factory
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
        const tokenData = pkceProxy.loadUpstreamTokens(token);
        
        if (!tokenData) {
          console.warn("[Auth] Token validation failed for:", token.slice(0, 8) + "... - triggering 401");
          // Throw Response to trigger re-authentication (per FastMCP docs)
          throw new Response(null, {
            status: 401,
            statusText: "Unauthorized - Invalid or expired token",
          });
        }

        const expiresIn = Math.floor((tokenData.expiresAt.getTime() - Date.now()) / 1000);
        console.log("[Auth] Token validated, expires in:", expiresIn, "seconds");

        return {
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresIn,
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

  // Register all tools
  registerTools(server, config.dbPath);

  // Start server
  await server.start({
    httpStream: { 
      port,
    },
    transportType: "httpStream",
  });
}

// Also export for programmatic use
export { PKCEOAuthProxy } from "./pkcehandler.js";
export * from "./utils.js";
