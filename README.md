# @platformatic/instrumentation-light-my-request

OpenTelemetry instrumentation for `light-my-request`, which instruments Fastify's `inject()` method for testing and internal request handling.

## Installation

```bash
npm install @platformatic/instrumentation-light-my-request
```

## Usage

This instrumentation automatically patches `light-my-request` to create OpenTelemetry spans for injected requests. This is useful because `fastify.inject()` bypasses HTTP entirely, so standard HTTP instrumentation doesn't capture these operations.

### With NodeSDK

```javascript
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LightMyRequestInstrumentation } from '@platformatic/instrumentation-light-my-request'

const sdk = new NodeSDK({
  instrumentations: [
    new LightMyRequestInstrumentation()
  ]
})

sdk.start()
```

### With registerInstrumentations

```javascript
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { LightMyRequestInstrumentation } from '@platformatic/instrumentation-light-my-request'

registerInstrumentations({
  instrumentations: [
    new LightMyRequestInstrumentation()
  ]
})
```

## Features

- **Automatic span creation**: Creates SERVER spans for each `inject()` call
- **Context propagation**: Extracts trace context from injected headers
- **Error tracking**: Records exceptions and sets appropriate span status
- **Promise and callback support**: Works with both callback and promise-based inject calls
- **Provider-agnostic**: Uses `this.tracer` getter, works with any TracerProvider

## Span Attributes

This instrumentation follows OpenTelemetry semantic conventions and sets the following attributes:

### Required Attributes
- `http.request.method`: HTTP method (GET, POST, etc.)
- `url.path`: Path portion of the URL (without query string)
- `url.scheme`: URL scheme (defaults to "http")

### Recommended Attributes
- `url.full`: Full URL of the request
- `server.address`: Server hostname (extracted from Host header)
- `server.port`: Server port (extracted from Host header)
- `client.address`: Client IP address (from `remoteAddress` option)
- `user_agent.original`: User-Agent header value
- `network.protocol.version`: HTTP protocol version (if available)

### Conditionally Required Attributes
- `http.response.status_code`: HTTP status code (set when response is received)
- `url.query`: Query string portion of the URL (set when query parameters are present)
- `error.type`: Error type/name for exceptions, or HTTP status code for 4xx/5xx responses

## Why This Instrumentation?

Fastify's `inject()` method is used for:
- Testing Fastify applications
- Internal request routing (e.g., in Platformatic's thread-interceptor)
- Simulating HTTP requests without network overhead

Since these requests bypass HTTP, standard HTTP instrumentation doesn't see them. This instrumentation fills that gap by patching `light-my-request` directly.

## Compatibility

- **light-my-request**: >=4.0.0
- **Node.js**: >=20.0.0
- **@opentelemetry/api**: ^1.0.0
- Works with any OpenTelemetry-compatible TracerProvider

## License

Apache-2.0
