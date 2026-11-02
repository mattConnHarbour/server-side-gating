import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { openRoom } from './open-room';
const root = document.querySelector('#root')!;
const params = new URLSearchParams(location.search);
const room = params.get('room') ?? 'operation-gate';
const user = params.get('user') === 'observer' ? 'observer' : 'writer';
const clientId = crypto.randomUUID();
if (!/^[\w-]{1,80}$/.test(room)) throw new Error('Invalid room');
try {
  // Load the app and fixture before claiming initialization, so dependency loading
  // and an early Vite reload do not permanently mark an empty room as opened.
  const file = await fetch('/sample.docx');
  if (!file.ok) throw Error('Could not load the sample document');
  const document = await file.blob();
  const roomMode = await openRoom(room, clientId, () => { root.textContent = 'Another client is initializing the shared document. Waiting for its committed room…'; });
  createRoot(root).render(<App room={room} user={user} clientId={clientId} roomMode={roomMode} document={document} />);
} catch (error) {
  root.textContent = String(error);
  const fresh = document.createElement('a');
  fresh.href = `/?room=demo-${crypto.randomUUID()}&user=${user}`;
  fresh.textContent = ' Open a fresh demo room';
  root.append(fresh);
}
