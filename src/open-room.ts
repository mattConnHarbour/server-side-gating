/** Reserve one initializer, or wait until its committed room can be joined. */
export async function openRoom(room: string, clientId: string, onWaiting: () => void): Promise<'create' | 'join'> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/rooms/${room}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }),
    });
    const result = await response.json();
    if (response.ok && ['create', 'join'].includes(result.roomMode)) return result.roomMode;
    if (response.status !== 409 || result.status !== 'initializing') throw Error(result.error ?? 'Could not open the collaboration room');
    onWaiting();
    await new Promise(resolve => setTimeout(resolve, result.retryAfterMs ?? 250));
  }
  throw Error('The room initializer did not finish. Try a fresh demo room.');
}
