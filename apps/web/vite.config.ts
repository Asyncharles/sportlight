import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = resolve(__dirname, '../..');
const backend = process.env.BACKEND_URL ?? 'http://localhost:4000';

/**
 * Dev-only: serve the generated demo media (media/dist) at /media with HTTP range support, the way
 * the nginx media service does in Docker.
 */
function devMedia(): Plugin {
  const root = join(repoRoot, 'media/dist');
  const types: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.json': 'application/json', '.md': 'text/markdown' };
  return {
    name: 'sportlight-dev-media',
    configureServer(server) {
      server.middlewares.use('/media', (req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
        const file = join(root, path);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        const size = statSync(file).size;
        const type = types[extname(file)] ?? 'application/octet-stream';
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        if (range) {
          const start = range[1] ? Number(range[1]) : size - Number(range[2]);
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          createReadStream(file, { start, end }).pipe(res);
        } else {
          res.setHeader('Content-Length', size);
          createReadStream(file).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  // Packaged builds (Capacitor/Electron/Tauri) use VITE_BASE=./ together with VITE_ROUTER=hash.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), devMedia()],
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  css: {
    preprocessorOptions: { scss: { api: 'modern-compiler' } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
