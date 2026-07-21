import crypto from "crypto";

const IV_LENGTH = 16;

export function decrypt(text: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set");

  const [ivHex, encryptedHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(encKey, "hex"),
    iv,
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString();
}
