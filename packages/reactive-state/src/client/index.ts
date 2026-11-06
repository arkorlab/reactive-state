/**
 * What an application's server reaches the authority with, whichever authority it is: the Node
 * process on a developer's machine over HTTP (`httpClient`), or the Durable Object on Cloudflare
 * over its binding (`bindingClient`). Both answer the contract (`AuthorityClient`), every answer a
 * `Result`. Runtime-neutral, and free of `cloudflare:workers`: code `next build` evaluates in Node
 * imports it.
 */
export {
  AUTHORITY_OBJECT_NAME,
  type AuthorityClient,
  type Caller,
  type PublicView,
  type SessionId,
  type SignedIn,
} from './contract.ts';
export {
  type AuthorityNamespace,
  type AuthorityStub,
  bindingClient,
  type BindingClientOptions,
} from './binding.ts';
export { httpClient, type HttpClientOptions } from './http.ts';
export {
  AUTHORITY_UNAVAILABLE,
  type Failure,
  HTTP_SERVICE_UNAVAILABLE,
  REQUEST_TIMEOUT_MS,
} from './results.ts';
