import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env';
import { User } from '../models/User';
import { Branch } from '../models/catalog';
import { changePasswordSchema, loginSchema } from '../schemas/order';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../services/auth';

export function authRouter(env: Env): Router {
  const r = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many login attempts. Try again in a few minutes.' },
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) {
      res.status(422).json({ error: 'validation_failed' });
      return;
    }
    const user = await User.findOne({ username: p.data.username.toLowerCase() });
    // Same message for unknown user / wrong password / inactive: no account probing.
    const ok = user && user.active && (await verifyPassword(p.data.password, user.passwordHash));
    if (!user || !ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(String(user._id), env.JWT_SECRET, env.JWT_EXPIRES_IN), user: await presentUser(user) });
  });

  r.get('/me', requireAuth(env.JWT_SECRET), async (req, res) => {
    const u = await User.findById(req.user!.id);
    res.json({ user: await presentUser(u!) });
  });

  r.post('/change-password', requireAuth(env.JWT_SECRET), async (req, res) => {
    const p = changePasswordSchema.safeParse(req.body);
    if (!p.success) {
      res.status(422).json({ error: 'validation_failed', message: 'New password must be at least 8 characters.' });
      return;
    }
    const u = await User.findById(req.user!.id);
    if (!u || !(await verifyPassword(p.data.currentPassword, u.passwordHash))) {
      res.status(401).json({ error: 'invalid_credentials', message: 'Current password is wrong.' });
      return;
    }
    u.passwordHash = await hashPassword(p.data.newPassword);
    u.mustChangePassword = false;
    await u.save();
    res.json({ ok: true });
  });

  return r;
}

async function presentUser(u: InstanceType<typeof User>) {
  const branch = u.branchCode ? await Branch.findOne({ code: u.branchCode }).lean() : null;
  return {
    id: String(u._id),
    username: u.username,
    name: u.name,
    role: u.role,
    branchCode: u.branchCode ?? undefined,
    branchName: branch?.name,
    mustChangePassword: u.mustChangePassword,
  };
}
