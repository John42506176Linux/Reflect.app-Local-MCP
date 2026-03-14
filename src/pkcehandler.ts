/**
 * PKCE OAuth Proxy (No Client Secret Required)
 * 
 * Updated by Twice 🦸‍♂️
 * Cloning capabilities enabled for multiple MCP clients
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
// Write Queue - Prevents concurrent file I/O operations
// ============================================================================

/**
 * Simple in-memory write queue that batches and serializes file writes.
 * This prevents race conditions when multiple clients trigger disk writes simultaneously.
 */
class WriteQueue {
  private queue: Array<() => Promise<void>> = [];
  private isProcessing = false;

  /**
   * Add a write operation to the queue and wait for it to complete
   */
  async add(writeOperation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const operation = async () => {
        try {
          await writeOperation();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      this.queue.push(operation);
      this.processQueue();
    });
  }

  /**
   * Process the queue one operation at a time
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const operation = this.queue.shift()!;

    try {
      await operation();
    } finally {
      this.isProcessing = false;
      // Small delay to batch rapid writes together
      await new Promise(resolve => setTimeout(resolve, 10));
      this.processQueue();
    }
  }
}

// Global write queue instance shared across all PKCEProxy instances
const globalWriteQueue = new WriteQueue();

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

// Serializable version for file storage
interface SerializedTransaction {
  codeVerifier: string;
  codeChallenge: string;
  clientCallbackUrl: string;
  clientId: string;
  clientState: string;
  scope: string[];
  createdAt: string;
  expiresAt: string;
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
  transactionStoragePath?: string; // Path to persist transactions (default: ~/.reflect-mcp-transactions.json)
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
    transactionStoragePath: string;
  };
  
  // Transaction storage - now persisted to disk to survive restarts
  private transactions = new Map<string, PKCETransaction>();
  // Token storage - persisted to disk
  private tokens = new Map<string, TokenData>();
  // Track tokens that have been exchanged but allow brief retry window
  private recentlyExchangedCodes = new Map<string, { accessToken: string; expiresAt: Date }>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Debounce: track pending auth so concurrent requests don't each open a browser
  private pendingAuthTransaction: { transactionId: string; authUrl: string; expiresAt: Date } | null = null;

  // Active connections counter for debugging
  private activeConnections = 0;

  constructor(options: PKCEOAuthProxyConfig) {
    this.config = {
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      authorizationEndpoint: options.authorizationEndpoint,
      tokenEndpoint: options.tokenEndpoint,
      redirectPath: options.redirectPath || "/oauth/callback",
      scopes: options.scopes,
      tokenStoragePath: options.tokenStoragePath || path.join(os.homedir(), ".reflect-mcp-tokens.json"),
      transactionStoragePath: options.transactionStoragePath || path.join(os.homedir(), ".reflect-mcp-transactions.json"),
    };
    this.loadTokensFromDisk();
    this.loadTransactionsFromDisk();
    this.startCleanup();
  }

  // Load tokens from disk on startup
  private loadTokensFromDisk(): void {
    try {
      if (fs.existsSync(this.config.tokenStoragePath)) {
        const data = fs.readFileSync(this.config.tokenStoragePath, "utf-8");
        const stored = JSON.parse(data) as Record<string, SerializedTokenData>;
        
        for (const [key, value] of Object.entries(stored)) {
          this.tokens.set(key, {
            accessToken: value.accessToken,
            refreshToken: value.refreshToken,
            expiresAt: new Date(value.expiresAt),
          });
        }
        console.log(`[PKCEProxy] Loaded ${this.tokens.size} tokens from disk`);
      }
    } catch (error) {
      console.warn("[PKCEProxy] Failed to load tokens from disk:", error);
    }
  }

  // Save tokens to disk - ASYNC with write queue
  // This prevents blocking the event loop and prevents race conditions
  private async saveTokensToDisk(): Promise<void> {
    try {
      const toStore: Record<string, SerializedTokenData> = {};
      for (const [key, value] of this.tokens) {
        toStore[key] = {
          accessToken: value.accessToken,
          refreshToken: value.refreshToken,
          expiresAt: value.expiresAt.toISOString(),
        };
      }
      
      // Use the global write queue to serialize this write operation
      await globalWriteQueue.add(async () => {
        await fs.promises.writeFile(
          this.config.tokenStoragePath, 
          JSON.stringify(toStore, null, 2),
          "utf-8"
        );
      });
      
      console.log(`[PKCEProxy] Saved ${Object.keys(toStore).length} tokens to disk`);
    } catch (error) {
      console.error("[PKCEProxy] Failed to save tokens to disk:", error);
    }
  }

  // Load transactions from disk on startup (survives server restarts)
  private loadTransactionsFromDisk(): void {
    try {
      if (fs.existsSync(this.config.transactionStoragePath)) {
        const data = fs.readFileSync(this.config.transactionStoragePath, "utf-8");
        const stored = JSON.parse(data) as Record<string, SerializedTransaction>;
        
        for (const [key, value] of Object.entries(stored)) {
          const expiresAt = new Date(value.expiresAt);
          // Only load non-expired transactions
          if (expiresAt > new Date()) {
            this.transactions.set(key, {
              codeVerifier: value.codeVerifier,
              codeChallenge: value.codeChallenge,
              clientCallbackUrl: value.clientCallbackUrl,
              clientId: value.clientId,
              clientState: value.clientState,
              scope: value.scope,
              createdAt: new Date(value.createdAt),
              expiresAt,
            });
          }
        }
        console.log(`[PKCEProxy] Loaded ${this.transactions.size} transactions from disk`);
      }
    } catch (error) {
      console.warn("[PKCEProxy] Failed to load transactions from disk:", error);
    }
  }

  // Save transactions to disk (survives server restarts) - ASYNC with write queue
  private async saveTransactionsToDisk(): Promise<void> {
    try {
      const toStore: Record<string, SerializedTransaction> = {};
      for (const [key, value] of this.transactions) {
        toStore[key] = {
          codeVerifier: value.codeVerifier,
          codeChallenge: value.codeChallenge,
          clientCallbackUrl: value.clientCallbackUrl,
          clientId: value.clientId,
          clientState: value.clientState,
          scope: value.scope,
          createdAt: value.createdAt.toISOString(),
          expiresAt: value.expiresAt.toISOString(),
        };
      }
      
      // Use the global write queue to serialize this write operation
      await globalWriteQueue.add(async () => {
        await fs.promises.writeFile(
          this.config.transactionStoragePath, 
          JSON.stringify(toStore, null, 2),
          "utf-8"
        );
      });
      
      console.log(`[PKCEProxy] Saved ${Object.keys(toStore).length} transactions to disk`);
    } catch (error) {
      console.error("[PKCEProxy] Failed to save transactions to disk:", error);
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

    // If we already have a valid token, skip the full OAuth dance.
    // Issue a proxy code immediately so subsequent clients never need a browser.
    const existingToken = this.getFirstValidToken();
    if (existingToken) {
      console.log("[PKCEProxy] Valid token exists — issuing proxy code directly (skipping OAuth)");
      const proxyCode = this.generateId();
      this.tokens.set(proxyCode, { ...existingToken });
      await this.saveTokensToDisk();

      const clientRedirect = new URL(params.redirect_uri);
      clientRedirect.searchParams.set("code", proxyCode);
      clientRedirect.searchParams.set("state", params.state || "");

      console.log("[PKCEProxy] Redirecting client directly to:", clientRedirect.toString());
      return new Response(null, {
        status: 302,
        headers: { Location: clientRedirect.toString() },
      });
    }

    // Debounce: if another request already started auth, reuse its redirect
    // instead of opening yet another browser tab
    if (this.pendingAuthTransaction && this.pendingAuthTransaction.expiresAt > new Date()) {
      console.log("[PKCEProxy] Auth already in progress — reusing pending transaction:", this.pendingAuthTransaction.transactionId.slice(0, 8) + "...");
      return new Response(null, {
        status: 302,
        headers: { Location: this.pendingAuthTransaction.authUrl },
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
    await this.saveTransactionsToDisk(); // Persist to survive restarts (async now)
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

    // Store as pending so concurrent requests reuse this instead of opening more browsers
    this.pendingAuthTransaction = {
      transactionId,
      authUrl: authUrl.toString(),
      expiresAt: new Date(Date.now() + 60 * 1000), // 60 second debounce window
    };

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
      await this.saveTransactionsToDisk();
      console.error("[PKCEProxy] Transaction expired, created:", transaction.createdAt, "expired:", transaction.expiresAt);
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
    console.log("[PKCEProxy] Reflect token response:", JSON.stringify(tokens, null, 2));

    // Generate a proxy token to give to the client
    const proxyToken = this.generateId();
    this.tokens.set(proxyToken, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + (tokens.expires_in || 365 * 24 * 3600) * 1000),
    });
    await this.saveTokensToDisk(); // Persist to disk (async now)

    // Redirect back to client with our proxy token
    const clientRedirect = new URL(transaction.clientCallbackUrl);
    clientRedirect.searchParams.set("code", proxyToken);
    clientRedirect.searchParams.set("state", transaction.clientState);

    // Clean up transaction and pending auth debounce
    this.transactions.delete(state);
    this.pendingAuthTransaction = null;
    await this.saveTransactionsToDisk();

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
    refresh_token?: string;
    scope?: string;
  }> {
    if (!params.code) {
      throw new OAuthProxyError("invalid_request", "Missing authorization code", 400);
    }

    console.log(`[PKCEProxy] Exchange requested for code: ${params.code.slice(0, 8)}... (connections: ${this.activeConnections})`);

    // Check if this code was recently exchanged (retry tolerance)
    // This allows mcp-remote to retry if the first request timed out but actually succeeded
    const recentExchange = this.recentlyExchangedCodes.get(params.code);
    if (recentExchange && recentExchange.expiresAt > new Date()) {
      console.log(`[PKCEProxy] Returning cached token for retry of code: ${params.code.slice(0, 8)}...`);
      const tokenData = this.tokens.get(recentExchange.accessToken);
      if (tokenData) {
        const expiresIn = Math.floor((tokenData.expiresAt.getTime() - Date.now()) / 1000);
        return {
          access_token: recentExchange.accessToken,
          token_type: "Bearer",
        };
      }
    }

    const tokenData = this.tokens.get(params.code);
    if (!tokenData) {
      console.error(`[PKCEProxy] Token not found for code: ${params.code}`);
      console.error(`[PKCEProxy] Available tokens:`, Array.from(this.tokens.keys()).map(k => k.slice(0, 8) + "..."));
      console.error(`[PKCEProxy] Recently exchanged codes:`, Array.from(this.recentlyExchangedCodes.keys()).map(k => k.slice(0, 8) + "..."));
      throw new OAuthProxyError("invalid_grant", "Invalid or expired authorization code", 400);
    }

    // Remove the code but keep track of it for retry tolerance (30 second window)
    // Mark as exchanged BEFORE saving to disk to prevent race conditions
    this.tokens.delete(params.code);

    // Generate a new access token for the client
    const accessToken = this.generateId();
    this.tokens.set(accessToken, tokenData);

    // Store the exchange for retry tolerance (30 seconds) - mark as exchanged
    this.recentlyExchangedCodes.set(params.code, {
      accessToken,
      expiresAt: new Date(Date.now() + 30 * 1000),
    });

    // Now save to disk
    await this.saveTokensToDisk();

    console.log(`[PKCEProxy] Issued access token for code: ${params.code.slice(0, 8)}...`);

    const refreshToken = `refresh_${this.generateId()}`;
    this.tokens.set(refreshToken, { ...tokenData });
    await this.saveTokensToDisk();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(params: {
    grant_type: string;
    refresh_token: string;
    client_id: string;
    client_secret?: string;
  }): Promise<{
    access_token: string;
    token_type: string;
    refresh_token?: string;
  }> {
    console.log(`[PKCEProxy] exchangeRefreshToken called with: ${params.refresh_token.slice(0, 12)}...`);

    const tokenData = this.tokens.get(params.refresh_token);
    if (tokenData) {
      const newAccessToken = this.generateId();
      this.tokens.set(newAccessToken, { ...tokenData });

      const newRefreshToken = `refresh_${this.generateId()}`;
      this.tokens.set(newRefreshToken, { ...tokenData });

      this.tokens.delete(params.refresh_token);
      await this.saveTokensToDisk();

      console.log(`[PKCEProxy] Refreshed silently`);

      return {
        access_token: newAccessToken,
        token_type: "Bearer",
        refresh_token: newRefreshToken,
      };
    }

    // Refresh token not found — fall back to any available token
    const validToken = this.getFirstValidToken();
    if (validToken) {
      console.log("[PKCEProxy] Refresh token not found, using fallback token");
      const newAccessToken = this.generateId();
      this.tokens.set(newAccessToken, { ...validToken });

      const newRefreshToken = `refresh_${this.generateId()}`;
      this.tokens.set(newRefreshToken, { ...validToken });

      this.tokens.delete(params.refresh_token);
      await this.saveTokensToDisk();

      console.log(`[PKCEProxy] Issued token from fallback`);

      return {
        access_token: newAccessToken,
        token_type: "Bearer",
        refresh_token: newRefreshToken,
      };
    }

    // No tokens at all — force browser re-auth
    console.log("[PKCEProxy] No tokens available — forcing re-authentication");
    throw new OAuthProxyError(
      "invalid_grant",
      "All tokens expired. Please re-authenticate.",
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

  // Validate an upstream Reflect token by calling the API
  private async validateUpstreamToken(tokenData: TokenData): Promise<boolean> {
    try {
      const response = await fetch("https://reflect.app/api/users/me", {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      if (response.ok) return true;
      console.warn("[PKCEProxy] Upstream token rejected by Reflect API:", response.status);
      return false;
    } catch (error) {
      // Network error — don't invalidate, assume token is still good
      console.warn("[PKCEProxy] Network error validating token, keeping it:", error);
      return true;
    }
  }

  // Invalidate all tokens that share a given upstream access token
  async invalidateUpstreamToken(accessToken: string): Promise<void> {
    let changed = false;
    for (const [id, token] of this.tokens) {
      if (token.accessToken === accessToken) {
        console.log("[PKCEProxy] Invalidating token with revoked upstream:", id.slice(0, 8) + "...");
        this.tokens.delete(id);
        changed = true;
      }
    }
    if (changed) await this.saveTokensToDisk();
  }

  // Load upstream tokens for a given proxy token
  async loadUpstreamTokens(proxyToken: string): Promise<TokenData | null> {
    const data = this.tokens.get(proxyToken);
    if (!data) {
      const validToken = this.getFirstValidToken();
      if (validToken) {
        console.warn("[PKCEProxy] Stale token presented, mapping to current valid token:", proxyToken.slice(0, 8) + "...");
        return validToken;
      }
      console.warn("[PKCEProxy] Token not found:", proxyToken.slice(0, 8) + "...");
      console.warn("[PKCEProxy] Total tokens in store:", this.tokens.size);
      return null;
    }
    return data;
  }

  // Get first available token (any token in the store)
  getFirstValidToken(): TokenData | null {
    for (const [id, token] of this.tokens) {
      return token;
    }
    return null;
  }

  // Cleanup expired transactions, tokens, and retry cache
  private async startCleanup(): Promise<void> {
    const cleanup = async () => {
      const now = new Date();
      let transactionsChanged = false;
      
      for (const [id, tx] of this.transactions) {
        if (tx.expiresAt < now) {
          this.transactions.delete(id);
          transactionsChanged = true;
        }
      }
      for (const [code, data] of this.recentlyExchangedCodes) {
        if (data.expiresAt < now) {
          this.recentlyExchangedCodes.delete(code);
        }
      }
      
      if (transactionsChanged) {
        await this.saveTransactionsToDisk();
      }
    };

    this.cleanupInterval = setInterval(cleanup, 60000); // Every minute
    // Run cleanup immediately on startup
    await cleanup();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Save tokens before shutdown
    this.saveTokensToDisk();
  }
}

