import { z } from 'zod';

export const MAX_SUPPLIERS = 60;

const supplierCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid supplier code');

/**
 * Branches choose suppliers only. Which products and how much is decided by HQ's own system, so the
 * request carries no items or quantities (any extra fields are dropped).
 */
export const submitOrderSchema = z.object({
  requestId: z.uuid(),
  note: z.string().trim().max(500).optional(),
  supplierCodes: z.array(supplierCode).min(1).max(MAX_SUPPLIERS),
});

export const transitionSchema = z.object({
  to: z.enum(['approved', 'rejected', 'sent', 'fulfilled', 'cancelled']),
  reason: z.string().trim().max(500).optional(),
  poNumber: z.string().max(60).optional(),
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
