import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createDemoServer } from '../demo-server';

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, 'Timed out'); await setTimeout(15); }
}

test('an abandoned open request does not make an empty room joinable; peers wait for a committed initializer', { timeout: 15000 }, async () => {
  const server = createDemoServer(0, { creationLeaseMs: 60 }); await server.listen();
  const api = `${server.httpURL}/api/rooms/startup`;
  const open = (clientId: string) => fetch(`${api}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) });
  let socket: HocuspocusProviderWebsocket | undefined; let provider: HocuspocusProvider | undefined;
  const doc = new Y.Doc();
  try {
    assert.equal((await (await open('abandoned')).json()).roomMode, 'create');
    assert.equal((await (await fetch(api)).json()).opened, false);
    const waiting = await open('second'); assert.equal(waiting.status, 409); assert.equal((await waiting.json()).status, 'initializing');
    await setTimeout(80);
    assert.equal((await (await open('second')).json()).roomMode, 'create');
    const url = new URL(server.webSocketURL); url.searchParams.set('clientId', 'second');
    socket = new HocuspocusProviderWebsocket({ url: url.href, WebSocketPolyfill: WebSocket });
    doc.getMap('meta').set('bootstrapState', 'committed');
    provider = new HocuspocusProvider({ websocketProvider: socket, name: 'sd2/v2.1/startup', document: doc, token: 'writer', broadcast: false });
    await until(async () => (await (await fetch(api)).json()).opened === true);
    assert.equal((await (await open('third')).json()).roomMode, 'join');
    provider.destroy(); socket.destroy();
    assert.equal((await (await open('after-disconnect')).json()).roomMode, 'join');
  } finally { provider?.destroy(); socket?.destroy(); doc.destroy(); await server.destroy(); }
});

test('an interrupted partial room is preserved instead of recreated or advertised as committed', { timeout: 15000 }, async () => {
  const server = createDemoServer(0); await server.listen();
  const api = `${server.httpURL}/api/rooms/partial`;
  const open = (clientId: string) => fetch(`${api}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) });
  const doc = new Y.Doc(); let socket: HocuspocusProviderWebsocket | undefined; let provider: HocuspocusProvider | undefined;
  try {
    assert.equal((await (await open('creator')).json()).roomMode, 'create');
    const url = new URL(server.webSocketURL); url.searchParams.set('clientId', 'creator');
    socket = new HocuspocusProviderWebsocket({ url: url.href, WebSocketPolyfill: WebSocket });
    doc.getMap('meta').set('bootstrapState', 'pending');
    doc.getMap('content').set('partial-seed', 'must survive');
    provider = new HocuspocusProvider({ websocketProvider: socket, name: 'sd2/v2.1/partial', document: doc, token: 'writer', broadcast: false });
    await until(async () => server.documents.get('sd2/v2.1/partial')?.getMap('content').get('partial-seed') === 'must survive');
    provider.destroy(); socket.destroy();
    await until(async () => (server.documents.get('sd2/v2.1/partial')?.getConnectionsCount() ?? 0) === 0);
    await until(async () => (await (await open('new-client')).json()).status === 'interrupted');
    const result = await open('new-client'); assert.equal(result.status, 409); assert.equal((await result.json()).status, 'interrupted');
    assert.equal((await (await fetch(api)).json()).opened, false);
  } finally { provider?.destroy(); socket?.destroy(); doc.destroy(); await server.destroy(); }
});
