import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { injectOgTagsIntoHtml } from './api/page';

function localApiPlugin(): Plugin {
  let lastHeaders: {
    host?: string | null;
    forwardedHost?: string | null;
    forwardedProto?: string | null;
  } = { host: 'localhost:5173' };

  return {
    name: 'subpoena-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const h = req.headers.host;
        const fwdH = req.headers['x-forwarded-host'];
        const fwdP = req.headers['x-forwarded-proto'];
        lastHeaders = {
          host: typeof h === 'string' ? h : 'localhost:5173',
          forwardedHost: Array.isArray(fwdH) ? fwdH[0] : fwdH ?? null,
          forwardedProto: Array.isArray(fwdP) ? fwdP[0] : fwdP ?? null,
        };

        const rawUrl = req.url ?? '';
        if (
          !rawUrl.startsWith('/api/gh') &&
          !rawUrl.startsWith('/api/detail') &&
          !rawUrl.startsWith('/api/card') &&
          !rawUrl.startsWith('/api/health') &&
          !rawUrl.startsWith('/api/page')
        ) {
          return next();
        }

        try {
          const proto = lastHeaders.forwardedProto === 'https' ? 'https' : 'http';
          const reqHost = lastHeaders.forwardedHost ?? lastHeaders.host ?? 'localhost';
          const fullUrl = new URL(rawUrl, `${proto}://${reqHost}`);
          const webReq = new Request(fullUrl.toString(), {
            method: req.method ?? 'GET',
            headers: {
              ...(lastHeaders.host ? { host: lastHeaders.host } : {}),
              ...(lastHeaders.forwardedHost
                ? { 'x-forwarded-host': lastHeaders.forwardedHost }
                : {}),
              ...(lastHeaders.forwardedProto
                ? { 'x-forwarded-proto': lastHeaders.forwardedProto }
                : {}),
            },
          });

          let webRes: Response;
          if (rawUrl.startsWith('/api/gh')) {
            const mod = await server.ssrLoadModule('/api/gh.ts');
            webRes = await mod.handleRequest(webReq);
          } else if (rawUrl.startsWith('/api/detail')) {
            const mod = await server.ssrLoadModule('/api/detail.ts');
            webRes = await mod.handleDetailRequest(webReq);
          } else if (rawUrl.startsWith('/api/card')) {
            const mod = await server.ssrLoadModule('/api/card.ts');
            webRes = await mod.handleCardRequest(webReq);
          } else if (rawUrl.startsWith('/api/page')) {
            const mod = await server.ssrLoadModule('/api/page.ts');
            webRes = mod.handlePageRequest(webReq);
          } else {
            const mod = await server.ssrLoadModule('/api/health.ts');
            webRes = await mod.handleHealthRequest();
          }

          res.statusCode = webRes.status;
          webRes.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          const buf = Buffer.from(await webRes.arrayBuffer());
          res.end(buf);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Internal API error',
            }),
          );
        }
      });
    },
    transformIndexHtml(html, ctx) {
      if (!ctx.server) return html;
      const reqUrl = ctx.originalUrl ?? ctx.path;
      return injectOgTagsIntoHtml(html, reqUrl, lastHeaders);
    },
  };
}

export default defineConfig({
  plugins: [localApiPlugin()],
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
