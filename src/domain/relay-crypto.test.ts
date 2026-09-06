import { describe, expect, it } from "vitest";
import { importRelayKey, openRelayFrame, sealRelayFrame } from "./relay-crypto";

describe("Solo opaque relay encryption", () => {
  it("SOLO-RELAY-001 authenticates content and routing metadata end to end", async () => {
    const key = await importRelayKey(crypto.getRandomValues(new Uint8Array(32)));
    const plaintext = new TextEncoder().encode("CONTENT_CANARY_must_not_reach_cloud_storage");
    const frame = await sealRelayFrame(
      key,
      {
        workspaceId: "workspace-1",
        hostEpoch: 3,
        sequence: 9,
        requestId: "request_relay_001",
        direction: "to_host",
      },
      plaintext,
    );
    expect(frame.ciphertext).not.toContain("CONTENT_CANARY");
    await expect(openRelayFrame(key, frame)).resolves.toEqual(plaintext);
    await expect(openRelayFrame(key, { ...frame, hostEpoch: 4 })).rejects.toThrow(
      "relay frame authentication failed",
    );
    // Flip a bit in the middle of the ciphertext rather than the last base64
    // character: that character's low bits are discarded on decode, so
    // changing it sometimes produces the very same bytes and no tampering.
    const bytes = Uint8Array.from(
      atob(frame.ciphertext.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    const tampered = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(tampered).not.toBe(frame.ciphertext);
    await expect(openRelayFrame(key, { ...frame, ciphertext: tampered })).rejects.toThrow(
      "relay frame authentication failed",
    );
  });
});
