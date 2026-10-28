/**
 * 二进制与文本编码工具。
 * 纯实现（不依赖 Buffer / atob），保证浏览器与 Node 行为一致，便于未来迁到 Tauri WebView。
 */

import { errors } from '../errors';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET[index]] = index;
  }
  return table;
})();

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** UTF-8 编码字符串为字节。 */
export function utf8ToBytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** 字节解码为 UTF-8 字符串。 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/** 字节转标准 Base64（带 padding）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index];
    const byte1 = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const byte2 = index + 2 < bytes.length ? bytes[index + 2] : undefined;

    output += BASE64_ALPHABET[byte0 >> 2];
    output += BASE64_ALPHABET[((byte0 & 0b11) << 4) | ((byte1 ?? 0) >> 4)];
    output += byte1 === undefined ? '=' : BASE64_ALPHABET[((byte1 & 0b1111) << 2) | ((byte2 ?? 0) >> 6)];
    output += byte2 === undefined ? '=' : BASE64_ALPHABET[byte2 & 0b111111];
  }
  return output;
}

/** Base64 转字节，严格校验非法字符与长度。 */
export function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  const unpadded = normalized.replace(/=+$/u, '');
  if (unpadded.length % 4 === 1) {
    throw errors.validationFailed('error.invalid_base64');
  }
  const output = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let cursor = 0;
  for (const character of unpadded) {
    const value = BASE64_LOOKUP[character];
    if (value === undefined) {
      throw errors.validationFailed('error.invalid_base64');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[cursor] = (buffer >> bits) & 0xff;
      cursor += 1;
    }
  }
  return cursor === output.length ? output : output.subarray(0, cursor);
}

/** 字节转小写十六进制字符串。 */
export function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

/**
 * 复制为独立的 `ArrayBuffer`。
 * WebCrypto 的 `BufferSource` 不接受 `SharedArrayBuffer` 底层的视图，
 * 这里显式复制，既满足类型要求，也避免把调用方的可变缓冲区直接交给底层实现。
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
