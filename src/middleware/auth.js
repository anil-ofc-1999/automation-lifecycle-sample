import jwt from 'jsonwebtoken';

import { verifyAccessToken } from '../auth/tokens.js';
import { AppError } from '../errors.js';

// FR-1.7: every protected API checks the token...
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Login required.'));
  }
  try {
    req.user = verifyAccessToken(token);
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(
        new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Please log in again.'),
      );
    }
    return next(new AppError(401, 'UNAUTHORIZED', 'Login required.'));
  }
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
