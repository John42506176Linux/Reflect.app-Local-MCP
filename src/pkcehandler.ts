/**
 * PKCE OAuth Proxy (No Client Secret Required)
 * 
 * This module provides a custom OAuth proxy that uses PKCE for authentication
 * without requiring a client secret, suitable for public clients.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { OAuthProxyError } from "fastmcp/auth";

// ============================================================================
// Types
// ============================================================================

interface PKCETransaction {
  codeVerifier: string;
  codeChallenge: string;
  clientCallbackUrl: string;
  clientId: string;
  clientState: string;
  scope: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

// Serializable version for file storage
interface SerializedTokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO string
}

export interface PKCEOAuthProxyConfig {
  baseUrl: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  redirectPath?: string;
  tokenStoragePath?: string; // Path to persist tokens (default: ~/.reflect-mcp-tokens.json)
}

// ============================================================================
// PKCEOAuthProxy Class
// ============================================================================

export class PKCEOAuthProxy {
  private config: {
    baseUrl: string;
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    redirectPath: string;
    scopes: string[];
    tokenStoragePath: string;
  };
  
  // In-memory storage for transactions (short-lived, don't need persistence)
  private transactions = new Map<string, PKCETransaction>();
  // Token storage - persisted to disk
  private tokens = new Map<string, TokenData>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: PKCEOAuthProxyConfig) {
    this.config = {
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      authorizationEndpoint: options.authorizationEndpoint,
      tokenEndpoint: options.tokenEndpoint,
      redirectPath: options.redirectPath || "/oauth/callback",
      scopes: options.scopes,
      tokenStoragePath: options.tokenStoragePath || path.join(os.homedir(), ".reflect-mcp-tokens.json"),
    };
    this.loadTokensFromDisk();
    this.startCleanup();
  }

  // Load tokens from disk on startup
  private loadTokensFromDisk(): void {
    try {
      if (fs.existsSync(this.config.tokenStoragePath)) {
        const data = fs.readFileSync(this.config.tokenStoragePath, "utf-8");
        const stored = JSON.parse(data) as Record<string, SerializedTokenData>;
        
        for (const [key, value] of Object.entries(stored)) {
          const expiresAt = new Date(value.expiresAt);
          // Only load non-expired tokens
          if (expiresAt > new Date()) {
            this.tokens.set(key, {
              accessToken: value.accessToken,
              refreshToken: value.refreshToken,
              expiresAt,
            });
          }
        }
        console.log(`[PKCEProxy] Loaded ${this.tokens.size} tokens from disk`);
      }
    } catch (error) {
      console.warn("[PKCEProxy] Failed to load tokens from disk:", error);
    }
  }

  // Save tokens to disk
  private saveTokensToDisk(): void {
    try {
      const toStore: Record<string, SerializedTokenData> = {};
      for (const [key, value] of this.tokens) {
        toStore[key] = {
          accessToken: value.accessToken,
          refreshToken: value.refreshToken,
          expiresAt: value.expiresAt.toISOString(),
        };
      }
      fs.writeFileSync(this.config.tokenStoragePath, JSON.stringify(toStore, null, 2));
    } catch (error) {
      console.error("[PKCEProxy] Failed to save tokens to disk:", error);
    }
  }

  // Generate PKCE code verifier and challenge
  private generatePKCE(): { verifier: string; challenge: string } {
    // Generate a random code verifier (43-128 characters)
    const verifier = crypto.randomBytes(32).toString("base64url");
    
    // Create code challenge: BASE64URL(SHA256(code_verifier))
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    
    return { verifier, challenge };
  }

  private generateId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  // Get authorization server metadata for MCP clients
  getAuthorizationServerMetadata() {
    return {
      issuer: this.config.baseUrl,
      authorizationEndpoint: `${this.config.baseUrl}/oauth/authorize`,
      tokenEndpoint: `${this.config.baseUrl}/oauth/token`,
      registrationEndpoint: `${this.config.baseUrl}/oauth/register`,
      responseTypesSupported: ["code"],
      grantTypesSupported: ["authorization_code", "refresh_token"],
      codeChallengeMethodsSupported: ["S256"],
      scopesSupported: this.config.scopes,
    };
  }

  // Handle /oauth/authorize - redirect to upstream with PKCE
  async authorize(params: {
    client_id: string;
    redirect_uri: string;
    response_type: string;
    state?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }): Promise<Response> {
    console.log("[PKCEProxy] Authorize called with params:", params);
    
    if (params.response_type !== "code") {
      return new Response(JSON.stringify({ error: "unsupported_response_type" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Generate our own PKCE for upstream
    const pkce = this.generatePKCE();
    const transactionId = this.generateId();

    // Store transaction
    const transaction: PKCETransaction = {
      codeVerifier: pkce.verifier,
      codeChallenge: pkce.challenge,
      clientCallbackUrl: params.redirect_uri,
      clientId: params.client_id,
      clientState: params.state || this.generateId(),
      scope: params.scope ? params.scope.split(" ") : this.config.scopes,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600 * 1000), // 10 minutes
    };
    this.transactions.set(transactionId, transaction);
    console.log("[PKCEProxy] Created transaction:", transactionId);

    // Build upstream authorization URL
    const authUrl = new URL(this.config.authorizationEndpoint);
    authUrl.searchParams.set("client_id", this.config.clientId);
    authUrl.searchParams.set("redirect_uri", `${this.config.baseUrl}${this.config.redirectPath}`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", transaction.scope.join(","));
    authUrl.searchParams.set("state", transactionId); // Use transaction ID as state
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    console.log("[PKCEProxy] Redirecting to:", authUrl.toString());

    return new Response(null, {
      status: 302,
      headers: { Location: authUrl.toString() },
    });
  }

  // Handle /oauth/callback - exchange code for tokens
  // FastMCP passes a Request object, so we need to extract params from URL
  async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    
    console.log("[PKCEProxy] Callback received with state:", state, "code:", code ? "present" : "missing");

    if (!state) {
      console.error("[PKCEProxy] Missing state parameter");
      return new Response(JSON.stringify({ error: "missing_state" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!code) {
      console.error("[PKCEProxy] Missing code parameter");
      return new Response(JSON.stringify({ error: "missing_code" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const transaction = this.transactions.get(state);
    if (!transaction) {
      console.error("[PKCEProxy] Transaction not found for state:", state);
      console.error("[PKCEProxy] Available transactions:", Array.from(this.transactions.keys()));
      return new Response(JSON.stringify({ error: "invalid_state" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (transaction.expiresAt < new Date()) {
      this.transactions.delete(state);
      return new Response(JSON.stringify({ error: "transaction_expired" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Exchange code for tokens with upstream (NO client_secret!)
    console.log("[PKCEProxy] Exchanging code for tokens...");
    const tokenResponse = await fetch(this.config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: this.config.clientId,
        redirect_uri: `${this.config.baseUrl}${this.config.redirectPath}`,
        code_verifier: transaction.codeVerifier, // PKCE verifier, no secret!
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error("[PKCEProxy] Token exchange failed:", error);
      return new Response(JSON.stringify({ error: "token_exchange_failed", details: error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tokens = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    console.log("[PKCEProxy] Got tokens, expires_in:", tokens.expires_in);

    // Generate a proxy token to give to the client
    const proxyToken = this.generateId();
    this.tokens.set(proxyToken, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
    });
    this.saveTokensToDisk(); // Persist to disk

    // Redirect back to client with our proxy token
    const clientRedirect = new URL(transaction.clientCallbackUrl);
    clientRedirect.searchParams.set("code", proxyToken);
    clientRedirect.searchParams.set("state", transaction.clientState);

    // Clean up transaction
    this.transactions.delete(state);

    console.log("[PKCEProxy] Redirecting to client:", clientRedirect.toString());
    return new Response(null, {
      status: 302,
      headers: { Location: clientRedirect.toString() },
    });
  }

  // Handle /oauth/token - exchange proxy code for access token
  // FastMCP expects a TokenResponse object, not a Response
  async exchangeAuthorizationCode(params: {
    grant_type: string;
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier?: string;
    client_secret?: string;
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
  }> {
    console.log("[PKCEProxy] exchangeAuthorizationCode called with code:", params.code?.slice(0, 8) + "...");

    if (!params.code) {
      throw new OAuthProxyError("invalid_request", "Missing authorization code", 400);
    }

    const tokenData = this.tokens.get(params.code);
    if (!tokenData) {
      console.error("[PKCEProxy] Token not found for code:", params.code);
      console.error("[PKCEProxy] Available tokens:", Array.from(this.tokens.keys()).map(k => k.slice(0, 8) + "..."));
      throw new OAuthProxyError("invalid_grant", "Invalid or expired authorization code", 400);
    }

    // Remove the code (single use)
    this.tokens.delete(params.code);

    // Generate a new access token for the client
    const accessToken = this.generateId();
    this.tokens.set(accessToken, tokenData);
    this.saveTokensToDisk(); // Persist to disk

    const expiresIn = Math.floor((tokenData.expiresAt.getTime() - Date.now()) / 1000);
    console.log("[PKCEProxy] Issuing access token, expires in:", expiresIn, "seconds");

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn > 0 ? expiresIn : 3600,
      // Note: Not returning refresh_token since Reflect doesn't support refresh_token grant
      // This tells the MCP client to re-authenticate via OAuth when the token expires
    };
  }

  // Handle refresh token exchange
  // Note: Reflect's API doesn't support standard refresh_token grant
  // We throw an OAuthProxyError to trigger re-authentication via OAuth flow
  async exchangeRefreshToken(params: {
    grant_type: string;
    refresh_token: string;
    client_id: string;
    client_secret?: string;
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  }> {
    console.log("[PKCEProxy] exchangeRefreshToken called - Reflect doesn't support refresh_token grant");
    console.log("[PKCEProxy] Triggering re-authentication via OAuth flow...");
    
    // Reflect's token endpoint only accepts authorization_code grant, not refresh_token
    // Throw OAuthProxyError so FastMCP handles it properly and triggers re-auth
    throw new OAuthProxyError(
      "invalid_grant",
      "Refresh tokens are not supported. Please re-authenticate.",
      400
    );
  }

  // Handle /oauth/register (Dynamic Client Registration)
  async registerClient(request: { redirect_uris?: string[]; client_name?: string }): Promise<{
    client_id: string;
    client_name?: string;
    redirect_uris?: string[];
  }> {
    // For public clients, we just acknowledge the registration
    // The actual client_id is configured server-side
    return {
      client_id: this.generateId(),
      client_name: request.client_name,
      redirect_uris: request.redirect_uris,
    };
  }

  // Load upstream tokens for a given proxy token
  loadUpstreamTokens(proxyToken: string): TokenData | null {
    const data = this.tokens.get(proxyToken);
    if (!data) return null;
    if (data.expiresAt < new Date()) {
      this.tokens.delete(proxyToken);
      this.saveTokensToDisk();
      return null;
    }
    return data;
  }

  // Get first valid token (for stdio mode where we don't have specific token ID)
  getFirstValidToken(): TokenData | null {
    const now = new Date();
    for (const [id, token] of this.tokens) {
      if (token.expiresAt > now) {
        return token;
      }
    }
    return null;
  }

  // Cleanup expired transactions and tokens
  private startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = new Date();
      let tokensChanged = false;
      
      for (const [id, tx] of this.transactions) {
        if (tx.expiresAt < now) this.transactions.delete(id);
      }
      for (const [id, token] of this.tokens) {
        if (token.expiresAt < now) {
          this.tokens.delete(id);
          tokensChanged = true;
        }
      }
      
      if (tokensChanged) {
        this.saveTokensToDisk();
      }
    }, 60000); // Every minute
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Save tokens before shutdown
    this.saveTokensToDisk();
  }
}

