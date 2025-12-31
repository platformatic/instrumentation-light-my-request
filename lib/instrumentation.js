'use strict'

const { context, propagation, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api')
const {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition
} = require('@opentelemetry/instrumentation')
const {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_QUERY,
  ATTR_URL_SCHEME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_CLIENT_ADDRESS,
  ATTR_USER_AGENT_ORIGINAL,
  ATTR_NETWORK_PROTOCOL_VERSION,
  ATTR_ERROR_TYPE
} = require('@opentelemetry/semantic-conventions')
const pkg = require('../package.json')

const { name, version } = pkg

const MODULE_NAME = 'light-my-request'
const kOriginal = Symbol('original')

/**
 * OpenTelemetry instrumentation for light-my-request
 * Instruments Fastify's inject() calls which bypass HTTP
 */
class LightMyRequestInstrumentation extends InstrumentationBase {
  constructor (config = {}) {
    super(name, version, config)
    this._requestHook = config.requestHook
    this._responseHook = config.responseHook
  }

  /**
   * Initialize the instrumentation
   * @returns {InstrumentationNodeModuleDefinition[]} Module definitions to patch
   */
  init () {
    const patch = this._patch.bind(this)
    const unpatch = this._unpatch.bind(this)
    const definition = new InstrumentationNodeModuleDefinition(MODULE_NAME, ['>=4.0.0'], patch, unpatch)
    return [definition]
  }

  /**
   * Patch the light-my-request module
   * @param {*} moduleExports - The module exports to patch
   * @param {string} moduleVersion - The module version
   * @returns {*} The patched module exports
   */
  _patch (moduleExports, moduleVersion) {
    this._diag.debug(`Applying patch for ${MODULE_NAME}@${moduleVersion}`)

    // Detect ESM vs CommonJS using the same method as @opentelemetry/instrumentation-http
    const isESM = moduleExports?.[Symbol.toStringTag] === 'Module'
    if (isESM) {
      if (typeof moduleExports?.default !== 'function') {
        const message = `${MODULE_NAME}@${moduleVersion} ESM module has no function default export. Cannot patch.`
        this._diag.warn(message)
        return moduleExports
      }

      // Patch the default export
      const original = moduleExports.default
      const patchedInject = this._patchInject()(original)
      patchedInject[kOriginal] = original

      // Copy properties from original
      Object.keys(original).forEach(key => {
        patchedInject[key] = original[key]
      })

      // Mutate the moduleExports.default in place
      moduleExports.default = patchedInject

      // Return the default export (the patched function) for ESM imports
      return moduleExports.default
    }

    if (typeof moduleExports !== 'function') {
      const keys = moduleExports ? Object.keys(moduleExports) : []
      const message =
        `${MODULE_NAME}@${moduleVersion} module export is not a function (type: ${typeof moduleExports}). ` +
        `Keys: [${keys.join(', ')}]. Cannot patch.`
      this._diag.warn(message)
      return moduleExports
    }

    // The main export is a function, so we need to wrap it directly
    const patchedInject = this._patchInject()(moduleExports)

    // Store the original on the patched version using a symbol
    // so we can restore it during unpatch
    patchedInject[kOriginal] = moduleExports

    // Copy all properties from the original to the patched version
    Object.keys(moduleExports).forEach(key => {
      patchedInject[key] = moduleExports[key]
    })

    // Also update the named exports with the patched version
    patchedInject.default = patchedInject
    patchedInject.inject = patchedInject

    return patchedInject
  }

  /**
   * Unpatch the light-my-request module
   * @param {*} moduleExports - The module exports to unpatch
   * @param {string} moduleVersion - The module version
   * @returns {*} The unpatched module exports
   */
  _unpatch (moduleExports, moduleVersion) {
    this._diag.debug(`Removing patch for ${MODULE_NAME}@${moduleVersion}`)
    // Retrieve the original function we stored during patch
    const original = moduleExports[kOriginal]
    if (original) {
      return original
    }
    // If no original found, return as-is (shouldn't happen)
    return moduleExports
  }

  /**
   * Create the patch for the inject function
   * @returns {Function} The wrapper function
   */
  _patchInject () {
    const instrumentation = this

    return (original) => {
      return function patchedInject (dispatchFunc, options, callback) {
        // Normalize options
        const opts = typeof options === 'string' || options instanceof URL
          ? { url: options.toString() }
          : { ...options }

        // Extract context from headers if present
        const activeContext = opts.headers
          ? propagation.extract(context.active(), opts.headers)
          : context.active()

        const method = (opts.method || 'GET').toUpperCase()
        const url = opts.url || '/'

        // Parse URL to extract path and query
        const [urlPath, urlQuery] = url.split('?')

        // Extract server information from headers
        const attributes = {
          [ATTR_HTTP_REQUEST_METHOD]: method,
          [ATTR_URL_FULL]: url,
          [ATTR_URL_PATH]: urlPath,
          [ATTR_URL_SCHEME]: 'http' // light-my-request doesn't use actual HTTP, default to http
        }

        // Add query string if present (conditionally required)
        if (urlQuery) {
          attributes[ATTR_URL_QUERY] = urlQuery
        }

        // Add client.address (recommended)
        if (opts.remoteAddress) {
          attributes[ATTR_CLIENT_ADDRESS] = opts.remoteAddress
        }

        // Add user_agent.original (recommended)
        const userAgent = opts.headers?.['user-agent'] || opts.headers?.['User-Agent']
        if (userAgent) {
          attributes[ATTR_USER_AGENT_ORIGINAL] = userAgent
        }

        // Add network.protocol.version if available (recommended)
        // Check for HTTP version in headers or other sources
        const httpVersion = opts.headers?.['http-version'] || opts.headers?.httpVersion
        if (httpVersion) {
          attributes[ATTR_NETWORK_PROTOCOL_VERSION] = httpVersion
        }

        // Extract server.address and server.port from Host header if present
        if (opts.headers?.host || opts.headers?.Host) {
          const host = opts.headers.host || opts.headers.Host
          const [address, port] = host.split(':')
          attributes[ATTR_SERVER_ADDRESS] = address
          if (port) {
            attributes[ATTR_SERVER_PORT] = parseInt(port, 10)
          }
        }

        // Start a SERVER span (inject simulates server receiving request)
        const span = instrumentation.tracer.startSpan(`${method} ${url}`, {
          kind: SpanKind.SERVER,
          attributes
        }, activeContext)

        const spanContext = trace.setSpan(activeContext, span)

        // Call requestHook if provided
        if (instrumentation._requestHook) {
          try {
            instrumentation._requestHook(span, opts)
          } catch (err) {
            instrumentation._diag.error('requestHook threw an error', err)
          }
        }

        // Handle callback style
        if (typeof callback === 'function') {
          const wrappedCallback = wrapCallback(span, callback, instrumentation)

          // Run the original inject within the span context
          return context.with(spanContext, () => {
            return original.call(this, dispatchFunc, opts, wrappedCallback)
          })
        }

        // Handle promise style
        return context.with(spanContext, () => {
          const result = original.call(this, dispatchFunc, opts)

          // Ensure we have a promise
          if (result && typeof result.then === 'function') {
            return wrapPromise(span, result, instrumentation)
          }

          // If not a promise (shouldn't happen), just return it
          return result
        })
      }
    }
  }
}

function onResponse (span, response, instrumentation) {
  const statusCode = response.statusCode || 200
  span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)

  // Set error.type for error responses (4xx and 5xx)
  if (statusCode >= 400) {
    span.setAttribute(ATTR_ERROR_TYPE, String(statusCode))
  }

  const code = statusCode >= 400
    ? SpanStatusCode.ERROR
    : SpanStatusCode.OK
  span.setStatus({ code })

  // Call responseHook if provided
  if (instrumentation?._responseHook) {
    try {
      instrumentation._responseHook(span, response)
    } catch (err) {
      instrumentation._diag.error('responseHook threw an error', err)
    }
  }

  span.end()
}

function onError (span, error) {
  span.recordException(error)

  // Set error.type to the error class name or type
  const errorType = error.name || error.constructor?.name || 'Error'
  span.setAttribute(ATTR_ERROR_TYPE, errorType)

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message
  })
  span.end()
}

function wrapCallback (span, callback, instrumentation) {
  return function wrappedCallback (error, response) {
    if (error) {
      onError(span, error)
    } else if (response) {
      onResponse(span, response, instrumentation)
    }
    return callback.call(this, error, response)
  }
}

function wrapPromise (span, promise, instrumentation) {
  function fulfill (response) {
    onResponse(span, response, instrumentation)
    return response
  }
  function reject (error) {
    onError(span, error)
    return Promise.reject(error)
  }
  return promise.then(fulfill, reject)
}

module.exports = {
  LightMyRequestInstrumentation,
  name,
  version
}
