'use strict'

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { context, propagation, trace, SpanStatusCode } = require('@opentelemetry/api')
const { ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_URL_FULL, ATTR_URL_PATH } = require('@opentelemetry/semantic-conventions')
const { LightMyRequestInstrumentation } = require('../lib/instrumentation.js')

describe('LightMyRequestInstrumentation', () => {
  let instrumentation
  let provider
  let exporter
  let inject

  // Simple dispatch function for testing
  const dispatch = (req, res) => {
    const reply = 'OK'
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(reply)
  }

  before(() => {
    // Create and configure tracer provider with in-memory exporter
    exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider()
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
    provider.register()

    // Create and enable instrumentation BEFORE requiring light-my-request
    instrumentation = new LightMyRequestInstrumentation()
    instrumentation.setTracerProvider(provider)
    instrumentation.enable()

    // NOW require light-my-request after instrumentation is enabled
    inject = require('light-my-request')
  })

  beforeEach(() => {
    // Reset exporter between tests
    exporter.reset()
  })

  after(() => {
    // Clean up
    instrumentation.disable()
    provider.shutdown()
  })

  describe('Basic Functionality', () => {
    it('should create SERVER span for inject call (promise style)', async () => {
      await inject(dispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].kind, 1) // SpanKind.SERVER
    })

    it('should create SERVER span for inject call (callback style)', (_, done) => {
      inject(dispatch, { method: 'GET', url: '/test' }, (err, res) => {
        assert.ifError(err)

        const spans = exporter.getFinishedSpans()
        assert.strictEqual(spans.length, 1)
        assert.strictEqual(spans[0].kind, 1) // SpanKind.SERVER
        done()
      })
    })

    it('should set correct span name (METHOD url)', async () => {
      await inject(dispatch, { method: 'POST', url: '/api/users' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].name, 'POST /api/users')
    })

    it('should set ATTR_HTTP_REQUEST_METHOD attribute', async () => {
      await inject(dispatch, { method: 'PUT', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_HTTP_REQUEST_METHOD], 'PUT')
    })

    it('should set ATTR_URL_FULL attribute', async () => {
      await inject(dispatch, { method: 'GET', url: '/test?foo=bar' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_FULL], '/test?foo=bar')
    })

    it('should set ATTR_URL_PATH attribute (strips query string)', async () => {
      await inject(dispatch, { method: 'GET', url: '/test?foo=bar&baz=qux' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_PATH], '/test')
    })

    it('should set ATTR_HTTP_RESPONSE_STATUS_CODE on response', async () => {
      const customDispatch = (req, res) => {
        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.end('Created')
      }

      await inject(customDispatch, { method: 'POST', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_HTTP_RESPONSE_STATUS_CODE], 201)
    })
  })

  describe('URL Handling', () => {
    it('should handle string URL', async () => {
      await inject(dispatch, '/test')

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_FULL], '/test')
    })

    it('should handle URL object', async () => {
      await inject(dispatch, new URL('http://localhost/test'))

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_FULL], 'http://localhost/test')
    })

    it('should handle options object with url property', async () => {
      await inject(dispatch, { url: '/api/test', method: 'GET' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_FULL], '/api/test')
    })

    it('should default to / when no URL provided', async () => {
      await inject(dispatch, { url: '/' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_URL_FULL], '/')
    })

    it('should default to GET when no method provided', async () => {
      await inject(dispatch, { url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].attributes[ATTR_HTTP_REQUEST_METHOD], 'GET')
    })
  })

  describe('Context Propagation', () => {
    it('should extract trace context from headers', async () => {
      // Create a parent span and inject its context into headers
      const parentSpan = provider.getTracer('test').startSpan('parent')
      const ctx = trace.setSpan(context.active(), parentSpan)
      const headers = {}
      propagation.inject(ctx, headers)

      // Make inject call with those headers
      await inject(dispatch, { method: 'GET', url: '/test', headers })

      parentSpan.end()

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans.length, 2)

      // Find the inject span (not the parent)
      const injectSpan = spans.find(s => s.name === 'GET /test')
      assert.ok(injectSpan)

      // Verify it's a child of the parent span
      assert.strictEqual(injectSpan.parentSpanId, parentSpan.spanContext().spanId)
    })

    it('should use active context when no headers present', async () => {
      const parentSpan = provider.getTracer('test').startSpan('parent')
      const ctx = trace.setSpan(context.active(), parentSpan)

      await context.with(ctx, async () => {
        await inject(dispatch, { method: 'GET', url: '/test' })
      })

      parentSpan.end()

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans.length, 2)

      const injectSpan = spans.find(s => s.name === 'GET /test')
      assert.ok(injectSpan)
      assert.strictEqual(injectSpan.parentSpanId, parentSpan.spanContext().spanId)
    })

    it('should propagate context to dispatch function', async () => {
      let capturedSpan = null

      const contextAwareDispatch = (req, res) => {
        capturedSpan = trace.getActiveSpan()
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
      }

      await inject(contextAwareDispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.ok(capturedSpan)
      assert.strictEqual(capturedSpan.spanContext().spanId, spans[0].spanContext().spanId)
    })
  })

  describe('Status Handling', () => {
    it('should set SpanStatusCode.OK for 2xx responses', async () => {
      const customDispatch = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
      }

      await inject(customDispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].status.code, SpanStatusCode.OK)
    })

    it('should set SpanStatusCode.OK for 3xx responses', async () => {
      const customDispatch = (req, res) => {
        res.writeHead(302, { Location: '/redirect' })
        res.end()
      }

      await inject(customDispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].status.code, SpanStatusCode.OK)
    })

    it('should set SpanStatusCode.ERROR for 4xx responses', async () => {
      const customDispatch = (req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      }

      await inject(customDispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR)
    })

    it('should set SpanStatusCode.ERROR for 5xx responses', async () => {
      const customDispatch = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }

      await inject(customDispatch, { method: 'GET', url: '/test' })

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR)
    })
  })

  describe('Error Handling', () => {
    it('should record exception on error (promise rejection)', async () => {
      const errorDispatch = (req, res) => {
        throw new Error('Test error')
      }

      await assert.rejects(
        inject(errorDispatch, { method: 'GET', url: '/test' }),
        /Test error/
      )

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR)
      assert.strictEqual(spans[0].status.message, 'Test error')

      const events = spans[0].events
      const exceptionEvent = events.find(e => e.name === 'exception')
      assert.ok(exceptionEvent)
      assert.strictEqual(exceptionEvent.attributes['exception.message'], 'Test error')
    })

    it('should record exception on error (callback error)', (_, done) => {
      const errorDispatch = (req, res) => {
        // Instead of throwing, set error status
        res.writeHead(500)
        res.end('Error')
      }

      inject(errorDispatch, { method: 'GET', url: '/test' }, (err, res) => {
        assert.ifError(err)

        const spans = exporter.getFinishedSpans()
        assert.strictEqual(spans.length, 1)
        // 500 status should set ERROR status code
        assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR)
        done()
      })
    })

    it('should set SpanStatusCode.ERROR with error message', async () => {
      const errorDispatch = (req, res) => {
        throw new Error('Custom error message')
      }

      await assert.rejects(
        inject(errorDispatch, { method: 'GET', url: '/test' })
      )

      const spans = exporter.getFinishedSpans()
      assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR)
      assert.strictEqual(spans[0].status.message, 'Custom error message')
    })
  })

  describe('Request Hook', () => {
    let hookInstrumentation
    let hookProvider
    let hookExporter
    let hookInject

    beforeEach(() => {
      hookExporter = new InMemorySpanExporter()
      hookProvider = new NodeTracerProvider()
      hookProvider.addSpanProcessor(new SimpleSpanProcessor(hookExporter))
      hookProvider.register()
    })

    after(() => {
      if (hookInstrumentation) {
        hookInstrumentation.disable()
      }
      if (hookProvider) {
        hookProvider.shutdown()
      }
    })

    it('should call requestHook when provided (promise style)', async () => {
      let hookCalled = false
      let capturedSpan = null
      let capturedOpts = null

      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          hookCalled = true
          capturedSpan = span
          capturedOpts = opts
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      // Import a fresh instance
      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'POST', url: '/api/test', payload: { foo: 'bar' } })

      assert.strictEqual(hookCalled, true)
      assert.ok(capturedSpan)
      assert.ok(capturedOpts)
      assert.strictEqual(capturedOpts.method, 'POST')
      assert.strictEqual(capturedOpts.url, '/api/test')
      assert.deepStrictEqual(capturedOpts.payload, { foo: 'bar' })
    })

    it('should call requestHook when provided (callback style)', (_, done) => {
      let hookCalled = false
      let capturedSpan = null
      let capturedOpts = null

      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          hookCalled = true
          capturedSpan = span
          capturedOpts = opts
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      hookInject(dispatch, { method: 'GET', url: '/test' }, (err, res) => {
        assert.ifError(err)
        assert.strictEqual(hookCalled, true)
        assert.ok(capturedSpan)
        assert.ok(capturedOpts)
        assert.strictEqual(capturedOpts.method, 'GET')
        assert.strictEqual(capturedOpts.url, '/test')
        done()
      })
    })

    it('should allow requestHook to add custom span attributes', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          span.setAttribute('custom.attribute', 'test-value')
          span.setAttribute('custom.method', opts.method)
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'PUT', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].attributes['custom.attribute'], 'test-value')
      assert.strictEqual(spans[0].attributes['custom.method'], 'PUT')
    })

    it('should not fail if requestHook is not provided', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation()
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
    })

    it('should handle requestHook that throws an error', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          throw new Error('Hook error')
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      // The error in the hook should be caught and logged, but not prevent the request from completing
      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].status.code, SpanStatusCode.OK)
    })
  })

  describe('Response Hook', () => {
    let hookInstrumentation
    let hookProvider
    let hookExporter
    let hookInject

    beforeEach(() => {
      hookExporter = new InMemorySpanExporter()
      hookProvider = new NodeTracerProvider()
      hookProvider.addSpanProcessor(new SimpleSpanProcessor(hookExporter))
      hookProvider.register()
    })

    after(() => {
      if (hookInstrumentation) {
        hookInstrumentation.disable()
      }
      if (hookProvider) {
        hookProvider.shutdown()
      }
    })

    it('should call responseHook when provided (promise style)', async () => {
      let hookCalled = false
      let capturedSpan = null
      let capturedResponse = null

      hookInstrumentation = new LightMyRequestInstrumentation({
        responseHook: (span, response) => {
          hookCalled = true
          capturedSpan = span
          capturedResponse = response
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      assert.strictEqual(hookCalled, true)
      assert.ok(capturedSpan)
      assert.ok(capturedResponse)
      assert.strictEqual(capturedResponse.statusCode, 200)
    })

    it('should call responseHook when provided (callback style)', (_, done) => {
      let hookCalled = false
      let capturedSpan = null
      let capturedResponse = null

      hookInstrumentation = new LightMyRequestInstrumentation({
        responseHook: (span, response) => {
          hookCalled = true
          capturedSpan = span
          capturedResponse = response
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      hookInject(dispatch, { method: 'POST', url: '/test' }, (err, res) => {
        assert.ifError(err)
        assert.strictEqual(hookCalled, true)
        assert.ok(capturedSpan)
        assert.ok(capturedResponse)
        assert.strictEqual(capturedResponse.statusCode, 200)
        done()
      })
    })

    it('should allow responseHook to add custom span attributes', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation({
        responseHook: (span, response) => {
          span.setAttribute('custom.status', response.statusCode)
          span.setAttribute('custom.payload', response.payload)
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].attributes['custom.status'], 200)
      assert.ok(spans[0].attributes['custom.payload'])
    })

    it('should call responseHook with error responses', async () => {
      let hookCalled = false
      let capturedResponse = null

      hookInstrumentation = new LightMyRequestInstrumentation({
        responseHook: (span, response) => {
          hookCalled = true
          capturedResponse = response
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      const errorDispatch = (req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      }

      await hookInject(errorDispatch, { method: 'GET', url: '/test' })

      assert.strictEqual(hookCalled, true)
      assert.ok(capturedResponse)
      assert.strictEqual(capturedResponse.statusCode, 404)
    })

    it('should not fail if responseHook is not provided', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation()
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
    })

    it('should handle responseHook that throws an error', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation({
        responseHook: (span, response) => {
          throw new Error('Hook error')
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      // The error in the hook should be caught and logged, but not prevent the response from being returned
      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].status.code, SpanStatusCode.OK)
    })
  })

  describe('Combined Hooks', () => {
    let hookInstrumentation
    let hookProvider
    let hookExporter
    let hookInject

    beforeEach(() => {
      hookExporter = new InMemorySpanExporter()
      hookProvider = new NodeTracerProvider()
      hookProvider.addSpanProcessor(new SimpleSpanProcessor(hookExporter))
      hookProvider.register()
    })

    after(() => {
      if (hookInstrumentation) {
        hookInstrumentation.disable()
      }
      if (hookProvider) {
        hookProvider.shutdown()
      }
    })

    it('should call both requestHook and responseHook in order', async () => {
      const callOrder = []

      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          callOrder.push('request')
          span.setAttribute('custom.request', 'true')
        },
        responseHook: (span, response) => {
          callOrder.push('response')
          span.setAttribute('custom.response', 'true')
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      assert.deepStrictEqual(callOrder, ['request', 'response'])

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spans[0].attributes['custom.request'], 'true')
      assert.strictEqual(spans[0].attributes['custom.response'], 'true')
    })

    it('should call both hooks with callback style', (_, done) => {
      const callOrder = []

      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          callOrder.push('request')
        },
        responseHook: (span, response) => {
          callOrder.push('response')
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      hookInject(dispatch, { method: 'GET', url: '/test' }, (err, res) => {
        assert.ifError(err)
        assert.deepStrictEqual(callOrder, ['request', 'response'])
        done()
      })
    })

    it('should allow hooks to share data via span attributes', async () => {
      hookInstrumentation = new LightMyRequestInstrumentation({
        requestHook: (span, opts) => {
          span.setAttribute('request.timestamp', Date.now())
        },
        responseHook: (span, response) => {
          const requestTime = span.attributes['request.timestamp']
          assert.ok(requestTime)
          span.setAttribute('response.duration', Date.now() - requestTime)
        }
      })
      hookInstrumentation.setTracerProvider(hookProvider)
      hookInstrumentation.enable()

      delete require.cache[require.resolve('light-my-request')]
      hookInject = require('light-my-request')

      await hookInject(dispatch, { method: 'GET', url: '/test' })

      const spans = hookExporter.getFinishedSpans()
      assert.strictEqual(spans.length, 1)
      assert.ok(spans[0].attributes['request.timestamp'])
      assert.ok(spans[0].attributes['response.duration'] >= 0)
    })
  })
})
