// Repro-only Vite config: extends the web UI dev config with a `/health`
// middleware so the Electron app's `waitForHealth()` probe (which uses a
// plain fetch without an HTML Accept header, so Vite's SPA fallback returns
// 404 for /health) succeeds and the app boots the real UI from Vite.
import { defineConfig } from 'vite';
import baseConfig from '../packages/web/vite.config.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slowMs = Number(process.env.REPRO_SLOW_UI_MS || '0');

const reproHealthPlugin = () => ({
  name: 'repro-health-ok',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"status":"ok"}');
        return;
      }
      next();
    });
    if (slowMs > 0) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' && !req.headers.referer) {
          // Delay the initial HTML response to reproduce a slow real-UI load:
          // the splash is dropped when navigation commits and the compositor
          // shows the window backgroundColor (#151313, near-black) until the
          // UI's first paint.
          setTimeout(next, slowMs);
          return;
        }
        next();
      });
    }
  },
});

export default defineConfig({
  ...baseConfig,
  root: path.resolve(__dirname, '../packages/web'),
  plugins: [...(baseConfig.plugins || []), reproHealthPlugin()],
});
