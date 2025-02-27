import type { Debugger } from 'debug'
import { Headers, Request } from '@remix-run/web-fetch'
import { headersToString } from 'headers-polyfill'
import { concatArrayBuffer } from './utils/concatArrayBuffer'
import { createEvent } from './utils/createEvent'
import {
  decodeBuffer,
  encodeBuffer,
  toArrayBuffer,
} from '../../utils/bufferUtils'
import { createProxy } from '../../utils/createProxy'
import { isDomParserSupportedType } from './utils/isDomParserSupportedType'
import { parseJson } from '../../utils/parseJson'
import { uuidv4 } from '../../utils/uuid'
import { createResponse } from './utils/createResponse'
import { invariant } from 'outvariant'

/**
 * An `XMLHttpRequest` instance controller that allows us
 * to handle any given request instance (e.g. responding to it).
 */
export class XMLHttpRequestController {
  public request: XMLHttpRequest
  public requestId?: string
  public onRequest?: (
    this: XMLHttpRequestController,
    request: Request,
    requestId: string
  ) => Promise<void>
  public onResponse?: (
    this: XMLHttpRequestController,
    response: Response,
    request: Request,
    requestId: string
  ) => void

  private method: string = 'GET'
  private url: URL = null as any
  private requestHeaders: Headers
  private requestBody?: XMLHttpRequestBodyInit | Document | null
  private responseBuffer: Uint8Array
  private events: Map<keyof XMLHttpRequestEventTargetEventMap, Array<Function>>

  constructor(readonly initialRequest: XMLHttpRequest, public log: Debugger) {
    this.events = new Map()
    this.requestHeaders = new Headers()
    this.responseBuffer = new Uint8Array()

    this.request = createProxy(initialRequest, {
      setProperty: ([propertyName, nextValue], invoke) => {
        /**
         * @note Setting the "withCredentials" property on the XHR proxy
         * causes the "TypeError: Illegal invocation" error. Instead,
         * define the property on the original XHR instance itself.
         */
        if (propertyName === 'withCredentials') {
          define(this.request, 'withCredentials', nextValue)
          return true
        }

        return invoke()
      },
      methodCall: ([methodName, args], invoke) => {
        switch (methodName) {
          case 'open': {
            const [method, url] = args as [string, string | undefined]

            this.requestId = uuidv4()

            if (typeof url === 'undefined') {
              this.method = 'GET'
              this.url = toAbsoluteUrl(method)
            } else {
              this.method = method
              this.url = toAbsoluteUrl(url)
            }

            this.log = this.log.extend(`${this.method} ${this.url.href}`)
            this.log('open', this.method, this.url.href)

            return invoke()
          }

          case 'addEventListener': {
            const [eventName, listener] = args as [
              keyof XMLHttpRequestEventTargetEventMap,
              Function
            ]
            this.registerEvent(eventName, listener)

            this.log('addEventListener', eventName, listener.name)

            return invoke()
          }

          case 'setRequestHeader': {
            const [name, value] = args as [string, string]
            this.requestHeaders.set(name, value)

            this.log('setRequestHeader', name, value)

            return invoke()
          }

          case 'send': {
            const [body] = args as [
              body?: XMLHttpRequestBodyInit | Document | null
            ]

            if (body != null) {
              this.requestBody =
                typeof body === 'string' ? encodeBuffer(body) : body
            }

            this.request.addEventListener('load', () => {
              if (typeof this.onResponse !== 'undefined') {
                // Create a Fetch API Response representation of whichever
                // response this XMLHttpRequest received. Note those may
                // be either a mocked and the original response.
                const fetchResponse = createResponse(
                  this.request,
                  /**
                   * The `response` property is the right way to read
                   * the ambiguous response body, as the request's "responseTyoe"
                   * may differ.
                   * @see https://xhr.spec.whatwg.org/#the-response-attribute
                   */
                  this.request.response
                )

                // Notify the consumer about the response.
                this.onResponse.call(
                  this,
                  fetchResponse,
                  fetchRequest,
                  this.requestId!
                )
              }
            })

            // Delegate request handling to the consumer.
            const fetchRequest = this.toFetchApiRequest()
            const onceRequestSettled =
              this.onRequest?.call(this, fetchRequest, this.requestId!) ||
              Promise.resolve()

            onceRequestSettled.finally(() => {
              // If the consumer didn't handle the request perform it as-is.
              // Note that the request may not yet be DONE and may, in fact,
              // be LOADING while the "respondWith" method does its magic.
              if (this.request.readyState < this.request.LOADING) {
                this.log(
                  'request callback settled but request has not been handled (readystate %d), performing as-is...',
                  this.request.readyState
                )

                /**
                 * @note Set the intercepted request ID on the original request
                 * so that if it triggers any other interceptors, they don't attempt
                 * to process it once again.
                 *
                 * For instance, XMLHttpRequest is often implemented via "http.ClientRequest"
                 * and we don't want for both XHR and ClientRequest interceptors to
                 * handle the same request at the same time (e.g. emit the "response" event twice).
                 */
                this.request.setRequestHeader('X-Request-Id', this.requestId!)

                return invoke()
              }
            })

            break
          }

          case 'onabort':
          case 'onerror':
          case 'onload':
          case 'onloadend':
          case 'onloadstart':
          case 'onprogress':
          case 'ontimeout':
          case 'onreadystatechange': {
            const [listener] = args as [Function]
            this.registerEvent(
              methodName as keyof XMLHttpRequestEventTargetEventMap,
              listener
            )
            return invoke()
          }

          default: {
            return invoke()
          }
        }
      },
    })
  }

  private registerEvent(
    eventName: keyof XMLHttpRequestEventTargetEventMap,
    listener: Function
  ): void {
    const prevEvents = this.events.get(eventName) || []
    const nextEvents = prevEvents.concat(listener)
    this.events.set(eventName, nextEvents)

    this.log('registered event "%s"', eventName, listener.name)
  }

  /**
   * Responds to the current request with the given
   * Fetch API `Response` instance.
   */
  public respondWith(response: Response): void {
    this.log(
      'responding with a mocked response: %d %s',
      response.status,
      response.statusText
    )

    define(this.request, 'status', response.status)
    define(this.request, 'statusText', response.statusText)
    define(this.request, 'responseURL', this.url.href)

    this.request.getResponseHeader = new Proxy(this.request.getResponseHeader, {
      apply: (_, __, args: [name: string]) => {
        this.log('getResponseHeader', args[0])

        if (this.request.readyState < this.request.HEADERS_RECEIVED) {
          this.log('headers not received yet, returning null')

          // Headers not received yet, nothing to return.
          return null
        }

        const headerValue = response.headers.get(args[0])
        this.log('resolved response header "%s" to', args[0], headerValue)

        return headerValue
      },
    })

    this.request.getAllResponseHeaders = new Proxy(
      this.request.getAllResponseHeaders,
      {
        apply: () => {
          this.log('getAllResponseHeaders')

          if (this.request.readyState < this.request.HEADERS_RECEIVED) {
            this.log('headers not received yet, returning empty string')

            // Headers not received yet, nothing to return.
            return ''
          }

          const allHeaders = headersToString(response.headers)
          this.log('resolved all response headers to', allHeaders)

          return allHeaders
        },
      }
    )

    // Update the response getters to resolve against the mocked response.
    Object.defineProperties(this.request, {
      response: {
        enumerable: true,
        get: () => this.response,
      },
      responseText: {
        enumerable: true,
        get: () => this.responseText,
      },
      responseXML: {
        enumerable: true,
        get: () => this.responseXML,
      },
    })

    const totalResponseBodyLength = response.headers.has('Content-Length')
      ? Number(response.headers.get('Content-Length'))
      : /**
         * @todo Infer the response body length from the response body.
         */
        undefined

    this.log('calculated response body length', totalResponseBodyLength)

    this.trigger('loadstart', {
      loaded: 0,
      total: totalResponseBodyLength,
    })

    this.setReadyState(this.request.HEADERS_RECEIVED)
    this.setReadyState(this.request.LOADING)

    const finalizeResponse = () => {
      this.log('finalizing the mocked response...')

      this.setReadyState(this.request.DONE)

      this.trigger('load', {
        loaded: this.responseBuffer.byteLength,
        total: totalResponseBodyLength,
      })

      this.trigger('loadend', {
        loaded: this.responseBuffer.byteLength,
        total: totalResponseBodyLength,
      })
    }

    if (response.body) {
      this.log('mocked response has body, streaming...')

      const reader = response.body.getReader()

      const readNextResponseBodyChunk = async () => {
        const { value, done } = await reader.read()

        if (done) {
          this.log('response body stream done!')
          finalizeResponse()
          return
        }

        if (value) {
          this.log('read response body chunk:', value)
          this.responseBuffer = concatArrayBuffer(this.responseBuffer, value)

          this.trigger('progress', {
            loaded: this.responseBuffer.byteLength,
            total: totalResponseBodyLength,
          })
        }

        readNextResponseBodyChunk()
      }

      readNextResponseBodyChunk()
    } else {
      finalizeResponse()
    }
  }

  private responseBufferToText(): string {
    return decodeBuffer(this.responseBuffer)
  }

  get response(): unknown {
    this.log('getResponse (responseType: %s)', this.request.responseType)

    if (this.request.readyState !== this.request.DONE) {
      return null
    }

    switch (this.request.responseType) {
      case 'json': {
        const responseJson = parseJson(this.responseBufferToText())
        this.log('resolved response JSON', responseJson)

        return responseJson
      }

      case 'arraybuffer': {
        const arrayBuffer = toArrayBuffer(this.responseBuffer)
        this.log('resolved response ArrayBuffer', arrayBuffer)

        return arrayBuffer
      }

      case 'blob': {
        const mimeType =
          this.request.getResponseHeader('Content-Type') || 'text/plain'
        const responseBlob = new Blob([this.responseBufferToText()], {
          type: mimeType,
        })

        this.log(
          'resolved response Blob (mime type: %s)',
          responseBlob,
          mimeType
        )

        return responseBlob
      }

      default: {
        const responseText = this.responseBufferToText()
        this.log(
          'resolving "%s" response type as text',
          this.request.responseType,
          responseText
        )

        return responseText
      }
    }
  }

  get responseText(): string {
    /**
     * Throw when trying to read the response body as text when the
     * "responseType" doesn't expect text. This just respects the spec better.
     * @see https://xhr.spec.whatwg.org/#the-responsetext-attribute
     */
    invariant(
      this.request.responseType === '' || this.request.responseType === 'text',
      'InvalidStateError: The object is in invalid state.'
    )

    if (
      this.request.readyState !== this.request.LOADING &&
      this.request.readyState !== this.request.DONE
    ) {
      return ''
    }

    const responseText = this.responseBufferToText()
    this.log('getResponseText: "%s"', responseText)

    return responseText
  }

  get responseXML(): Document | null {
    invariant(
      this.request.responseType === '' ||
        this.request.responseType === 'document',
      'InvalidStateError: The object is in invalid state.'
    )

    if (this.request.readyState !== this.request.DONE) {
      return null
    }

    const contentType = this.request.getResponseHeader('Content-Type') || ''

    if (typeof DOMParser === 'undefined') {
      console.warn(
        'Cannot retrieve XMLHttpRequest response body as XML: DOMParser is not defined. You are likely using an environment that is not browser or does not polyfill browser globals correctly.'
      )
      return null
    }

    if (isDomParserSupportedType(contentType)) {
      return new DOMParser().parseFromString(
        this.responseBufferToText(),
        contentType
      )
    }

    return null
  }

  public errorWith(error: Error): void {
    this.log('responding with an error')

    this.setReadyState(this.request.DONE)
    this.trigger('error')
    this.trigger('loadend')
  }

  /**
   * Transitions this request's `readyState` to the given one.
   */
  private setReadyState(nextReadyState: number): void {
    this.log('setReadyState: %d -> %d', this.request.readyState, nextReadyState)

    if (this.request.readyState === nextReadyState) {
      this.log('ready state identical, skipping transition...')
      return
    }

    define(this.request, 'readyState', nextReadyState)

    this.log('set readyState to: %d', nextReadyState)

    if (nextReadyState !== this.request.UNSENT) {
      this.log('triggerring "readystatechange" event...')

      this.trigger('readystatechange')
    }
  }

  /**
   * Triggers given event on the `XMLHttpRequest` instance.
   */
  private trigger<
    EventName extends keyof (XMLHttpRequestEventTargetEventMap & {
      readystatechange: ProgressEvent<XMLHttpRequestEventTarget>
    })
  >(eventName: EventName, options?: ProgressEventInit): void {
    const callback = this.request[`on${eventName}`]
    const event = createEvent(this.request, eventName, options)

    this.log('trigger "%s"', eventName, options || '')

    // Invoke direct callbacks.
    if (typeof callback === 'function') {
      this.log('found a direct "%s" callback, calling...', eventName)
      callback.call(this.request, event)
    }

    // Invoke event listeners.
    for (const [registeredEventName, listeners] of this.events) {
      if (registeredEventName === eventName) {
        this.log(
          'found %d listener(s) for "%s" event, calling...',
          listeners.length,
          eventName
        )

        listeners.forEach((listener) => listener.call(this.request, event))
      }
    }
  }

  /**
   * Converts this `XMLHttpRequest` instance into a Fetch API `Request` instance.
   */
  public toFetchApiRequest(): Request {
    this.log('converting request to a Fetch API Request...')

    const fetchRequest = new Request(this.url.href, {
      method: this.method,
      headers: this.requestHeaders,
      /**
       * @see https://xhr.spec.whatwg.org/#cross-origin-credentials
       */
      credentials: this.request.withCredentials ? 'include' : 'same-origin',
      body: this.requestBody as any,
    })

    const proxyHeaders = createProxy(fetchRequest.headers, {
      methodCall: ([methodName, args], invoke) => {
        // Forward the latest state of the internal request headers
        // because the interceptor might have modified them
        // without responding to the request.
        switch (methodName) {
          case 'append':
          case 'set': {
            const [headerName, headerValue] = args as [string, string]
            this.request.setRequestHeader(headerName, headerValue)
            break
          }

          case 'delete': {
            const [headerName] = args as [string]
            console.warn(
              `XMLHttpRequest: Cannot remove a "${headerName}" header from the Fetch API representation of the "${fetchRequest.method} ${fetchRequest.url}" request. XMLHttpRequest headers cannot be removed.`
            )
            break
          }
        }

        return invoke()
      },
    })
    define(fetchRequest, 'headers', proxyHeaders)

    this.log('converted request to a Fetch API Request!', fetchRequest)

    return fetchRequest
  }
}

function toAbsoluteUrl(url: string | URL): URL {
  return new URL(url.toString(), location.href)
}

function define(target: object, property: string, value: unknown): void {
  Reflect.defineProperty(target, property, {
    // Ensure writable properties to allow redefining readonly properties.
    writable: true,
    enumerable: true,
    value,
  })
}
