import { createDemoServer } from './demo-server';
const server = createDemoServer(Number(process.env.COLLABORATION_PORT ?? '1238'));
await server.listen();
console.info(`Operation gate: ${server.httpURL}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.destroy().then(() => process.exit()); });
