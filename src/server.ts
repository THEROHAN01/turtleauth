import { buildApp } from './app.js'
import { config } from './config.js'

/**
 * Production entry point. Binds the socket and handles shutdown; all wiring lives in
 * app.ts so tests can build the same app without a port.
 */

const app = buildApp()

/**
 * Drain in-flight requests before exiting. Without this, a deploy kills requests
 * mid-flight — and here that could mean a password hash completing after the response
 * socket is already gone.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    process.exit(0)
  } catch (err) {
    app.log.error({ err }, 'error during shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' })

  if (config.NODE_ENV !== 'production') {
    app.log.warn(
      'Sessions are IN-MEMORY: a restart logs everyone out, and a second instance ' +
        'would not see these sessions. Postgres comes at the end of Module 1.',
    )
  }
} catch (err) {
  app.log.error({ err }, 'failed to start')
  process.exit(1)
}
