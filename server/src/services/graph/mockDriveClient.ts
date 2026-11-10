import { GraphError, type DownloadedFile, type DriveClient, type UploadOptions } from './types';

interface StoredFile {
  data: Buffer;
  version: number;
}

/**
 * In-memory fake of a SharePoint document library. Enforces the same eTag / create-only
 * semantics as Graph and supports fault injection so the pipeline can be tested offline.
 */
export class MockDriveClient implements DriveClient {
  private readonly files = new Map<string, StoredFile>();
  private failures: GraphError[] = [];
  /** Artificial latency per call (ms) to widen race windows in tests. */
  latencyMs = 0;
  readonly calls = { download: 0, upload: 0 };

  /** Queue errors that the next N calls (download or upload) will throw. */
  injectFailures(...errors: GraphError[]): void {
    this.failures.push(...errors);
  }

  private async gate(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const next = this.failures.shift();
    if (next) throw next;
  }

  private etag(file: StoredFile): string {
    return `"mock-${file.version}"`;
  }

  async download(path: string): Promise<DownloadedFile | null> {
    this.calls.download++;
    await this.gate();
    const file = this.files.get(path);
    if (!file) return null;
    const copy = Uint8Array.from(file.data);
    return { data: copy.buffer, eTag: this.etag(file) };
  }

  async upload(path: string, data: Buffer, options: UploadOptions = {}): Promise<{ eTag: string }> {
    this.calls.upload++;
    await this.gate();
    const existing = this.files.get(path);
    if (options.failIfExists && existing) {
      throw new GraphError('nameAlreadyExists', 'conflict', 409);
    }
    if (options.ifMatch && (!existing || this.etag(existing) !== options.ifMatch)) {
      throw new GraphError('preconditionFailed', 'conflict', 412);
    }
    const file: StoredFile = { data: Buffer.from(data), version: (existing?.version ?? 0) + 1 };
    this.files.set(path, file);
    return { eTag: this.etag(file) };
  }

  /** Test / dev helpers. */
  getFile(path: string): Buffer | undefined {
    return this.files.get(path)?.data;
  }
  listFiles(): string[] {
    return [...this.files.keys()];
  }
  deleteFile(path: string): void {
    this.files.delete(path);
  }
  putRaw(path: string, data: Buffer): void {
    const existing = this.files.get(path);
    this.files.set(path, { data, version: (existing?.version ?? 0) + 1 });
  }
}
