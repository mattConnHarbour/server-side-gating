import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const target = `http://127.0.0.1:${process.env.COLLABORATION_PORT ?? '1238'}`;
const proxy = { '/api': { target }, '/collaboration': { target, ws: true } };
export default defineConfig({ plugins: [react()], worker: { format: 'es' }, resolve: { dedupe: ['yjs'] }, server: { proxy }, preview: { proxy } });
