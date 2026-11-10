import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type ICachePlugin,
} from '@azure/msal-node';
import { GraphError, type TokenProvider } from './types';

/** App-only auth for SharePoint (work/school tenant). No human sign-in. MSAL caches and renews tokens. */
export class ClientCredentialTokenProvider implements TokenProvider {
  private readonly msal: ConfidentialClientApplication;

  constructor(cfg: { tenantId: string; clientId: string; clientSecret: string }) {
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      },
    });
  }

  async getToken(): Promise<string> {
    const result = await this.msal.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });
    if (!result?.accessToken) throw new GraphError('MSAL returned no access token', 'permanent');
    return result.accessToken;
  }
}

export interface TokenCacheStore {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export const ONEDRIVE_SCOPES = ['Files.ReadWrite', 'offline_access'];
export const NOT_SIGNED_IN =
  'OneDrive is not signed in. Run "npm run auth:onedrive" in the server folder, then retry failed records.';

/**
 * Delegated auth for a FREE personal Microsoft account's OneDrive.
 * One-time device-code sign-in; afterwards the stored refresh token is used silently.
 */
export class DelegatedTokenProvider implements TokenProvider {
  private readonly pca: PublicClientApplication;

  constructor(clientId: string, store: TokenCacheStore) {
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (ctx) => {
        const data = await store.load();
        if (data) ctx.tokenCache.deserialize(data);
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) await store.save(ctx.tokenCache.serialize());
      },
    };
    this.pca = new PublicClientApplication({
      auth: { clientId, authority: 'https://login.microsoftonline.com/consumers' },
      cache: { cachePlugin },
    });
  }

  /** Interactive one-time sign-in. `show` receives the "go to microsoft.com/devicelogin" message. */
  async signInWithDeviceCode(show: (message: string) => void): Promise<string> {
    const result = await this.pca.acquireTokenByDeviceCode({
      scopes: ONEDRIVE_SCOPES,
      deviceCodeCallback: (d) => show(d.message),
    });
    return result?.account?.username ?? 'unknown account';
  }

  async getToken(): Promise<string> {
    const account = (await this.pca.getTokenCache().getAllAccounts())[0];
    if (!account) throw new GraphError(NOT_SIGNED_IN, 'transient');
    try {
      const result = await this.pca.acquireTokenSilent({ account, scopes: ONEDRIVE_SCOPES });
      if (!result?.accessToken) throw new Error('no access token returned');
      return result.accessToken;
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new GraphError(`OneDrive token refresh failed (${reason}). ${NOT_SIGNED_IN}`, 'transient');
    }
  }
}
