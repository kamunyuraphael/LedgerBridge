/** One-time sign-in for GRAPH_MODE=onedrive:  npm run auth:onedrive */
import mongoose from 'mongoose';
import { loadEnv } from '../config/env';
import { createOneDriveTokens } from '../services/buildPipeline';

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.GRAPH_MODE !== 'onedrive') {
    throw new Error('Set GRAPH_MODE=onedrive in server/.env first.');
  }
  await mongoose.connect(env.MONGODB_URI);
  const provider = createOneDriveTokens(env);
  const who = await provider.signInWithDeviceCode((msg) => console.log(`\n${msg}\n`));
  await provider.getToken(); // proves the silent path works and persists the cache
  console.log(`Signed in as ${who}. LedgerBridge can now write to this OneDrive without further prompts.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
