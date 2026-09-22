import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { env, repoRoot } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestId } from './middleware/requestId.js';
import { authRouter } from './modules/auth.routes.js';
import { activityRouter, dictionaryRouter, wardrobeRouter } from './modules/wardrobe.routes.js';
import { garmentRouter } from './modules/garment.routes.js';
import { photoRouter } from './modules/photo.routes.js';
import { damageRouter } from './modules/damage.routes.js';
import { repairRouter } from './modules/repair.routes.js';
import { wearRouter } from './modules/wear.routes.js';
import { syncRouter } from './modules/sync.routes.js';
import { fabricRouter } from './modules/fabric.routes.js';
import { eventsRouter, reminderRouter, reminderRuleRouter } from './modules/reminder.routes.js';
import { analyticsRouter } from './modules/analytics.routes.js';
import { exportRouter, printRouter } from './modules/export.routes.js';
import { sharePublicRouter, shareRouter } from './modules/share.routes.js';
import { prisma } from './lib/prisma.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    cors({
      // 生产环境若显式配置了 WEB_ORIGIN 就只放行它；否则按请求来源放行
      // （前端同源部署时本来也不需要跨域，鉴权走 Bearer token 而非 Cookie）
      origin: env.isProd && env.webOrigin ? [env.webOrigin] : true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { ctx?: { requestId?: string } }).ctx?.requestId ?? '',
      // 只记方法/路径/状态/耗时：默认会把整个请求头（含 Authorization）写进日志，既吵也不安全
      serializers: {
        req: (req: { id?: string; method?: string; url?: string; query?: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: (err: Error) => ({ type: err.name, message: err.message, stack: err.stack?.split('\n').slice(0, 3) }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/healthz' || req.url === '/api/events' },
    }),
  );

  app.get('/api/healthz', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        data: {
          status: 'healthy',
          database: 'up',
          uploadDir: env.uploadDir,
          cron: env.cronEnabled,
          time: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: { code: 'DB_DOWN', message: String(error) } });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/wardrobe', wardrobeRouter);
  app.use('/api/dictionary', dictionaryRouter);
  app.use('/api/activity-logs', activityRouter);
  app.use('/api/garments', garmentRouter);
  app.use('/api/damage-events', damageRouter);
  app.use('/api/repairs', repairRouter);
  app.use('/api/wear-logs', wearRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/fabric-sources', fabricRouter);
  app.use('/api/reminders', reminderRouter);
  app.use('/api/reminder-rules', reminderRuleRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/print', printRouter);
  app.use('/api/share-links', shareRouter);
  app.use('/api/share', sharePublicRouter);
  app.use('/api/events', eventsRouter);
  // 照片与标记：路径自带 /photos 与 /annotations 前缀
  app.use('/api', photoRouter);

  // 生产模式下由 Express 托管前端构建产物
  const webDist = resolve(repoRoot, 'apps/web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/u, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
