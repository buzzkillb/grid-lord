import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { AppConfig } from './config.js';

/**
 * Loads a keypair for live trading, or generates a throwaway one for paper trading.
 *
 * Security rules:
 * - NEVER store the private key inside the repo or log it.
 * - `walletKeyPath` points to a file OUTSIDE version control (see .gitignore).
 * - For live mode, the file must contain either a base58 secret key (the
 *   standard SOLANA_PRIVATE_KEY format) or a JSON array of 64 bytes.
 */
export function loadKeypair(cfg: AppConfig): Keypair {
  if (cfg.mode === 'paper') {
    // Deterministic-ish throwaway for paper (from a fixed seed is fine for sim).
    // We use a random one each run so paper state is independent of any real key.
    return Keypair.generate();
  }

  const p = path.resolve(cfg.walletKeyPath);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Live mode requires a wallet key file at ${p}. ` +
        `Create it with the secret key (base58 or 64-byte JSON). ` +
        `See README. Do NOT commit this file.`
    );
  }

  const raw = fs.readFileSync(p, 'utf8').trim();
  try {
    // base58 (SOLANA_PRIVATE_KEY style)
    if (!raw.startsWith('[')) {
      const secret = bs58.decode(raw);
      return Keypair.fromSecretKey(secret);
    }
    // JSON array of bytes
    const arr: number[] = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (e) {
    throw new Error(`Failed to parse wallet key file ${p}: ${(e as Error).message}`);
  }
}

/** Returns the base58 public key string for a keypair. */
export function pubkeyString(kp: Keypair): string {
  return new PublicKey(kp.publicKey).toBase58();
}
