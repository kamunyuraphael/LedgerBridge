import axios, { AxiosError, type AxiosInstance } from 'axios';
import { GraphError, type DownloadedFile, type DriveClient, type TokenProvider, type UploadOptions } from './types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // Graph simple PUT limit
const CHUNK = 320 * 1024 * 10; // upload-session chunks must be multiples of 320 KiB

export interface GraphHttpConfig {
  /** Path prefix up to and including "root:", e.g. "/sites/{site}/drives/{drive}/root:" or "/me/drive/root:". */
  rootPrefix: string;
  tokens: TokenProvider;
}

export class GraphHttpClient implements DriveClient {
  private readonly http: AxiosInstance;
  private readonly root: string;
  private readonly tokens: TokenProvider;

  constructor(cfg: GraphHttpConfig) {
    this.http = axios.create({ baseURL: GRAPH_BASE, timeout: 30_000 });
    this.root = cfg.rootPrefix;
    this.tokens = cfg.tokens;
  }

  /** Bearer token from the configured provider (app-only or delegated). */
  private token(): Promise<string> {
    return this.tokens.getToken();
  }

  private itemPath(path: string): string {
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${this.root}/${encoded}`;
  }

  async download(path: string): Promise<DownloadedFile | null> {
    const headers = { Authorization: `Bearer ${await this.token()}` };
    try {
      // Metadata FIRST: if the file changes afterwards, the upload's If-Match fails safely (412).
      const meta = await this.http.get<{ eTag: string }>(this.itemPath(path), {
        headers,
        params: { $select: 'id,eTag' },
      });
      const content = await this.http.get<ArrayBuffer>(`${this.itemPath(path)}:/content`, {
        headers,
        responseType: 'arraybuffer',
      });
      return { data: content.data, eTag: meta.data.eTag };
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.kind === 'not_found') return null;
      throw mapped;
    }
  }

  async upload(path: string, data: Buffer, options: UploadOptions = {}): Promise<{ eTag: string }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (options.ifMatch) headers['If-Match'] = options.ifMatch;
    const conflictBehavior = options.failIfExists ? 'fail' : 'replace';
    try {
      if (data.length <= SIMPLE_UPLOAD_LIMIT) {
        const res = await this.http.put<{ eTag: string }>(`${this.itemPath(path)}:/content`, data, {
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          params: { '@microsoft.graph.conflictBehavior': conflictBehavior },
          maxBodyLength: Infinity,
        });
        return { eTag: res.data.eTag };
      }
      return await this.uploadLarge(path, data, headers, conflictBehavior);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Upload session for files above the 4 MB simple-upload limit. */
  private async uploadLarge(
    path: string,
    data: Buffer,
    headers: Record<string, string>,
    conflictBehavior: string,
  ): Promise<{ eTag: string }> {
    const session = await this.http.post<{ uploadUrl: string }>(
      `${this.itemPath(path)}:/createUploadSession`,
      { item: { '@microsoft.graph.conflictBehavior': conflictBehavior } },
      { headers },
    );
    let last: { eTag?: string } = {};
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      // The pre-authenticated upload URL must NOT carry the bearer token.
      const res = await axios.put<{ eTag?: string }>(session.data.uploadUrl, data.subarray(start, end), {
        headers: {
          'Content-Length': String(end - start),
          'Content-Range': `bytes ${start}-${end - 1}/${data.length}`,
        },
        maxBodyLength: Infinity,
        timeout: 60_000,
      });
      last = res.data;
    }
    if (!last.eTag) throw new GraphError('Upload session finished without an eTag', 'transient');
    return { eTag: last.eTag };
  }
}

export function mapError(err: unknown): GraphError {
  if (err instanceof GraphError) return err;
  if (axios.isAxiosError(err)) return fromAxios(err);
  return new GraphError(err instanceof Error ? err.message : String(err), 'permanent');
}

function fromAxios(err: AxiosError): GraphError {
  const status = err.response?.status;
  const body = err.response?.data as { error?: { code?: string; message?: string } } | undefined;
  const detail = body?.error?.code ?? err.code ?? 'unknown';
  const msg = `Graph ${err.config?.method?.toUpperCase() ?? ''} failed (${status ?? 'no response'}): ${detail}`;

  if (!status) return new GraphError(msg, 'transient'); // timeout / DNS / reset
  if (status === 404) return new GraphError(msg, 'not_found', status);
  if (status === 409 || status === 412) return new GraphError(msg, 'conflict', status);
  // 408 timeout / 423 locked (file checked out or briefly locked by another editor): retry later.
  if (status === 408 || status === 423) return new GraphError(msg, 'transient', status);
  if (status === 429 || status === 503) {
    const raw = err.response?.headers?.['retry-after'];
    const secs = typeof raw === 'string' ? Number(raw) : NaN;
    return new GraphError(msg, 'throttled', status, Number.isFinite(secs) ? secs * 1000 : undefined);
  }
  if (status >= 500) return new GraphError(msg, 'transient', status);
  return new GraphError(msg, 'permanent', status); // 400 / 401 / 403 ...
}
