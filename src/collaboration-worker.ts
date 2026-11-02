import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { bootstrapSuperDocCollaborationWorker } from 'superdoc/collaboration-worker';

// Standard Hocuspocus frames; this adapter only exposes transport events to the UI.
bootstrapSuperDocCollaborationWorker({
  providerAdapters: {
    observed: ({ providerOptions }) => ({
      providerFamily: 'hocuspocus',
      attach({ ydoc, providerRoomName, onSynced, onDegraded, onFailed }) {
        const { url, channelName, demoUser } = providerOptions as { url: string; channelName: string; demoUser: string };
        const events = new BroadcastChannel(channelName);
        let synced = false;
        let destroyed = false;
        const socket = new HocuspocusProviderWebsocket({ url, connect: false,
          onClose({ event }) {
            if (destroyed) return;
            events.postMessage({ kind: 'close', code: event.code, reason: event.reason });
            if (event.code === 4403 || event.code === 4401) {
              socket.shouldConnect = false;
              onFailed({ reason: 'authentication_failed', code: event.code });
            } else if (synced) onDegraded();
          },
        });
        const provider = new HocuspocusProvider({
          websocketProvider: socket, name: providerRoomName, document: ydoc,
          token: demoUser, broadcast: false,
          onSynced({ state }) { if (state) { synced = true; onSynced(); } },
          onAuthenticationFailed({ reason }) {
            events.postMessage({ kind: 'authentication-failed', reason });
            socket.shouldConnect = false;
            onFailed({ reason: 'authentication_failed' });
          },
        });
        void socket.connect().catch(error => {
          if (destroyed) return;
          events.postMessage({ kind: 'connection-error', reason: String(error) });
          onFailed({ reason: 'connection_failed' });
        });
        return {
          awareness: provider.awareness,
          disconnect: () => socket.disconnect(),
          destroy() { destroyed = true; provider.destroy(); socket.destroy(); events.close(); },
        };
      },
    }),
  },
});
