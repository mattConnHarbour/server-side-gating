import { useEffect, useMemo, useRef, useState } from 'react';
import { SuperDocEditor, type SuperDocRef, type SuperDocEditorProps } from '@superdoc/react';
import '@superdoc/react/style.css';
import type { Permissions, OperationType } from '../validator/index';
import workerURL from './collaboration-worker.ts?worker&url';

type Decision = { id: number; user: string; type: OperationType; allowed: boolean; reason: string; milliseconds: number; bytes: number; paths: string[]; time: string };
type Room = { opened: boolean; users: Record<string, Permissions>; events: Decision[]; messages: number };
type Props = { room: string; user: 'writer' | 'observer'; clientId: string; roomMode: 'create' | 'join'; document: Blob };
const defaults: Permissions = { comment: true, suggestion: true, edit: true };

export default function App({ room, user, clientId, roomMode, document }: Props) {
  const ref = useRef<SuperDocRef>(null);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [mode, setMode] = useState<'editing' | 'suggesting'>('editing');
  const [server, setServer] = useState<Room>({ opened: false, users: {}, events: [], messages: 0 });
  const [draft, setDraft] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Connecting to the shared document…');
  const [exception, setException] = useState('');
  const [transportError, setTransportError] = useState('');
  const channelName = useRef(`operation-gate-${crypto.randomUUID()}`).current;
  const lastDenied = useRef(0);
  const sequence = useRef(0);
  const connected = ready && server.opened;
  const documents = useMemo<SuperDocEditorProps['documents']>(() => [{
    id: room, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: document,
    v2Collaboration: {
      providerType: 'extension', adapterId: 'observed', documentId: room,
      providerOptions: { url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/collaboration?clientId=${clientId}`, channelName, demoUser: user },
      roomMode: generation ? 'join' : roomMode, token: user,
    },
  }], [room, user, clientId, roomMode, document, generation, channelName]);

  useEffect(() => {
    const channel = new BroadcastChannel(channelName);
    channel.onmessage = ({ data }) => {
      if (data.kind === 'close' && data.code === 4403) {
        setTransportError(`WebSocket close ${data.code}: ${data.reason}`);
        setReady(false);
      }
    };
    return () => channel.close();
  }, [channelName]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/rooms/${room}`);
        if (!response.ok) throw Error('Could not read server state');
        const data = await response.json() as Room;
        if (!active) return;
        setServer(data);
        const denial = [...data.events].reverse().find(e => e.user === user && !e.allowed);
        if (denial && denial.id > lastDenied.current) {
          lastDenied.current = denial.id;
          setNotice(`Rejected ${denial.type}. Server close 4403: POLICY_DENIED:${denial.type}. Restoring the accepted document…`);
          setReady(false);
          setBusy(false);
          setGeneration(value => value + 1);
        }
      } catch (error) { if (active) setNotice(String(error)); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 300);
    return () => { active = false; clearInterval(timer); };
  }, [room, user]);

  async function savePermissions() {
    setBusy(true);
    try {
      const response = await fetch(`/api/rooms/${room}/permissions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, permissions: draft }),
      });
      if (!response.ok) throw Error('Permission update failed');
      setServer(await response.json()); setNotice('Server permissions updated. The editor remains fully interactive.');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function run(type: OperationType) {
    const doc = ref.current?.getInstance()?.activeEditor?.doc;
    if (!doc) return;
    setBusy(true);
    try {
      const number = ++sequence.current;
      if (type === 'comment') {
        const matches = await doc.query.match({ select: { type: 'text', pattern: 'Amazing' }, require: 'first' });
        const match = matches.items[0];
        if (!match || match.matchKind !== 'text') throw Error('The sample anchor was not found');
        const result = await doc.comments.create({ target: match.target, text: `Review comment ${number}` });
        if (!result.success) throw Error(result.failure?.message ?? 'Mutation failed');
      } else {
        const result = await doc.insert({ value: type === 'suggestion' ? ` Suggested ${number}.` : ` Direct ${number}.` }, { changeMode: type === 'suggestion' ? 'tracked' : 'direct' });
        if (!result.success) throw Error(result.failure?.message ?? 'Mutation failed');
      }
      setNotice(`Submitted ${type} locally. Watch the server decision below.`);
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  return <main data-generation={generation} data-ready={connected}>
    <header><div><span className='eyebrow'>SUPERDOC · LOCAL EXPERIMENT</span><h1>Collaboration operation gate</h1><p>Room <strong>{room}</strong> · User <strong>{user}</strong> · SuperDoc 2.25.0</p></div>
      <a href={`/?room=${room}&user=${user === 'writer' ? 'observer' : 'writer'}`} target='_blank' rel='noreferrer'>Open second client ↗</a>
    </header>
    <section className='dashboard'>
      <div className='card policy'><h2>Server permissions</h2><p>Toggle a policy, then POST it to the backend.</p>
        <div className='toggles'>{(['comment', 'suggestion', 'edit'] as const).map(type => <label key={type}><input type='checkbox' checked={draft[type]} onChange={e => setDraft({ ...draft, [type]: e.target.checked })} />Allow {type}s</label>)}</div>
        <button className='primary' disabled={!connected || busy} onClick={() => void savePermissions()}>Apply permissions</button>
        <p className='active-policy'>Active: {Object.entries(server.users[user] ?? defaults).filter(([, allowed]) => allowed).map(([type]) => type).join(', ') || 'none'}</p>
      </div>
      <div className='card'><h2>Try a change</h2><p>Native typing, toolbar actions, and these buttons use the same server gate.</p>
        <div className='actions'>{(['comment', 'suggestion', 'edit'] as const).map(type => <button key={type} disabled={!connected || busy} onClick={() => void run(type)}>{type === 'comment' ? 'Add comment' : type === 'suggestion' ? 'Suggest text' : 'Insert direct text'}</button>)}</div>
        <div className='actions modes'><button aria-pressed={mode === 'editing'} onClick={() => setMode('editing')}>Type direct edits</button><button aria-pressed={mode === 'suggesting'} onClick={() => setMode('suggesting')}>Type suggestions</button></div>
        <p role='status'>{connected ? 'Connected' : 'Connecting'} · {server.messages} frames inspected · {server.events.filter(e => !e.allowed).length} rejected</p>
      </div>
    </section>
    <div className='notice' aria-live='polite'>{notice}</div>
    <section className='workspace'>
      <section className='decisions' aria-label='Server decisions'>
        <div className='decisions-heading'><div><h2>Server decisions</h2><p>Every document update is classified from its contents. No client operation labels.</p></div>
          <details className='exception'><summary>Latest editor exception</summary><pre>{exception || 'No core onException event received.'}</pre></details>
        </div>
        {transportError && <p className='transport-error' role='alert'>{transportError}</p>}
        <ol className='events'>{[...server.events].reverse().map(event => <li className={event.allowed ? 'allowed' : 'denied'} key={event.id}>
          <div><strong>{event.allowed ? 'ALLOWED' : 'REJECTED'} · {event.type}</strong><span>#{event.id} · {event.user}</span></div>
          <p>{event.reason}</p><small>{event.bytes} bytes · {event.milliseconds.toFixed(2)} ms</small>
          {!event.allowed && <code>4403 POLICY_DENIED:{event.type}</code>}
          <details><summary>Changed fields</summary><pre>{event.paths.slice(0, 25).join('\n')}</pre></details>
        </li>)}</ol>
      </section>
      <div className='editor-pane' aria-label='Shared document'>
        <SuperDocEditor key={generation} ref={ref} documents={documents} workerUrls={{ collaboration: workerURL }} documentMode={mode} role='editor'
          user={{ name: user, email: `${user}@example.com` }}
          onReady={() => { setReady(true); if (generation) setNotice('Connected again. Rejected local changes were discarded; accepted server state restored.'); }}
          onCollaborationReady={() => { setReady(true); if (generation) setNotice('Connected again. Rejected local changes were discarded; accepted server state restored.'); }}
          onContentError={({ error }) => setNotice(String(error))}
          onException={payload => { setException('error' in payload ? String(payload.error) : JSON.stringify(payload)); }} />
      </div>
    </section>
    <footer>Local demo controls can change this user's policy. State is kept in memory. Denials reopen the editor from accepted state. Classifier scope and limits are documented in the README.</footer>
  </main>;
}
