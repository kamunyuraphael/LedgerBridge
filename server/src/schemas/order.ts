import { z } from 'zod';

export const MAX_QTY = 100_000;
export const MAX_LINES = 300;

const itemNo = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid item number');
const qty = z.number().int().min(1).max(MAX_QTY);

/** Branches choose items only. Quantities come from HQ's standard quantities on the server. */
export const submitOrderSchema = z.object({
  requestId: z.uuid(),
  note: z.string().trim().max(500).optional(),
  itemNos: z.array(itemNo).min(1).max(MAX_LINES),
});

export const transitionSchema = z.object({
  to: z.enum(['approved', 'rejected', 'sent', 'fulfilled', 'cancelled']),
  reason: z.string().trim().max(500).optional(),
  poNumber: z.string().max(60).optional(),
});

export const editLinesSchema = z.object({
  lines: z.array(z.object({ itemNo, qty })).min(1).max(MAX_LINES),
});

export const poSchema = z.object({ poNumber: z.string().max(60) });

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export const createUserSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['branch', 'hq']),
  branchCode: z.string().trim().min(1).max(20).optional(),
  password: z.string().min(8).max(128).optional(),
});
