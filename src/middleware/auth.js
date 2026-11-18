import jwt from 'jsonwebtoken';

import { verifyAccessToken } from '../auth/tokens.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';

const loginRequired = () => new AppError(401, 'UNAUTHORIZED', 'Login required.');

// FR-1.7: every protected API checks the token...
// The user is re-loaded from the database, so a deactivated account or a changed
// role takes effect immediately instead of when the token expires.
export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw loginRequired();

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Please log in again.');
    }
    throw loginRequired();
  }

  const user = Number.isInteger(claims.userId)
    ? await prisma.user.findUnique({ where: { id: claims.userId } })
    : null;
  if (!user || !user.isActive) throw loginRequired();

  req.user = { userId: user.id, role: user.role };
  req.currentUser = user;
  next();
}

// ...and the user's role. Use after requireAuth, e.g. requireRole('ADMIN').
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'));
    }
    return next();
  };
}
