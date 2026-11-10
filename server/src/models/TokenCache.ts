import { Schema, model } from 'mongoose';
import type { TokenCacheStore } from '../services/graph/tokenProviders';
import { decrypt, encrypt } from '../utils/crypto';

const tokenCacheSchema = new Schema(
  { key: { type: String, required: true, unique: true }, data: { type: String, required: true } },
  { timestamps: true },
);
const TokenCache = model('TokenCache', tokenCacheSchema);

/** Persists the MSAL token cache (contains a refresh token) in MongoDB, encrypted at rest. */
export class MongoTokenCacheStore implements TokenCacheStore {
  constructor(
    private readonly encryptionKeyHex: string,
    private readonly key = 'onedrive',
  ) {}

  async load(): Promise<string | null> {
    const doc = await TokenCache.findOne({ key: this.key });
    return doc ? decrypt(doc.data, this.encryptionKeyHex) : null;
  }

  async save(data: string): Promise<void> {
    await TokenCache.updateOne(
      { key: this.key },
      { $set: { data: encrypt(data, this.encryptionKeyHex) } },
      { upsert: true },
    );
  }
}
