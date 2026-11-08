import { statSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import { join, resolve } from 'node:path';
import serveStatic from 'serve-static';

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
    dataDir: resolve(appRoot, env.BIFROST_DATA_DIR || 'public'),
  };
}

export function createDashboardServer({ buildDir, dataDir }: FileRoots) {
  if (!statSync(join(buildDir, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Dashboard build is missing. Run npm run build or set BIFROST_BUILD_DIR.');
  }
  const options = { fallthrough: false, cacheControl: false, dotfiles: 'deny' as const };
  const serveBuild = serveStatic(buildDir, options);
  const serveData = serveStatic(dataDir, { ...options, index: false, redirect: false });

  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    let path: string;
    try {
      path = decodeURIComponent((request.url ?? '/').split('?')[0]!);
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Invalid path');
      }
    } catch {
      response.writeHead(400).end('Bad Request');
      return;
    }

    // Live routes never fall back to bundled sample data if automation removes a file.
    const isData = path === '/apps.json' || path === '/icons' || path.startsWith('/icons/');
    const serve = isData ? serveData : serveBuild;
    serve(request, response, (error?: { status?: number }) => {
      const status = error?.status ?? 404;
      if (status >= 500) console.error('Dashboard file request failed:', error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(STATUS_CODES[status] ?? 'Request failed');
    });
  });
}
