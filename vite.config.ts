import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { createRuntimeMiddleware } from './server/server.ts';

export default defineConfig({
  plugins: [{
    name: 'bifrost-api',
    configureServer(server) {
      const dataDir = resolve(server.config.root, process.env.BIFROST_DATA_DIR || 'data');
      const runtime = createRuntimeMiddleware(dataDir);
      server.middlewares.use(runtime.handle);
      server.httpServer?.once('close', runtime.close);
    },
  }],
});
