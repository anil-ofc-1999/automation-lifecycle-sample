import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';

// Fields safe to send to the client — never the password hash.
export function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
  };
}

export const meRouter = Router();

// GET /api/v1/me — current user's profile (any role).
meRouter.get('/', requireAuth, (req, res) => {
  res.status(200).json({ user: toPublicUser(req.currentUser) });
});
