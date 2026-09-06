const encoder = new TextEncoder();

export type OpaqueRelayFrame = {
  version: 1;
  workspaceId: string;
  hostEpoch: number;
  sequence: number;
  requestId: string;
  direction: "to_host" | "from_host";
  iv: string;
  ciphertext: string;
};

export async function importRelayKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== 32) throw new Error("relay key must be 32 bytes");
  return crypto.subtle.importKey("raw", owned(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealRelayFrame(
  key: CryptoKey,
  metadata: Omit<OpaqueRelayFrame, "version" | "iv" | "ciphertext">,
  plaintext: Uint8Array,
): Promise<OpaqueRelayFrame> {
  validateMetadata(metadata);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad(metadata)), tagLength: 128 },
    key,
    owned(plaintext),
  );
  return { version: 1, ...metadata, iv: base64Url(iv), ciphertext: base64Url(new Uint8Array(ciphertext)) };
}

export async function openRelayFrame(key: CryptoKey, frame: OpaqueRelayFrame): Promise<Uint8Array> {
  if (frame.version !== 1) throw new Error("unsupported relay frame version");
  validateMetadata(frame);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: owned(fromBase64Url(frame.iv)),
        additionalData: encoder.encode(aad(frame)),
        tagLength: 128,
      },
      key,
      owned(fromBase64Url(frame.ciphertext)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("relay frame authentication failed");
  }
}

function aad(metadata: Omit<OpaqueRelayFrame, "version" | "iv" | "ciphertext">): string {
  return [
    "lepidy-solo-relay-v1",
    metadata.workspaceId,
    String(metadata.hostEpoch),
    String(metadata.sequence),
    metadata.requestId,
    metadata.direction,
  ].join("\n");
}

function validateMetadata(metadata: Omit<OpaqueRelayFrame, "version" | "iv" | "ciphertext">): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata.workspaceId)) throw new Error("invalid workspace id");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(metadata.requestId)) throw new Error("invalid request id");
  if (!Number.isSafeInteger(metadata.hostEpoch) || metadata.hostEpoch < 1) throw new Error("invalid host epoch");
  if (!Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1) throw new Error("invalid relay sequence");
  if (metadata.direction !== "to_host" && metadata.direction !== "from_host") {
    throw new Error("invalid relay direction");
  }
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
