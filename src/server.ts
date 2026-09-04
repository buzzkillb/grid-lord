import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export interface DashboardServerOptions {
  cfg: AppConfig;
  store: StateStore;
  port: number;
}

/**
 * Local dashboard: serves the static UI and streams live snapshots over
 * WebSocket. Also exposes a small REST surface for start/pause and state.
 */
export class DashboardServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;

  constructor(private opts: DashboardServerOptions) {
    this.app.use(express.json());

    // REST: full snapshot
    this.app.get('/api/state', (_req, res) => {
      res.json(this.opts.store.snapshot(this.opts.cfg));
    });

    // REST: pause/resume
    this.app.post('/api/pause', (_req, res) => {
      this.opts.store.paused = true;
      res.json({ paused: true });
    });
    this.app.post('/api/resume', (_req, res) => {
      this.opts.store.paused = false;
      res.json({ paused: false });
    });

    // Static UI
    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      this.app.use(express.static(PUBLIC_DIR));
      this.app.get('/', (_req, res) => res.sendFile(indexHtml));
    }

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      // Push a snapshot immediately on connect
      ws.send(JSON.stringify(this.opts.store.snapshot(this.opts.cfg)));
      const handler = (s: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(s));
        }
      };
      this.opts.store.on('snapshot', handler);
      ws.on('close', () => this.opts.store.removeListener('snapshot', handler));
      ws.on('error', () => {});
    });
  }

  start(cb?: () => void): void {
    // SECURITY (audit M1): bind to loopback only. The dashboard exposes
    // pause/resume controls and full account state with no auth; binding to
    // all interfaces let any LAN host stop a live bot mid-drawdown. Set
    // DASHBOARD_HOST=0.0.0.0 explicitly (plus a reverse proxy + auth) if you
    // genuinely need remote access.
    const host = process.env.DASHBOARD_HOST || '127.0.0.1';
    this.server.listen(this.opts.port, host, cb);
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}
