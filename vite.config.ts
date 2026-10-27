import { defineConfig, normalizePath } from 'vite';
import { createRuntimeMiddleware, resolveDataDir } from './server/server.ts';

export default defineConfig({
  server: {
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
        '**/data/**', '**/sample/**',
        `${normalizePath(resolveDataDir(process.env))}/**`,
      ],
    },
  },
  plugins: [{
    name: 'bifrost-api',
    configureServer(server) {
      const dataDir = resolveDataDir(process.env);
      const runtime = createRuntimeMiddleware(dataDir);
      server.middlewares.use(runtime.handle);
      server.httpServer?.once('close', runtime.close);
    },
  }],
});
