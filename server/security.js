import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { generate } from 'selfsigned';

import { DATA_DIR } from './store.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function checkPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const a = crypto.scryptSync(password, stored.salt, 64);
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const newId = () => crypto.randomBytes(6).toString('base64url');

/**
 * Self-signed certificate so phones get HTTPS (browsers only allow GPS on HTTPS).
 * Regenerated when the machine's network addresses change.
 */
export async function loadOrCreateCert(ips) {
  const file = path.join(DATA_DIR, 'tls.json');
  const want = [...ips].sort().join(',');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.ips === want && saved.expires > Date.now() + 7 * 864e5) return saved;
  } catch {
    // none yet
  }
  const notAfterDate = new Date(Date.now() + 365 * 864e5);
  const pems = await generate([{ name: 'commonName', value: 'Mochii (local)' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  const saved = { key: pems.private, cert: pems.cert, ips: want, expires: notAfterDate.getTime() };
  fs.writeFileSync(file, JSON.stringify(saved));
  return saved;
}
