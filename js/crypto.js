// The vault: WebCrypto only, no dependencies, no network.
//
// A random 256-bit master key encrypts every record. That master key is itself
// stored twice, wrapped once by your passphrase and once by a recovery key.
// Changing the passphrase therefore rewraps one small blob instead of
// re-encrypting the whole file, and losing the passphrase is survivable.
//
// PBKDF2-SHA256 at 600k iterations does the stretching. Argon2id would resist
// GPU cracking better, but every implementation is a WASM blob from a CDN, and
// this app's most valuable security property is that it makes zero outbound
// requests. A long passphrase closes that gap far more than the KDF choice does.

const ITERATIONS = 600000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const te = new TextEncoder();
const td = new TextDecoder();

export const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const fromB64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

/* ---------- recovery key encoding (Crockford base32, no ambiguous letters) ---------- */

export function encodeRecoveryKey(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function decodeRecoveryKey(text) {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error('That recovery key contains characters it should not.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ---------- primitives ---------- */

async function deriveKek(secretBytes, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function decryptBytes(key, blob) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return new Uint8Array(plain);
}

const importMaster = raw => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

export const encryptJson = (key, obj) => encryptBytes(key, te.encode(JSON.stringify(obj)));
export const decryptJson = async (key, blob) => JSON.parse(td.decode(await decryptBytes(key, blob)));

/* ---------- vault lifecycle ---------- */

export async function createVault(passphrase) {
  const master = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', master));

  const recoveryBytes = randomBytes(20);
  const saltP = randomBytes(16);
  const saltR = randomBytes(16);

  const vault = {
    id: 'vault',
    version: 1,
    iterations: ITERATIONS,
    saltP: toB64(saltP),
    wrappedP: await encryptBytes(await deriveKek(te.encode(passphrase), saltP), raw),
    saltR: toB64(saltR),
    wrappedR: await encryptBytes(await deriveKek(recoveryBytes, saltR), raw),
    createdAt: new Date().toISOString(),
  };

  return { vault, key: master, recoveryKey: encodeRecoveryKey(recoveryBytes) };
}

export async function unlockWithPassphrase(vault, passphrase) {
  const kek = await deriveKek(te.encode(passphrase), fromB64(vault.saltP), vault.iterations);
  return importMaster(await decryptBytes(kek, vault.wrappedP));
}

export async function unlockWithRecoveryKey(vault, recoveryKey) {
  const kek = await deriveKek(decodeRecoveryKey(recoveryKey), fromB64(vault.saltR), vault.iterations);
  return importMaster(await decryptBytes(kek, vault.wrappedR));
}

// Rewraps the existing master key under a new passphrase. Records are untouched,
// so this is instant no matter how much you have filed.
export async function rewrapPassphrase(vault, masterKey, passphrase) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', masterKey));
  const saltP = randomBytes(16);
  return {
    ...vault,
    saltP: toB64(saltP),
    wrappedP: await encryptBytes(await deriveKek(te.encode(passphrase), saltP), raw),
  };
}
