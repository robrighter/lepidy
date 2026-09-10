import { File, FileArchive, FileImage, FileText } from "lucide-react";

import type { StoredFile } from "@/src/cloudflare/workspace";
import { storageStatus, workspaceFileIndex } from "@/src/shell/files-context";
import { workspacePeople } from "@/src/shell/people-context";
import { shellState } from "@/src/shell/shell-context";
import { channelLabel } from "@/src/shell/shell-model";

type Params = { q?: string; type?: string; uploader?: string; room?: string; after?: string; before?: string };

export default async function FilesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    query: params.q ?? null,
    mediaTypePrefix: allowedType(params.type),
    uploaderMemberId: params.uploader || null,
    channelId: params.room || null,
    createdAtOrAfter: dateBoundary(params.after, false),
    createdBefore: dateBoundary(params.before, true),
  };
  const [index, shell, people, storage] = await Promise.all([
    workspaceFileIndex(filters), shellState(), workspacePeople(), storageStatus(),
  ]);

  if (index.status !== "ready") return (
    <section className="empty-state">
      <h2>Files are unavailable</h2>
      <p>{index.status === "unavailable" ? index.reason : "Sign in to see this workspace."}</p>
    </section>
  );

  const channels = shell.status === "ready" ? shell.snapshot.channels : [];
  const uploaders = people.status === "ready" ? people.directory.people : [];

  return (
    <>
      <section className="panel file-index-heading">
        <div>
          <h2>Files</h2>
          <p>Everything shared in a room you can still see, indexed by metadata.</p>
        </div>
        <span className="file-count">{index.files.length}<small>shown</small></span>
      </section>

      {storage && storage.quotaBytes > 0 ? (
        <section className="storage-shelf" aria-label="Attachment storage">
          <div className="storage-shelf-copy">
            <strong>{formatBytes(storage.usedBytes)} used</strong>
            <span>{formatBytes(storage.quotaBytes)} total</span>
          </div>
          <meter min={0} max={storage.quotaBytes} value={Math.min(storage.usedBytes, storage.quotaBytes)}>
            {Math.round((storage.usedBytes / storage.quotaBytes) * 100)}%
          </meter>
          {storage.warn ? <p role="status">Storage is more than 80% full. New uploads stop when it is full; existing files stay here.</p> : null}
        </section>
      ) : null}

      <section className="panel file-filter-panel" aria-label="File filters">
        <form className="file-filters" action="/files" method="get">
          <label className="file-filter-query">Name<input name="q" defaultValue={params.q} placeholder="Runbook or screenshot" /></label>
          <label>Type<select name="type" defaultValue={params.type ?? ""}><option value="">Any type</option><option value="image/">Images</option><option value="text/">Text</option><option value="application/pdf">PDFs</option><option value="application/zip">ZIP archives</option></select></label>
          <label>Uploader<select name="uploader" defaultValue={params.uploader ?? ""}><option value="">Anyone</option>{uploaders.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
          <label>Room<select name="room" defaultValue={params.room ?? ""}><option value="">Every room</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channelLabel(channel)}</option>)}</select></label>
          <label>From<input name="after" type="date" defaultValue={params.after} /></label>
          <label>Through<input name="before" type="date" defaultValue={params.before} /></label>
          <div className="file-filter-actions"><button className="primary-link" type="submit">Filter files</button><a href="/files">Clear</a></div>
        </form>
      </section>

      {index.files.length === 0 ? (
        <section className="empty-state"><h2>No files match</h2><p>Change a filter, or attach a file in a room.</p></section>
      ) : (
        <ol className="file-index" aria-label="Workspace files">
          {index.files.map((file) => <FileRow key={file.id} file={file} />)}
        </ol>
      )}
    </>
  );
}

function FileRow({ file }: { file: StoredFile }) {
  const Icon = file.mediaType.startsWith("image/") ? FileImage
    : file.mediaType === "application/zip" ? FileArchive
    : file.mediaType.startsWith("text/") || file.mediaType === "application/pdf" ? FileText : File;
  const room = file.channelSlug ?? file.channelName ?? file.channelId;
  return (
    <li>
      <a className="file-ribbon" href={`/files/${file.id}`} download={file.fileName}>
        <span className="file-kind" aria-hidden="true"><Icon size={20} /></span>
        <span className="file-identity"><strong>{file.fileName}</strong><small>{file.mediaType} · {formatBytes(file.byteLength)}</small></span>
        <span className="file-provenance"><span>#{room}</span><span>{file.uploadedByDisplayName ?? "Former member"}</span></span>
        <time dateTime={new Date(file.createdAt).toISOString()}>{formatDate(file.createdAt)}</time>
      </a>
    </li>
  );
}

function allowedType(value: string | undefined): string | null {
  return ["image/", "text/", "application/pdf", "application/zip"].includes(value ?? "") ? value! : null;
}

function dateBoundary(value: string | undefined, exclusiveNextDay: boolean): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() + (exclusiveNextDay ? 24 * 60 * 60 * 1000 : 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(timestamp);
}
