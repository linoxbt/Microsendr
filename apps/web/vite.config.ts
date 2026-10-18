import 'dotenv/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'private-workspace-paths',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          let path: string;
          try {
            path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
          } catch {
            res.statusCode = 400;
            res.end('Malformed path');
            return;
          }
          if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.sandbox|\.git)(?:\/|$)/.test(path)) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@microsendr/sdk': fileURLToPath(new URL('../../sdks/typescript/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.KORA_DEV_PORT ?? 5176),
    allowedHosts: process.env.KORA_PREVIEW_HOST ? [process.env.KORA_PREVIEW_HOST] : [],
    fs: {
      strict: true,
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../sdks/typescript/src', import.meta.url)),
        fileURLToPath(new URL('../../node_modules', import.meta.url)),
      ],
      deny: ['.env', '.env.*', '**/.sandbox/**', '**/.git/**', '**/*.{crt,pem}'],
    },
    strictPort: true,
    proxy: Object.fromEntries(
      ['/v1', '/console', '/personal/api', '/business/api', '/openapi.json', '/reference'].map((path) => [
        path,
        'http://127.0.0.1:4310',
      ]),
    ),
  },
  build: { outDir: 'dist' },
});
