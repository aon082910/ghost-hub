import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getEnv } from "./env";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/** Derive a purpose-specific 32-byte key from ENCRYPTION_KEY so keys are never reused across uses. */
export function deriveKey(purpose: string): Buffer {
  const master = Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `ghost-hub:${purpose}`, 32));
}

/** AES-256-GCM. Output is base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, deriveKey("tokens"), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  const decipher = createDecipheriv(ALGO, deriveKey("tokens"), buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}
