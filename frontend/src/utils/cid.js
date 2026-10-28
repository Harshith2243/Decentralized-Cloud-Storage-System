// Syntactic CID check (mirrors backend/utils/cid.js). Lets the UI reject
// obviously invalid input before any network call. The backend re-validates.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function decodeBase58(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function decodeBase32(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function isValidCID(cid) {
  if (typeof cid !== "string" || cid.length < 46 || cid.length > 128) return false;
  if (cid.startsWith("Qm")) {
    if (cid.length !== 46) return false;
    const bytes = decodeBase58(cid);
    return Boolean(bytes) && bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20;
  }
  if (cid.startsWith("b")) {
    const bytes = decodeBase32(cid.slice(1));
    if (!bytes || bytes.length < 4 || bytes[0] !== 1 || bytes[1] >= 0x80 || bytes[2] >= 0x80) return false;
    const digestLength = bytes[3];
    return digestLength >= 20 && digestLength <= 64 && bytes.length === 4 + digestLength;
  }
  return false;
}
