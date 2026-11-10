import { z } from 'zod';

/** Characters that make Excel interpret a cell as a formula (CSV / formula injection). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export const saleInputSchema = z.object({
  /** Optional client-generated UUID: makes double-clicks and network retries idempotent. */
  recordId: z.uuid().optional(),
  storeCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2-12 letters, digits or hyphens')),
  sku: z
    .string()
    .trim()
    .min(1, 'SKU is required')
    .max(64, 'SKU is too long')
    .refine((v) => !FORMULA_LEAD.test(v), 'SKU must not start with = + - @'),
  unitsSold: z
    .number({ error: 'Units sold must be a number' })
    .int('Units sold must be a whole number')
    .positive('Units sold must be greater than 0')
    .max(1_000_000, 'Units sold is too large'),
  totalRevenue: z
    .number({ error: 'Total revenue must be a number' })
    .finite()
    .min(0, 'Total revenue cannot be negative')
    .max(1_000_000_000, 'Total revenue is too large')
    .refine(
      (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      'Use at most 2 decimal places',
    ),
  clientSubmittedAt: z.iso.datetime().optional(),
});

export type SaleInput = z.infer<typeof saleInputSchema>;

export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => cents / 100;
