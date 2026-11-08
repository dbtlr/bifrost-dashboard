import { fileURLToPath } from 'node:url';
import { createDashboardServer, readConfig } from './server.ts';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = readConfig(process.env, root);
  const server = createDashboardServer(config);
  server.on('error', error => {
    console.error(`Unable to start dashboard on ${config.host}:${config.port}:`, error.message);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Bifrost dashboard listening on ${config.host}:${config.port}`);
  });

  // Let in-flight responses finish before systemd stops the process.
  function shutdown(): void {
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
