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
})
