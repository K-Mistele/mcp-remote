#!/usr/bin/env node

/**
 * MCP Client with OAuth support
 * A command-line client that connects to an MCP server using SSE with OAuth authentication.
 *
 * Run with: npx tsx client.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListResourcesResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { EventEmitter } from 'events'
import { coordinateAuth } from './lib/coordination'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { getServerUrlHash, log, MCP_REMOTE_VERSION, parseCommandLineArgs, setupSignalHandlers, TransportType } from './lib/utils.js'

/**
 * Main function to run the client
 */
async function runClient(serverUrl: string, callbackPort: number, headers: Record<string, string>, transportType: TransportType) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()

  // Get the server URL hash for lockfile operations
  const serverUrlHash = getServerUrlHash(serverUrl)

  // Coordinate authentication with other instances
  const { server, waitForAuthCode, skipBrowserAuth } = await coordinateAuth(serverUrlHash, callbackPort, events)

  // Create the OAuth client provider
  const authProvider = new NodeOAuthClientProvider({
    serverUrl,
    callbackPort,
    clientName: 'MCP CLI Client',
  })

  // If auth was completed by another instance, just log that we'll use the auth from disk
  if (skipBrowserAuth) {
    log('Authentication was completed by another instance - will use tokens from disk...')
    await new Promise((res) => setTimeout(res, 1_000))
  }

  // Create the client
  const client = new Client(
    {
      name: 'mcp-remote',
      version: MCP_REMOTE_VERSION,
    },
    {
      capabilities: {},
    },
  )

  // Create the transport factory
  const url = new URL(serverUrl)
  function initTransport(): Transport {
    let transport: Transport
    if (transportType === 'streamable-http') {
      transport = new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } })
    } else {
      transport = new SSEClientTransport(url, { authProvider, requestInit: { headers } })
    }

    // Set up message and error handlers
    transport.onmessage = (message) => {
      log('Received message:', JSON.stringify(message, null, 2))
    }

    transport.onerror = (error) => {
      log('Transport error:', error)
    }

    transport.onclose = () => {
      log('Connection closed.')
      process.exit(0)
    }
    return transport
  }

  // Initialize the first transport instance
  let currentTransport = initTransport()

  // Set up cleanup handler
  const cleanup = async () => {
    log('\nClosing connection...')
    await client.close()
    server.close()
  }
  setupSignalHandlers(cleanup)

  // Try to connect
  try {
    log('Connecting to server...')
    await client.connect(currentTransport)
    log('Connected successfully!')
  } catch (error) {
    if (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes('Unauthorized'))) {
      log('Authentication required. Waiting for authorization...')

      // Wait for the authorization code from the callback or another instance
      const code = await waitForAuthCode()

      try {
        log('Completing authorization...')
        // finishAuth should exist on both SSEClientTransport and StreamableHTTPClientTransport
        await (currentTransport as SSEClientTransport | StreamableHTTPClientTransport).finishAuth(code)

        // Create a new transport instance after auth
        log('Creating new transport after authorization...')
        currentTransport = initTransport()

        log('Re-connecting after authorization...')
        await client.connect(currentTransport)

        log('Connected successfully post-auth!')

        // Request tools list after auth
        log('Requesting tools list...')
        const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
        log('Tools:', JSON.stringify(tools, null, 2))

        // Request resources list after auth
        log('Requesting resource list...')
        const resources = await client.request({ method: 'resources/list' }, ListResourcesResultSchema)
        log('Resources:', JSON.stringify(resources, null, 2))

        log('Listening for messages. Press Ctrl+C to exit.')
      } catch (authError) {
        log('Client Authorization error:', authError)
        server.close()
        process.exit(1)
      }
    } else {
      log('Connection error:', error)
      server.close()
      process.exit(1)
    }
  }

  try {
    // Request tools list
    log('Requesting tools list...')
    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    log('Tools:', JSON.stringify(tools, null, 2))
  } catch (e) {
    log('Error requesting tools list:', e)
  }

  try {
    // Request resources list
    log('Requesting resource list...')
    const resources = await client.request({ method: 'resources/list' }, ListResourcesResultSchema)
    log('Resources:', JSON.stringify(resources, null, 2))
  } catch (e) {
    log('Error requesting resources list:', e)
  }

  log('Listening for messages. Press Ctrl+C to exit.')
}

// Parse command-line arguments and run the client
parseCommandLineArgs(process.argv.slice(2), 3333, 'Usage: npx tsx client.ts <https://server-url> [callback-port]')
  .then(({ serverUrl, callbackPort, headers, transportType }) => {
    return runClient(serverUrl, callbackPort, headers, transportType)
  })
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
