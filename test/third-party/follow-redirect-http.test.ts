/**
 * @jest-environment jsdom
 */
import { https } from 'follow-redirects'
import { httpsAgent, HttpServer } from '@open-draft/test-server/http'
import { ClientRequestInterceptor } from '../../src/interceptors/ClientRequest'
import type { HttpRequestEventMap } from '../../src/glossary'
import { waitForClientRequest } from '../helpers'

const resolver = jest.fn<never, HttpRequestEventMap['request']>()

const interceptor = new ClientRequestInterceptor()
interceptor.on('request', resolver)

const server = new HttpServer((app) => {
  app.post('/resource', (req, res) => {
    /**
     * @note Respond with the 307 status code so the redirect
     * request would use the same method as the original request.
     * @see https://github.com/follow-redirects/follow-redirects/issues/121
     */
    res.status(307).set('Location', server.https.url('/user')).end()
  })

  app.post('/user', (req, res) => {
    res.status(200).send('hello from the server')
  })
})

beforeAll(async () => {
  await server.listen()
  interceptor.apply()
})

afterEach(() => {
  jest.resetAllMocks()
})

afterAll(async () => {
  interceptor.dispose()
  await server.close()
})

test('intercepts a POST request issued by "follow-redirects"', async () => {
  const { address } = server.https
  const payload = JSON.stringify({ todo: 'Buy the milk' })

  const catchResponseUrl = jest.fn()
  const req = https.request(
    {
      method: 'POST',
      hostname: address.host,
      port: address.port,
      path: '/resource',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      agent: httpsAgent,
    },
    (res) => {
      catchResponseUrl(res.responseUrl)
    }
  )

  req.end(payload)

  const { text } = await waitForClientRequest(req as any)

  expect(resolver).toHaveBeenCalledTimes(2)

  // Intercepted initial request.
  const [initialRequest] = resolver.mock.calls[0]

  expect(initialRequest.method).toBe('POST')
  expect(initialRequest.url).toBe(server.https.url('/resource'))
  expect(initialRequest.credentials).toBe('same-origin')
  expect(initialRequest.headers.get('Content-Type')).toBe('application/json')
  expect(initialRequest.headers.get('Content-Length')).toBe('23')
  expect(await initialRequest.json()).toEqual({ todo: 'Buy the milk' })

  // Intercepted redirect request (issued by "follow-redirects").
  const [redirectedRequest] = resolver.mock.calls[1]

  expect(redirectedRequest.method).toBe('POST')
  expect(redirectedRequest.url).toBe(server.https.url('/user'))
  expect(redirectedRequest.credentials).toBe('same-origin')
  expect(redirectedRequest.headers.get('Content-Type')).toBe('application/json')
  expect(redirectedRequest.headers.get('Content-Length')).toBe('23')
  expect(await redirectedRequest.json()).toEqual({ todo: 'Buy the milk' })

  // Response (original).
  expect(catchResponseUrl).toHaveBeenCalledWith(server.https.url('/user'))
  expect(await text()).toBe('hello from the server')
})
