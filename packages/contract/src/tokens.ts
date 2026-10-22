import { sha256Hex } from './canonical.ts';

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function tokenHash(token: string): Promise<string> {
  return sha256Hex(`socrate-token:${token}`);
}
