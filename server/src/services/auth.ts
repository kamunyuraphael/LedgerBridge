import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import type { Role } from './orderLogic';

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  branchCode?: string;
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

export function signToken(userId: string, secret: string, expiresIn: string): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

/** Readable temporary password (no look-alike characters). */
export function tempPassword(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function requireAuth(secret: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    let sub: string | undefined;
    try {
      const payload = jwt.verify(token, secret);
      sub = typeof payload === 'object' ? payload.sub : undefined;
    } catch {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const user = sub ? await User.findById(sub).lean() : null;
    if (!user || !user.active) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = {
      id: String(user._id),
      username: user.username,
      name: user.name,
      role: user.role,
      ...(user.branchCode ? { branchCode: user.branchCode } : {}),
      mustChangePassword: user.mustChangePassword,
    };
    next();
  };
}

export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
