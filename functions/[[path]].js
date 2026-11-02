// Keep API requests and WebSocket upgrades on the frontend's origin.
export function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  const upstream = new URL(env.BACKEND_ORIGIN);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return fetch(new Request(upstream, request));
}
