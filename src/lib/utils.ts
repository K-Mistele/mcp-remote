import { OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import crypto from 'crypto'
import express from 'express'
import net from 'net'
import { OAuthCallbackServerOptions } from './types'

// Package version from package.json
export const MCP_REMOTE_VERSION = require('../../package.json').version

const pid = process.pid
export function log(str: string, ...rest: unknown[]) {
  // Using stderr so that it doesn't interfere with stdout
  console.error(`[${pid}] ${str}`, ...rest)
}

// --- Helper function for Handling Unauthorized Errors during send() for HTTP ---
// This function performs the auth flow and returns a NEW, started transport.
// It no longer needs SSE specific logic.
async function handleUnauthorizedHttpSendError(
  failedTransport: StreamableHTTPClientTransport, // Specifically HTTP transport
  authProvider: OAuthClientProvider,
  headers: Record<string, string>,
  waitForAuthCode: () => Promise<string>,
  serverUrl: string,
  // No sseEventSourceInit needed
): Promise<StreamableHTTPClientTransport> {
  // Returns the specific type
  log('Unauthorized error during HTTP send() detected, starting authentication flow...')

  // Wait for the authorization code
  log('HTTP Send Auth: Waiting for auth code...')
  const code = await waitForAuthCode()
  log('HTTP Send Auth: Got code, calling finishAuth...')

  try {
    // Finish auth on the *original* transport instance
    await failedTransport.finishAuth(code)
    log('HTTP Send Auth: finishAuth successful.')

    // Create a NEW transport instance
    log('HTTP Send Auth: Creating new transport...')
    const url = new URL(serverUrl)
    const originalSessionId = failedTransport.sessionId // Get Session ID
    log(`HTTP Send Auth: Recreating StreamableHTTP transport, original session ID: ${originalSessionId}`)

    const newTransport = new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: { headers },
      sessionId: originalSessionId, // Preserve Session ID
    })

    // Setup basic handlers for the new transport
    newTransport.onerror = (error) => log('[New HTTP Transport - Send Auth] Error:', error)
    newTransport.onclose = () => log('[New HTTP Transport - Send Auth] Closed')

    log('HTTP Send Auth: Starting new transport...')
    await newTransport.start() // Start the new transport
    log('HTTP Send Auth: New transport started.')

    log('HTTP Send Auth: Re-authentication successful. Returning new transport.')
    return newTransport // Return the new, started transport
  } catch (authError) {
    log('HTTP Send Auth: Error during re-authentication flow:', authError)
    throw authError // Re-throw if re-auth fails
  }
}

/**
 * Creates a bidirectional proxy between two transports, handling re-authentication on send FOR HTTP ONLY.
 * @param params The transport connections and auth dependencies
 */
export function mcpProxy({
  transportToClient,
  transportToServer: initialTransportToServer,
  // Dependencies needed for re-authentication during send()
  authProvider,
  headers,
  transportType, // Still need type to gate the logic
  waitForAuthCode,
  serverUrl,
  // sseEventSourceInit, // REMOVED from parameters
}: {
  transportToClient: Transport
  transportToServer: Transport
  authProvider: OAuthClientProvider
  headers: Record<string, string>
  transportType: TransportType
  waitForAuthCode: () => Promise<string>
  serverUrl: string
  // sseEventSourceInit?: object // REMOVED
}) {
  let transportToClientClosed = false
  let transportToServerClosed = false
  let transportToServer = initialTransportToServer // Mutable transport reference

  // --- Error Handlers (Simplified) ---
  function onClientError(error: Error) {
    log('Error from local client:', error)
    if (!transportToServerClosed) transportToServer.close().catch(onServerError)
  }
  function onServerError(error: Error) {
    log('Error from remote server:', error)
    if (!transportToClientClosed) transportToClient.close().catch(onClientError)
  }

  // --- Function to Register/Re-register Handlers on the Server Transport ---
  function registerServerTransportHandlers(serverTransport: Transport) {
    serverTransport.onmessage = undefined
    serverTransport.onclose = undefined
    serverTransport.onerror = undefined

    serverTransport.onmessage = (message) => {
      const id = 'id' in message ? message.id : undefined
      const method = 'method' in message ? message.method : undefined
      log('[Remote→Local]', method || id)
      if (!transportToClientClosed) transportToClient.send(message).catch(onClientError)
    }
    serverTransport.onclose = () => {
      if (transportToClientClosed) return
      log('Remote server transport closed')
      transportToServerClosed = true
      if (!transportToClientClosed) transportToClient.close().catch(onClientError)
    }
    serverTransport.onerror = onServerError
  }

  // Register handlers for the *initial* server transport
  registerServerTransportHandlers(transportToServer)

  // --- Message From Client to Server (Handles Auth on Send for HTTP ONLY) ---
  transportToClient.onmessage = async (message) => {
    const id = 'id' in message ? message.id : undefined
    const method = 'method' in message ? message.method : undefined
    log('[Local→Remote]', method || id)

    if (transportToServerClosed) {
      log('Cannot send message, server transport closed.')
      return
    }

    try {
      await transportToServer.send(message)
      log(`Message ${method || id} sent successfully.`)
    } catch (error) {
      // --- Auth Handling during Send (HTTP ONLY) ---
      // Check for Auth Error *AND* if transport is HTTP
      if (
        (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes('Unauthorized'))) &&
        transportType === 'streamable-http'
      ) {
        log('UnauthorizedError caught during HTTP send(). Attempting re-authentication...')
        try {
          // Call the HTTP-specific helper
          const newTransport = await handleUnauthorizedHttpSendError(
            transportToServer as StreamableHTTPClientTransport, // Cast to specific type
            authProvider,
            headers,
            waitForAuthCode,
            serverUrl,
            // No sseEventSourceInit needed
          )

          log('Updating active server transport reference.')
          transportToServer = newTransport

          log('Re-registering handlers on new server transport.')
          registerServerTransportHandlers(transportToServer)

          log('Re-authentication successful, retrying original message send...')
          await transportToServer.send(message)
          log(`Original message ${method || id} successfully sent after re-authentication.`)
        } catch (reauthError) {
          log('Failed to re-authenticate or retry sending HTTP message:', reauthError)
          if (!transportToClientClosed) transportToClient.close().catch(onClientError)
          if (!transportToServerClosed)
            transportToServer.close().catch((e) => log('Error closing server transport after HTTP reauth failure:', e))
        }
        // --- End Auth Handling ---
      } else {
        // Handle non-authentication errors OR auth errors for SSE (which shouldn't happen here)
        log(`Error sending message (${transportType}) to remote server:`, error)
        onServerError(error as Error)
      }
    }
  }

  // --- Client Close Handler & Error Handler ---
  transportToClient.onclose = () => {
    if (transportToServerClosed) return
    log('Local client transport closed')
    transportToClientClosed = true
    if (!transportToServerClosed) transportToServer.close().catch(onServerError)
  }
  transportToClient.onerror = onClientError
}

// --- Function to start SSE transport and handle its specific auth flow during start() ---
async function startSSETransport(
  transport: SSEClientTransport,
  authProvider: OAuthClientProvider,
  headers: Record<string, string>,
  waitForAuthCode: () => Promise<string>,
  skipBrowserAuth: boolean,
  url: URL, // Server URL object
  sseEventSourceInit: object, // Must be provided for SSE
): Promise<Transport> {
  log('Starting SSE transport...')
  // --- Start of Moved try/catch block ---
  try {
    await transport.start()
    log('SSE Transport started successfully (initial attempt).')
    return transport // Return original if start succeeded
  } catch (error) {
    if (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes('Unauthorized'))) {
      log('UnauthorizedError during SSE start(), handling auth...')
      if (skipBrowserAuth) {
        log('SSE Start Auth: Skipping browser auth - using shared auth')
      } else {
        log('SSE Start Auth: Waiting for authorization...')
      }

      const code = await waitForAuthCode()
      log('SSE Start Auth: Got code, calling finishAuth...')

      try {
        // Finish auth on the *original* transport instance
        await transport.finishAuth(code)
        log('SSE Start Auth: finishAuth successful. Creating new transport...')

        // Create a new transport after auth
        const newTransport = new SSEClientTransport(url, {
          authProvider,
          requestInit: { headers },
          eventSourceInit: sseEventSourceInit, // Re-use the same init object
        })

        // Setup handlers on new transport (basic logging)
        newTransport.onerror = (err) => log('[New SSE Transport - Start Auth] Error:', err)
        newTransport.onclose = () => log('[New SSE Transport - Start Auth] Closed')

        log('SSE Start Auth: Starting new transport...')
        await newTransport.start()
        log('SSE Start Auth: New transport started successfully.')

        // Return the NEW transport
        return newTransport
      } catch (authError) {
        log('SSE Start Auth: Error during auth flow:', authError)
        throw authError // Re-throw error if auth during start fails
      }
    } else {
      // Handle non-auth errors during start()
      log('SSE Start: Non-auth error during start():', error)
      throw error
    }
  }
  // --- End of Moved try/catch block ---
}

// --- Function to start Streamable HTTP transport (Simplified Start) ---
async function startStreamableHttpTransport(
  transport: StreamableHTTPClientTransport,
  // Remove unused auth parameters for the start phase
  // authProvider: OAuthClientProvider,
  // headers: Record<string, string>,
  // waitForAuthCode: () => Promise<string>,
  // skipBrowserAuth: boolean,
  // url: URL
): Promise<Transport> {
  log('Starting Streamable HTTP transport (simple start)...')
  // For Streamable HTTP, start() is simple. Auth errors are handled during send().
  try {
    await transport.start()
    log('Streamable HTTP Transport started successfully.')
    return transport // Return the original transport
  } catch (error) {
    // Catch generic errors during start (e.g., network issues)
    log('HTTP Start: Non-auth error during start():', error)
    throw error
  }
}

/**
 * Creates and connects to a remote server with OAuth authentication
 * Calls appropriate start* function based on transport type.
 */
export async function connectToRemoteServer(
  serverUrl: string,
  authProvider: OAuthClientProvider,
  headers: Record<string, string>,
  transportType: TransportType,
  waitForAuthCode: () => Promise<string>,
  skipBrowserAuth: boolean = false,
): Promise<{ transport: Transport; sseEventSourceInit?: object }> {
  // Return object
  log(`[${pid}] Connecting to remote server: ${serverUrl} using ${transportType}`)
  const url = new URL(serverUrl)

  let transport: Transport
  let sseEventSourceInit: object | undefined = undefined

  // 1. Initialize Transport
  if (transportType === 'streamable-http') {
    log(`Initializing StreamableHTTPClientTransport...`)
    transport = new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: { headers },
    })
    log('StreamableHTTPClientTransport initialized')
  } else {
    // Default to SSE
    log(`Initializing SSEClientTransport...`)
    sseEventSourceInit = {
      fetch: (fetchUrl: string | URL, init?: RequestInit) => {
        return Promise.resolve(authProvider?.tokens?.()).then((tokens) => {
          return fetch(fetchUrl, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string> | undefined),
              ...headers,
              ...(tokens?.access_token ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
              Accept: 'text/event-stream',
            } as Record<string, string>,
          })
        })
      },
    }
    transport = new SSEClientTransport(url, {
      authProvider,
      requestInit: { headers },
      eventSourceInit: sseEventSourceInit,
    })
    log('SSEClientTransport initialized')
  }

  // 2. Start Transport using appropriate helper function
  let finalTransport: Transport
  if (transportType === 'streamable-http') {
    finalTransport = await startStreamableHttpTransport(
      transport as StreamableHTTPClientTransport, // Cast to specific type
      // Pass only necessary args for simple start
    )
  } else {
    // Must be SSE
    if (!sseEventSourceInit) {
      throw new Error('Internal error: sseEventSourceInit is missing for SSE transport start')
    }
    finalTransport = await startSSETransport(
      transport as SSEClientTransport, // Cast to specific type
      authProvider,
      headers,
      waitForAuthCode,
      skipBrowserAuth,
      url,
      sseEventSourceInit,
    )
  }

  // 3. Return the final connected transport and sseEventSourceInit (if applicable)
  return { transport: finalTransport, sseEventSourceInit }
}

/**
 * Sets up an Express server to handle OAuth callbacks
 * @param options The server options
 * @returns An object with the server, authCode, and waitForAuthCode function
 */
export function setupOAuthCallbackServerWithLongPoll(options: OAuthCallbackServerOptions) {
  let authCode: string | null = null
  const app = express()

  // Create a promise to track when auth is completed
  let authCompletedResolve: (code: string) => void
  const authCompletedPromise = new Promise<string>((resolve) => {
    authCompletedResolve = resolve
  })

  // Long-polling endpoint
  app.get('/wait-for-auth', (req, res) => {
    if (authCode) {
      // Auth already completed - just return 200 without the actual code
      // Secondary instances will read tokens from disk
      log('Auth already completed, returning 200')
      res.status(200).send('Authentication completed')
      return
    }

    if (req.query.poll === 'false') {
      log('Client requested no long poll, responding with 202')
      res.status(202).send('Authentication in progress')
      return
    }

    // Long poll - wait for up to 30 seconds
    const longPollTimeout = setTimeout(() => {
      log('Long poll timeout reached, responding with 202')
      res.status(202).send('Authentication in progress')
    }, 30000)

    // If auth completes while we're waiting, send the response immediately
    authCompletedPromise
      .then(() => {
        clearTimeout(longPollTimeout)
        if (!res.headersSent) {
          log('Auth completed during long poll, responding with 200')
          res.status(200).send('Authentication completed')
        }
      })
      .catch(() => {
        clearTimeout(longPollTimeout)
        if (!res.headersSent) {
          log('Auth failed during long poll, responding with 500')
          res.status(500).send('Authentication failed')
        }
      })
  })

  // OAuth callback endpoint
  app.get(options.path, (req, res) => {
    const code = req.query.code as string | undefined
    if (!code) {
      res.status(400).send('Error: No authorization code received')
      return
    }

    authCode = code
    log('Auth code received, resolving promise')
    authCompletedResolve(code)

    res.send('Authorization successful! You may close this window and return to the CLI.')

    // Notify main flow that auth code is available
    options.events.emit('auth-code-received', code)
  })

  const server = app.listen(options.port, () => {
    log(`OAuth callback server running at http://127.0.0.1:${options.port}`)
  })

  const waitForAuthCode = (): Promise<string> => {
    return new Promise((resolve) => {
      if (authCode) {
        resolve(authCode)
        return
      }

      options.events.once('auth-code-received', (code) => {
        resolve(code)
      })
    })
  }

  return { server, authCode, waitForAuthCode, authCompletedPromise }
}

/**
 * Sets up an Express server to handle OAuth callbacks
 * @param options The server options
 * @returns An object with the server, authCode, and waitForAuthCode function
 */
export function setupOAuthCallbackServer(options: OAuthCallbackServerOptions) {
  const { server, authCode, waitForAuthCode } = setupOAuthCallbackServerWithLongPoll(options)
  return { server, authCode, waitForAuthCode }
}

/**
 * Defines the available transport types
 */
export type TransportType = 'sse' | 'streamable-http'

/**
 * Finds an available port on the local machine
 * @param preferredPort Optional preferred port to try first
 * @returns A promise that resolves to an available port number
 */
export async function findAvailablePort(preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // If preferred port is in use, get a random port
        server.listen(0)
      } else {
        reject(err)
      }
    })

    server.on('listening', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => {
        resolve(port)
      })
    })

    // Try preferred port first, or get a random port
    server.listen(preferredPort || 0)
  })
}

interface ParsedArgs {
  serverUrl: string
  callbackPort: number
  headers: Record<string, string>
  transportType: TransportType
}

/**
 * Parses command line arguments for MCP clients and proxies
 * @param args Command line arguments
 * @param defaultPort Default port for the callback server if specified port is unavailable
 * @param usage Usage message to show on error
 * @returns A promise that resolves to an object with parsed serverUrl, callbackPort, headers, and transportType
 */
export async function parseCommandLineArgs(args: string[], defaultPort: number, usage: string): Promise<ParsedArgs> {
  // Process headers
  const headers: Record<string, string> = {}
  args.forEach((arg, i) => {
    if (arg === '--header' && i < args.length - 1) {
      const value = args[i + 1]
      const match = value.match(/^([A-Za-z0-9_-]+):(.*)$/)
      if (match) {
        headers[match[1]] = match[2]
      } else {
        log(`Warning: ignoring invalid header argument: ${value}`)
      }
      args.splice(i, 2)
    }
  })

  // Process transport type
  let transportType: TransportType = 'sse' // Default
  const transportIndex = args.findIndex((arg) => arg === '--transport')
  if (transportIndex !== -1 && transportIndex < args.length - 1) {
    const specifiedTransport = args[transportIndex + 1].toLowerCase()
    if (specifiedTransport === 'sse' || specifiedTransport === 'streamable-http') {
      transportType = specifiedTransport
      log(`Using specified transport: ${transportType}`)
    } else {
      log(`Warning: Invalid transport type '${specifiedTransport}'. Using default 'sse'.`)
    }
    // Remove --transport and its value from args so it doesn't interfere later
    args.splice(transportIndex, 2)
  }

  const serverUrl = args[0]
  const specifiedPort = args[1] ? parseInt(args[1]) : undefined
  const allowHttp = args.includes('--allow-http')

  if (!serverUrl) {
    log(usage)
    process.exit(1)
  }

  const url = new URL(serverUrl)
  const isLocalhost = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:'

  if (!(url.protocol == 'https:' || isLocalhost || allowHttp)) {
    log('Error: Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided')
    log(usage)
    process.exit(1)
  }

  // Use the specified port, or find an available one
  const callbackPort = specifiedPort || (await findAvailablePort(defaultPort))

  if (specifiedPort) {
    log(`Using specified callback port: ${callbackPort}`)
  } else {
    log(`Using automatically selected callback port: ${callbackPort}`)
  }

  if (Object.keys(headers).length > 0) {
    log(`Using custom headers: ${JSON.stringify(headers)}`)
  }
  // Replace environment variables in headers
  // example `Authorization: Bearer ${TOKEN}` will read process.env.TOKEN
  for (const [key, value] of Object.entries(headers)) {
    headers[key] = value.replace(/\$\{([^}]+)}/g, (match, envVarName) => {
      const envVarValue = process.env[envVarName]

      if (envVarValue !== undefined) {
        log(`Replacing ${match} with environment value in header '${key}'`)
        return envVarValue
      } else {
        log(`Warning: Environment variable '${envVarName}' not found for header '${key}'.`)
        return ''
      }
    })
  }

  return { serverUrl, callbackPort, headers, transportType }
}

/**
 * Sets up signal handlers for graceful shutdown
 * @param cleanup Cleanup function to run on shutdown
 */
export function setupSignalHandlers(cleanup: () => Promise<void>) {
  process.on('SIGINT', async () => {
    log('\nShutting down...')
    await cleanup()
    process.exit(0)
  })

  // Keep the process alive
  process.stdin.resume()
}

/**
 * Generates a hash for the server URL to use in filenames
 * @param serverUrl The server URL to hash
 * @returns The hashed server URL
 */
export function getServerUrlHash(serverUrl: string): string {
  return crypto.createHash('md5').update(serverUrl).digest('hex')
}
