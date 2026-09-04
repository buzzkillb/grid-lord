import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NOTIFICATIONS (#8) — fire-and-forget async alerts on key trading events so a
 * supervised live wallet doesn't require watching the terminal.
 *
 * Two sinks:
 *   1. TELEGRAM  — via a bot webhook (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
 *      Never blocks: failures are swallowed so a notification outage can NEVER
 *      interrupt the trading loop.
 *   2. EVENT LOG — .botstate/events.log, always on, so even without Telegram
 *      configured the last N events are auditably persisted.
 *
 * No secrets are logged. No synthetic data — events are real trade/risk signals.
 */

const EVENT_LOG = join(process.cwd(), '.botstate', 'events.log');

function config(): { enabled: boolean; token: string; chatId: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  return { enabled: !!(token && chatId), token, chatId };
}

function logEvent(line: string): void {
  try {
    mkdirSync(join(process.cwd(), '.botstate'), { recursive: true });
    appendFileSync(EVENT_LOG, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* never block the trading loop on a log write */
  }
}

async function sendTelegram(text: string): Promise<void> {
  const c = config();
  if (!c.enabled) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${c.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.chatId, text, disable_notification: false }),
      }
    );
  } catch {
    /* fire-and-forget: silence */
  }
}

/**
 * Emit an alert. Async but never awaited by callers (best-effort).
 * Pass quietTelegram=true to log only (avoid alert spam, e.g. routine fills).
 */
export function notify(level: string, text: string, quietTelegram = false): void {
  logEvent(`[${level}] ${text}`);
  if (!quietTelegram) void sendTelegram(`*[${level.toUpperCase()}]* ${text}`);
}
