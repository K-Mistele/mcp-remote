#!/usr/bin/env node

/**
 * MCP Proxy with OAuth support
 * A bidirectional proxy between a local STDIO MCP server and a remote SSE server with OAuth authentication.
 *
 * Run with: npx tsx proxy.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EventEmitter } from 'events'
import { coordinateAuth } from './lib/coordination'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import {
  connectToRemoteServer,
  getServerUrlHash,
  log,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportType,
} from './lib/utils.js'

/**
 * Main function to run the proxy
 */
async function runProxy(serverUrl: string, callbackPort: number, headers: Record<string, string>, transportType: TransportType) {
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
    clientName: 'MCP CLI Proxy',
  })

  // If auth was completed by another instance, just log that we'll use the auth from disk
  if (skipBrowserAuth) {
    log('Authentication was completed by another instance - will use tokens from disk')
    await new Promise((res) => setTimeout(res, 1_000))
  }

  // Create the STDIO transport for local connections
  const localTransport = new StdioServerTransport()

  try {
    // Connect to remote server (initializes and starts transport)
    const { transport: remoteTransport, sseEventSourceInit } = await connectToRemoteServer(
      serverUrl,
      authProvider,
      headers,
      transportType,
      waitForAuthCode,
      skipBrowserAuth,
    )

    // Set up bidirectional proxy, passing necessary auth dependencies
    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport,
      // Pass dependencies needed for re-auth during send (HTTP only)
      authProvider,
      headers,
      transportType,
      waitForAuthCode,
      serverUrl,
    })

    // Start the local STDIO server
    await localTransport.start()
    log('Local STDIO server running')
    log(`Proxy established successfully between local STDIO and remote ${transportType}`)
    log('Press Ctrl+C to exit')

    // Setup cleanup handler
    const cleanup = async () => {
      await remoteTransport.close() // Assuming mcpProxy doesn't replace this reference externally
      await localTransport.close()
      server.close()
    }
    setupSignalHandlers(cleanup)
  } catch (error) {
    log('Fatal error during proxy setup or connection:', error)
    if (error instanceof Error && error.message.includes('self-signed certificate in certificate chain')) {
      log(`You may be behind a VPN!

If you are behind a VPN, you can try setting the NODE_EXTRA_CA_CERTS environment variable to point
to the CA certificate file. If using claude_desktop_config.json, this might look like:

{
  "mcpServers": {
    "\${mcpServerName}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "\${your CA certificate file path}.pem"
      }
    }
  }
}
        `)
    }
    server.close()
    process.exit(1)
  }
}

// Parse command-line arguments and run the proxy
parseCommandLineArgs(process.argv.slice(2), 3334, 'Usage: npx tsx proxy.ts <https://server-url> [callback-port]')
  .then(({ serverUrl, callbackPort, headers, transportType }) => {
    return runProxy(serverUrl, callbackPort, headers, transportType)
  })
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
