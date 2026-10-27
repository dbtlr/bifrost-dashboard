import { statSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import serveStatic from 'serve-static';
import { createApiHandler } from './api.ts';
import { openStore } from './store.ts';

interface FileRoots {
  buildDir: string;
  dataDir: string;
}

interface ServerConfig extends FileRoots {
  host: string;
  port: number;
}

export function readConfig(env: NodeJS.ProcessEnv, appRoot: string): ServerConfig {
  const rawPort = env.BIFROST_PORT ?? '4310';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('BIFROST_PORT must be an integer port between 1 and 65535.');
  }
  return {
    host: env.BIFROST_HOST || '127.0.0.1',
    port,
    buildDir: resolve(appRoot, env.BIFROST_BUILD_DIR || 'dist'),
    dataDir: resolve(appRoot, env.BIFROST_DATA_DIR || 'data'),
  };
}

const fileOptions = { fallthrough: false, cacheControl: false, dotfiles: 'deny' as const };

function fileError(response: ServerResponse, error?: { status?: number }): void {
  const status = error?.status ?? 404;
  if (status >= 500) console.error('Dashboard file request failed:', error);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(STATUS_CODES[status] ?? 'Request failed');
}

// Production and Vite share routing, path checks, and one database per server.
export function createRuntimeMiddleware(dataDir: string) {
  const store = openStore(dataDir);
  const api = createApiHandler({ store, dataDir });
  const serveData = serveStatic(dataDir, { ...fileOptions, index: false, redirect: false });
  let closed = false;
  function close(): void {
    if (!closed) {
      closed = true;
      store.close();
    }
  }
  function handle(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let path: string;
    try {
      path = decodeURIComponent((request.url ?? '/').split('?')[0]!);
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Invalid path');
      }
    } catch {
      if (request.url?.startsWith('/api/')) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Invalid request path.' }));
      } else {
        response.writeHead(400).end('Bad Request');
      }
      return;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      void api(request, response);
    } else if (path === '/icons' || path.startsWith('/icons/')) {
      serveData(request, response, (error?: { status?: number }) => fileError(response, error));
    } else {
      next();
    }
  }
  return { handle, close };
}

export function createDashboardServer({ buildDir, dataDir }: FileRoots) {
  if (!statSync(join(buildDir, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Dashboard build is missing. Run npm run build or set BIFROST_BUILD_DIR.');
  }
  const runtime = createRuntimeMiddleware(dataDir);
  const serveBuild = serveStatic(buildDir, fileOptions);
  const server = createServer((request, response) => {
    runtime.handle(request, response, () => {
      serveBuild(request, response, (error?: { status?: number }) => fileError(response, error));
    });
  });
  server.once('close', runtime.close);
  server.once('error', () => { if (!server.listening) runtime.close(); });
  return server;
}
