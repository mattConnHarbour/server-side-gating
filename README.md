# Server-side gating

A standalone React and Hocuspocus demo with an importable Node validator and per-user comment, suggestion, and edit permissions. It uses published `superdoc@2.25.0`, `@superdoc/react@2.20.0`, Hocuspocus 2.15.3, and Yjs 13.6.31.

## Run

Requires Node.js 22.12+ and pnpm 11.24.0.

```sh
git clone git@github.com:mattConnHarbour/server-side-gating.git
cd server-side-gating
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:5198**. The backend binds loopback port **1238**. Use `COLLABORATION_PORT` to override the backend port. Open the second-client link after the first client finishes creating the room. Room state and permissions are in memory and reset when the backend stops; use `?room=another-room` for a fresh document.

The backend reserves a single initializer and marks a room open only after the Yjs bootstrap state is `committed`. Other clients wait during initialization, then join. An abandoned reservation for an empty room expires; a partial initialization is preserved and offers a link to a fresh room instead of resetting it. Browser reloads join committed rooms. Keep initial `edit` permission enabled until creation finishes. Both clients keep the editor role. Client policy toggles do not suppress editor commands: the server evaluates them independently.

1. Try **Add comment**, **Suggest text**, **Insert direct text**, or type into the editor.
2. Clear **Allow edits**, keep comments/suggestions enabled, then **Apply permissions**. This POSTs to the backend; no page reload is required.
3. Direct typing is rejected; comments and supported inline text suggestions continue to work.
4. Disable each other flag to see its rejection. The decision log shows the classified type, changed fields, update bytes, and inspection duration.
5. On a rejection, the server throws `{ code: 4403, reason: 'POLICY_DENIED:<type>' }` from `beforeHandleMessage`. The client reports the denial and remounts from accepted room state. Rejected local typing is discarded instead of remaining in the document or replaying on reconnect. The UI stays available throughout recovery.

A transport adapter instruments the standard Hocuspocus connection to report actual close events. It sends ordinary Hocuspocus binary frames, not claimed operation labels. Broadcast-channel document synchronization is disabled, so updates must pass through the server. The separate browser channel carries only transport diagnostics.

## Import into a Node backend

```sh
pnpm build:validator
```

```js
import {
  decodeMessage,
  classifyUpdate,
  isAllowed,
} from './validator-dist/index.js';

// Inside beforeHandleMessage; `update` here is the whole Hocuspocus frame.
const message = decodeMessage(update);
if (!message) return; // awareness, handshake, etc.

const inspection = classifyUpdate(document, message.update);
if (inspection.changed && !isAllowed(inspection, currentPermissions)) {
  throw { code: 4403, reason: `POLICY_DENIED:${inspection.type}` };
}
```

`currentPermissions` is `{ comment: boolean, suggestion: boolean, edit: boolean }`, looked up from a trusted connection identity and current backend policy. The demo API is `POST /api/rooms/:room/permissions` with `{ user, permissions }`; `GET /api/rooms/:room` returns policy and recent decisions.

**Admission ordering matters.** The complete integration is in `demo-server.ts`: Hocuspocus applies a frame after its async hook returns. The demo serializes admissions per document and waits until that apply turn finishes before inspecting another frame. Copying the short hook above without equivalent ordering is insufficient under overlapping messages.

`classifyUpdate` returns `{ type, changed, reason, paths, milliseconds }`. Duplicate/no-op state is allowed even when all flags are false. Malformed and unresolved updates throw; the server rejects them. The inspector never applies unapproved updates to the authoritative document.

## Classification and limits

This is a prototype tied to the observed SuperDoc 2.25.0 collaboration schema, **not a production authorization library or a supported SuperDoc public API**.

- `comment`: comment records, comment markers/anchors, and the associated comment-part registration, relationship and allocator changes, while the remaining modeled document content is preserved.
- `suggestion`: validated paired inline insertion wrappers; removing those insertions preserves the original text, formatting, other atoms and document structure.
- `edit`: direct edits, mixed operations, structural changes, malformed/unsupported revision structures, and everything not recognized as the two limited cases above. Tracked deletions, formatting revisions, moves and structural suggestions are currently conservative `edit` fallbacks.

Operation-journal labels are supporting checks, not proof. A forged `insertComment` entry accompanying a body edit is classified as `edit`. A suggestion combined with an untracked edit is also `edit`.

The prototype creates an isolated full-state copy and compares modeled snapshots per update. It prioritizes safe rejection without mutating live state, rather than implementing incremental, indexed validation. The UI reports its actual CPU cost; those values measure full prototype inspection, not just CRDT decoding or target lookup.

Production qualification would additionally require independent validation of journal/evidence payloads and repair/replay effects, schema/version compatibility, derived source metadata, complete revision semantics, authorship/ownership, malicious hidden/pending structures, resource bounds and adversarial concurrency. This prototype does not certify those properties. It rejects updates with unresolved dependencies rather than retaining them for later application. It has a 2 MiB update limit and does not persist rejected bytes.

**Local identity/admin simulation:** the two literal demo identities (`writer`, `observer`) are not real credentials. The loopback API intentionally lets the user change their own flags. A real deployment must authenticate connections, authorize the policy-setting API, and supply real authorization independently of client identity/author fields. This app is not configured for deployment.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm browsers
# With pnpm dev running:
pnpm test:browser
node tests/startup-browser.mjs
```

Node tests cover classifier behavior, forged operation labels, mixed changes, malformed/pending updates, no-op sync, and real Hocuspocus clients with per-user policy changes, reconnect-state rejection, and unchanged accepted state. Startup regressions cover abandoned open requests, a single initializer, waiting peers, preserved partial state, and reloading an already committed room. Browser verification covers all three allow/deny flags, native direct and suggestion typing, two-client propagation, local recovery and continued editing after rejection. Screenshots and measured events are retained under ignored `evidence/`.

The fixture is a synthetic example agreement with synthetic document metadata. No customer documents are used. Set `CAPTURE_UPDATES=1` only for local debugging to retain synthetic before-state/update captures in `evidence/`; those captures can include document content and should not be used with customer material.
