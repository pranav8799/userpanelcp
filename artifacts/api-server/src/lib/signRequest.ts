import crypto from "crypto";

const BASE_URL = process.env.COINSWITCH_BASE_URL || "https://coinswitch.co";

// PKCS#8 DER header for a raw 32-byte Ed25519 private key
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function createEd25519PrivateKey(rawHexKey: string): crypto.KeyObject {
  const rawBytes = Buffer.from(rawHexKey, "hex");
  if (rawBytes.length !== 32) {
    throw new Error(
      `Ed25519 secret key must be 32 bytes (64 hex chars), got ${rawBytes.length}`,
    );
  }
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, rawBytes]);
  return crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

export function signRequest(
  method: string,
  endpoint: string,
  params: object = {},
  apiKey: string,
  secretKey: string,
): { headers: Record<string, string>; path: string; fullUrl: string } {
  const epoch = Date.now().toString();

  const queryString =
    method === "GET" && Object.keys(params).length > 0
      ? "?" + new URLSearchParams(params as Record<string, string>).toString()
      : "";
  const path = endpoint + queryString;

  // Signed message = METHOD + path_with_query (URL-decoded) + epoch
  const pathForSigning = decodeURIComponent(path);
  const signaturePayload = method + pathForSigning + epoch;

  const privateKey = createEd25519PrivateKey(secretKey);
  const signatureBytes = crypto.sign(null, Buffer.from(signaturePayload, "utf8"), privateKey);
  const signature = signatureBytes.toString("hex");

  return {
    headers: {
      "Content-Type": "application/json",
      "X-AUTH-SIGNATURE": signature,
      "X-AUTH-APIKEY": apiKey,
      "X-AUTH-EPOCH": epoch,
    },
    path,
    fullUrl: BASE_URL + path,
  };
}

export { BASE_URL };
