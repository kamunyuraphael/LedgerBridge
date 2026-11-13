import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    TRUST_PROXY: bool,

    MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/ledgerbridge'),

    /** Signs login tokens. Min 32 chars; generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" */
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    /** First HQ account, created at startup only if no HQ user exists yet. */
    BOOTSTRAP_ADMIN_USERNAME: z.string().trim().min(3).default('hq'),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),

    /** Protects admin-only routes (e.g. retry). Never ship this to the client. */
    ADMIN_API_KEY: z.string().min(16).optional(),

    /** Storage mode (name kept for compatibility): mock | onedrive | live (SharePoint) | sheets (Google Sheets). */
    GRAPH_MODE: z.enum(['live', 'onedrive', 'sheets', 'mock']).default('mock'),
    GOOGLE_SHEET_ID: z.string().optional(),
    /** base64 of the downloaded service-account JSON key file */
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
    /** Required for GRAPH_MODE=onedrive: 64 hex chars used to encrypt the stored refresh token. */
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters').optional(),
    AZURE_TENANT_ID: z.string().optional(),
    AZURE_CLIENT_ID: z.string().optional(),
    AZURE_CLIENT_SECRET: z.string().optional(),
    SP_SITE_ID: z.string().optional(),
    SP_DRIVE_ID: z.string().optional(),
    SP_FOLDER_PATH: z.string().default('Ledgers'),

    /** Tab prefix for the approved-orders ledger (sheets mode), e.g. Orders_2026-11. */
    ORDER_LEDGER_PREFIX: z.string().trim().min(1).max(40).default('Orders'),
    /** Load simulated branches and products (with demo logins) when the database is empty. */
    SEED_DEMO_DATA: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),

    LEDGER_FILE_PREFIX: z.string().min(1).default('Sales_Ledger'),
    /** Currency shown in the ledger's revenue column header. */
    LEDGER_CURRENCY: z.string().trim().min(1).max(8).default('KES'),
    LEDGER_ROLLOVER: z.enum(['monthly', 'none']).default('monthly'),

    SYNC_POLL_MS: z.coerce.number().int().min(250).default(5000),
    SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(6),
    SYNC_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(5000),
    SYNC_LOCK_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
  })
  .superRefine((env, ctx) => {
    if (env.GRAPH_MODE === 'live') {
      for (const key of [
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'SP_SITE_ID',
        'SP_DRIVE_ID',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when GRAPH_MODE=live`,
          });
        }
      }
    }
    if (env.GRAPH_MODE === 'sheets') {
      for (const key of ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when GRAPH_MODE=sheets` });
        }
      }
    }
    if (env.GRAPH_MODE === 'onedrive') {
      for (const key of ['AZURE_CLIENT_ID', 'TOKEN_ENCRYPTION_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when GRAPH_MODE=onedrive` });
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.GRAPH_MODE === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['GRAPH_MODE'],
        message: 'GRAPH_MODE=mock is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
