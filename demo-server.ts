import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { classifyUpdate, decodeMessage, isAllowed, snapshotDoc, type Permissions } from './validator/index';

type Decision = { id: number; user: string; type: string; allowed: boolean; reason: string; milliseconds: number; bytes: number; paths: string[]; time: string };
type Room = { opened: boolean; creator?: { clientId: string; expiresAt: number }; users: Record<string, Permissions>; events: Decision[]; messages: number };
const prefix = 'sd2/v2.1/';
const defaults = (): Permissions => ({ comment: true, suggestion: true, edit: true });

export function createDemoServer(port = 1238, { creationLeaseMs = 15_000, address = '127.0.0.1' } = {}) {
  const rooms = new Map<string, Room>();
  const accepted = new Map<string, Uint8Array>();
  const admission = new Map<string, Promise<void>>();
  const activeClients = new Map<string, Set<string>>();
  const roomFor = (name: string) => {
    if (!rooms.has(name)) rooms.set(name, { opened: false, users: {}, events: [], messages: 0 });
    return rooms.get(name)!;
  };
  const permissionsFor = (room: Room, user: string) => room.users[user] ??= defaults();
  const hasStoredState = (name: string) => (accepted.get(name)?.length ?? 0) > 2;
  const remember = (documentName: string, document: Y.Doc) => {
    accepted.set(documentName, Y.encodeStateAsUpdate(document));
    if (document.getMap('meta').get('bootstrapState') === 'committed') {
      const room = roomFor(documentName.slice(prefix.length));
      room.opened = true;
      delete room.creator;
    }
  };
  const server = Server.configure({
    port, address, quiet: true, stopOnSignals: false, debounce: 0, maxDebounce: 0,
    async onAuthenticate({ token, documentName, requestParameters, socketId }) {
      if (!/^(writer|observer)$/.test(token)) throw new Error('Use a demo identity');
      const clientId = requestParameters.get('clientId') ?? '';
      const room = roomFor(documentName.slice(prefix.length));
      if (!room.opened && room.creator && room.creator.clientId !== clientId) throw new Error('Another client is initializing this room');
      const key = `${documentName}:${clientId}`;
      if (!activeClients.has(key)) activeClients.set(key, new Set());
      activeClients.get(key)!.add(socketId);
      if (room.creator?.clientId === clientId) room.creator.expiresAt = Date.now() + creationLeaseMs;
      return { user: token, denied: false, clientId };
    },
    async onRequest({ request, response }) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/api\/rooms\/([\w-]{1,80})(?:\/(open|permissions|state))?$/.exec(url.pathname);
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/healthz' && request.method === 'GET') {
        response.end(JSON.stringify({ status: 'ok' }));
        throw null;
      }
      if (!match) { response.writeHead(404).end('{}'); throw null; }
      const room = roomFor(match[1]);
      try {
        if (request.method === 'GET') {
          if (match[2] === 'state') {
            const doc = server.documents.get(`${prefix}${match[1]}`);
            response.end(JSON.stringify(doc ? snapshotDoc(doc) : null));
          } else response.end(JSON.stringify(room));
        } else if (request.method === 'POST' && match[2] === 'open') {
          let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 2048) throw Error('Too large'); }
          const { clientId } = JSON.parse(body);
          if (typeof clientId !== 'string' || !/^[\w-]{1,80}$/.test(clientId)) throw Error('Expected a clientId');
          const documentName = `${prefix}${match[1]}`;
          if (room.opened) {
            response.end(JSON.stringify({ roomMode: 'join' }));
          } else {
            const ownerActive = room.creator && (activeClients.get(`${documentName}:${room.creator.clientId}`)?.size ?? 0) > 0;
            const sameOwner = room.creator?.clientId === clientId;
            if (hasStoredState(documentName) && !ownerActive) {
              // Preserve interrupted/partial state. Never recreate over it.
              response.writeHead(409).end(JSON.stringify({ status: 'interrupted', error: 'Room initialization was interrupted. The partial room was preserved; start a fresh demo room.' }));
            } else if (room.creator && !sameOwner && (ownerActive || room.creator.expiresAt > Date.now())) {
              response.writeHead(409).end(JSON.stringify({ status: 'initializing', retryAfterMs: 250 }));
            } else {
              room.creator = { clientId, expiresAt: Date.now() + creationLeaseMs };
              response.end(JSON.stringify({ roomMode: 'create' }));
            }
          }
        } else if (request.method === 'POST' && match[2] === 'permissions') {
          let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 2048) throw Error('Too large'); }
          const { user, permissions } = JSON.parse(body);
          if (!['writer', 'observer'].includes(user) || !permissions || ['comment', 'suggestion', 'edit'].some(k => typeof permissions[k] !== 'boolean')) throw Error('Invalid policy');
          room.users[user] = { comment: permissions.comment, suggestion: permissions.suggestion, edit: permissions.edit };
          response.end(JSON.stringify(room));
        } else response.writeHead(405).end('{}');
      } catch (error) { response.writeHead(400).end(JSON.stringify({ error: String(error) })); }
      throw null;
    },
    async beforeHandleMessage({ documentName, document, update, context }) {
      const previous = admission.get(documentName) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      admission.set(documentName, next);
      await previous;
      try {
      if (context.denied) throw { code: 4403, reason: 'POLICY_DENIED:connection' };
      const room = roomFor(documentName.slice(prefix.length)); room.messages++;
      const user = context.user as string;
      const message = decodeMessage(update);
      if (!message) return;
      if (!room.opened && room.creator && room.creator.clientId !== context.clientId) {
        context.denied = true;
        throw { code: 4403, reason: 'ROOM_INITIALIZER_REPLACED' };
      }
      if (room.creator && room.creator.clientId === context.clientId) room.creator.expiresAt = Date.now() + creationLeaseMs;
      let result;
      try { result = classifyUpdate(document, message.update); }
      catch (error) { result = { type: 'edit' as const, changed: true, reason: String(error), paths: [], milliseconds: 0, invalid: true }; }
      if (!result.changed) return;
      const allowed = !('invalid' in result) && isAllowed(result, permissionsFor(room, user));
      const event: Decision = { ...result, id: (room.events.at(-1)?.id ?? 0) + 1, user, allowed, bytes: message.update.length, time: new Date().toISOString() };
      room.events.push(event); if (room.events.length > 100) room.events.shift();
      console.info(`[${allowed ? 'allow' : 'deny'}] ${user} ${result.type} ${event.bytes}B ${result.milliseconds.toFixed(2)}ms ${result.paths.slice(0, 4).join(', ')}`);
      if (process.env.CAPTURE_UPDATES === '1') {
        mkdirSync('evidence', { recursive: true });
        writeFileSync(`evidence/${event.id}-${result.type}.json`, JSON.stringify({ event, before: snapshotDoc(document), update: Array.from(message.update), baseline: Array.from(Y.encodeStateAsUpdate(document)) }, null, 2));
      }
      if (!allowed) { context.denied = true; throw { code: 4403, reason: `POLICY_DENIED:${result.type}` }; }
      } finally {
        // Hocuspocus applies the frame after this hook's promise resolves.
        // Let that microtask finish before inspecting another frame's state.
        setImmediate(() => { release(); if (admission.get(documentName) === next) admission.delete(documentName); });
      }
    },
    async onLoadDocument({ documentName, document }) { const bytes = accepted.get(documentName); if (bytes) Y.applyUpdate(document, bytes); return document; },
    async onChange({ documentName, document }) { remember(documentName, document); },
    async onStoreDocument({ documentName, document }) { remember(documentName, document); },
    async onDisconnect({ documentName, context, socketId }) {
      const key = `${documentName}:${context.clientId ?? ''}`;
      activeClients.get(key)?.delete(socketId);
      if (activeClients.get(key)?.size === 0) activeClients.delete(key);
      const room = roomFor(documentName.slice(prefix.length));
      if (room.creator?.clientId === context.clientId && !activeClients.has(key) && !hasStoredState(documentName)) delete room.creator;
    },
  });
  return server;
}
