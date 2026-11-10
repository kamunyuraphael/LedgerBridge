export interface DownloadedFile {
  data: ArrayBuffer;
  eTag: string;
}

export interface UploadOptions {
  /** Replace only if the remote file still has this eTag (optimistic concurrency). */
  ifMatch?: string;
  /** Create only; fail if a file already exists at the path. */
  failIfExists?: boolean;
}

/** Minimal drive abstraction so the pipeline runs against SharePoint or an in-memory fake. */
export interface DriveClient {
  /** Returns null ONLY when the item does not exist (404 itemNotFound). */
  download(path: string): Promise<DownloadedFile | null>;
  upload(path: string, data: Buffer, options?: UploadOptions): Promise<{ eTag: string }>;
}

export type GraphErrorKind = 'not_found' | 'conflict' | 'throttled' | 'transient' | 'permanent';

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly kind: GraphErrorKind,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  get retryable(): boolean {
    return this.kind === 'throttled' || this.kind === 'transient' || this.kind === 'conflict';
  }
}

/** Supplies a bearer token for Microsoft Graph (app-only or delegated). */
export interface TokenProvider {
  getToken(): Promise<string>;
}
