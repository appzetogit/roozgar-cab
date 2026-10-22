import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './modules/taxi/middlewares/errorMiddleware.js';
import { taxiRouter } from './modules/taxi/routes/index.js';
import { storeInlineImages } from './modules/taxi/middlewares/uploadMiddleware.js';

export const createApp = () => {
  const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true })); 
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uploadsDir = env.uploads.dir
    ? path.resolve(env.uploads.dir)
    : path.join(__dirname, "../uploads");
  app.use("/uploads", express.static(uploadsDir));

  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'Taxi backend is healthy' });
  });

  app.use(['/api', '/api/v1'], storeInlineImages);

  // Keep both mounts during integration so existing clients using /api or /api/v1 continue to work.
  app.use('/api', taxiRouter);
  app.use('/api/v1', taxiRouter);

  app.get(['/api', '/api/v1'], (_req, res) => {
    res.json({
      success: true,
      message: 'Taxi API is mounted',
      routes: {
        admins: ['/api/admin', '/api/v1/admin'],
        users: ['/api/users', '/api/v1/users'],
        drivers: ['/api/drivers', '/api/v1/drivers'],
        rides: ['/api/rides', '/api/v1/rides'],
        deliveries: ['/api/deliveries', '/api/v1/deliveries'],
      },
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
