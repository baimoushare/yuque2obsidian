import { webcrypto } from 'crypto';

const subtle = webcrypto.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MELD_PREFIX_HIDDEN = '%%🔐β ';
const MELD_PREFIX_VISIBLE = '🔐β ';
const MELD_SUFFIX_HIDDEN = ' 🔐%%';
const MELD_SUFFIX_VISIBLE = ' 🔐';
const MELD_HINT_MARKER = '💡';
const MELD_DEFAULT_ITERATIONS = 210000;
const MELD_DEFAULT_IV_LENGTH = 16;
const MELD_DEFAULT_SALT_LENGTH = 16;

export function normalizeReencryptMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'global') {
    return 'global';
  }
  if (normalized === 'matched-block') {
    return 'matched-block';
  }
  return 'off';
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(String(value || ''), 'base64'));
}

function concatBytes(...chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function deriveKey(password, salt, iterations = MELD_DEFAULT_ITERATIONS) {
  const imported = await subtle.importKey('raw', textEncoder.encode(String(password ?? '')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return await subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-512',
      salt,
      iterations,
    },
    imported,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptMeldBlock(text, password, options = {}) {
  const plaintext = String(text ?? '');
  const normalizedPassword = String(password ?? '');
  if (!normalizedPassword) {
    throw new Error('A password is required to encrypt a Meld block.');
  }

  const iv = webcrypto.getRandomValues(new Uint8Array(options.ivLength || MELD_DEFAULT_IV_LENGTH));
  const salt = webcrypto.getRandomValues(new Uint8Array(options.saltLength || MELD_DEFAULT_SALT_LENGTH));
  const key = await deriveKey(normalizedPassword, salt, options.iterations || MELD_DEFAULT_ITERATIONS);
  const encrypted = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      key,
      textEncoder.encode(plaintext),
    ),
  );

  const payload = bytesToBase64(concatBytes(iv, salt, encrypted));
  const showInReadingView = options.showInReadingView !== false;
  const hint = String(options.hint ?? '');
  const prefix = showInReadingView ? MELD_PREFIX_VISIBLE : MELD_PREFIX_HIDDEN;
  const suffix = showInReadingView ? MELD_SUFFIX_VISIBLE : MELD_SUFFIX_HIDDEN;
  return hint ? `${prefix}${MELD_HINT_MARKER}${hint}${MELD_HINT_MARKER}${payload}${suffix}` : `${prefix}${payload}${suffix}`;
}

export function parseMeldBlock(encryptedText) {
  const source = String(encryptedText ?? '');
  const prefix = source.startsWith(MELD_PREFIX_VISIBLE)
    ? MELD_PREFIX_VISIBLE
    : source.startsWith(MELD_PREFIX_HIDDEN)
      ? MELD_PREFIX_HIDDEN
      : '';
  const suffix = source.endsWith(MELD_SUFFIX_VISIBLE)
    ? MELD_SUFFIX_VISIBLE
    : source.endsWith(MELD_SUFFIX_HIDDEN)
      ? MELD_SUFFIX_HIDDEN
      : '';

  if (!prefix || !suffix || source.length <= prefix.length + suffix.length) {
    return null;
  }

  const body = source.slice(prefix.length, source.length - suffix.length);
  let hint = '';
  let payload = body;
  if (body.startsWith(MELD_HINT_MARKER)) {
    const nextMarker = body.indexOf(MELD_HINT_MARKER, MELD_HINT_MARKER.length);
    if (nextMarker <= 0) {
      return null;
    }
    hint = body.slice(MELD_HINT_MARKER.length, nextMarker);
    payload = body.slice(nextMarker + MELD_HINT_MARKER.length);
  }

  return {
    payload,
    hint,
    showInReadingView: prefix === MELD_PREFIX_VISIBLE,
  };
}

export async function decryptMeldBlock(encryptedText, password, options = {}) {
  const parsed = parseMeldBlock(encryptedText);
  if (!parsed) {
    throw new Error('The supplied text is not a supported Meld block.');
  }

  const normalizedPassword = String(password ?? '');
  if (!normalizedPassword) {
    throw new Error('A password is required to decrypt a Meld block.');
  }

  const bytes = base64ToBytes(parsed.payload);
  const ivLength = options.ivLength || MELD_DEFAULT_IV_LENGTH;
  const saltLength = options.saltLength || MELD_DEFAULT_SALT_LENGTH;
  const iv = bytes.slice(0, ivLength);
  const salt = bytes.slice(ivLength, ivLength + saltLength);
  const cipherBytes = bytes.slice(ivLength + saltLength);
  const key = await deriveKey(normalizedPassword, salt, options.iterations || MELD_DEFAULT_ITERATIONS);
  const decrypted = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    cipherBytes,
  );

  return {
    text: textDecoder.decode(decrypted),
    hint: parsed.hint,
    showInReadingView: parsed.showInReadingView,
  };
}
