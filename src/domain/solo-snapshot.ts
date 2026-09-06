const encoder = new TextEncoder();

export type SoloSnapshotChannel = {
  id: string;
  kind: "public" | "private" | "dm" | "group_dm";
  slug: string | null;
  name: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SoloSnapshotMessage = {
  id: string;
  channelId: string;
  authorId: string;
  bodyMarkdown: string;
  createdAt: number;
};

export type SoloSnapshotAttachment = {
  id: string;
  messageId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  relativePath: string;
  sha256: string;
};

export type SoloSnapshotPayload = {
  version: 1;
  workspaceId: string;
  hostEpoch: number;
  channels: SoloSnapshotChannel[];
  messages: SoloSnapshotMessage[];
  attachments: SoloSnapshotAttachment[];
};

export type SoloContentSnapshot = SoloSnapshotPayload & { checksum: string };

export async function checksumSoloSnapshot(payload: SoloSnapshotPayload): Promise<string> {
  const canonical: SoloSnapshotPayload = {
    version: 1,
    workspaceId: payload.workspaceId,
    hostEpoch: payload.hostEpoch,
    channels: [...payload.channels].sort(byId),
    messages: [...payload.messages].sort(byId),
    attachments: [...payload.attachments].sort(byId),
  };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifySoloSnapshot(snapshot: SoloContentSnapshot): Promise<void> {
  if (snapshot.version !== 1 || snapshot.hostEpoch < 1 || !Number.isSafeInteger(snapshot.hostEpoch)) {
    throw new Error("invalid solo snapshot");
  }
  const { checksum: _checksum, ...payload } = snapshot;
  if ((await checksumSoloSnapshot(payload)) !== snapshot.checksum) throw new Error("snapshot checksum mismatch");
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
