import { Router } from 'express';
import { z } from 'zod';

import { prisma, uniqueViolationIndex } from '../db.js';
import { AppError, validate } from '../errors.js';
import { toSpecialization } from '../lib/serializers.js';
import { idParamsSchema, queryBoolean } from '../lib/validation.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const nameField = z.string().trim().min(2, 'Name must be at least 2 characters.').max(100);

const createSchema = z.object({ name: nameField });
const updateSchema = z
  .object({ name: nameField.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Nothing to update.');
const listQuerySchema = z.object({ includeInactive: queryBoolean });

const alreadyExists = () =>
  new AppError(409, 'SPECIALIZATION_EXISTS', 'A specialization with this name already exists.');

// Names are unique ignoring case ("cardiology" = "Cardiology").
async function assertNameFree(name, exceptId) {
  const clash = await prisma.specialization.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
  });
  if (clash) throw alreadyExists();
}

export const specializationsRouter = Router();
specializationsRouter.use(requireAuth);

// GET /specializations — active ones; admin may add ?includeInactive=true
specializationsRouter.get('/', async (req, res) => {
  const { includeInactive } = validate(listQuerySchema, req.query);
  const showAll = includeInactive === true && req.user.role === 'ADMIN';

  const items = await prisma.specialization.findMany({
    where: showAll ? {} : { isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json({ items: items.map(toSpecialization) });
});

// POST /specializations — FR-2.1 (admin)
specializationsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const { name } = validate(createSchema, req.body);
  await assertNameFree(name);
  try {
    const created = await prisma.specialization.create({ data: { name } });
    res.status(201).json({ specialization: toSpecialization(created) });
  } catch (err) {
    if (uniqueViolationIndex(err)) throw alreadyExists();
    throw err;
  }
});

// PATCH /specializations/:id — rename / activate / deactivate (FR-2.1, admin)
specializationsRouter.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const input = validate(updateSchema, req.body);

  const existing = await prisma.specialization.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Specialization not found.');
  if (input.name !== undefined) await assertNameFree(input.name, id);

  try {
    const updated = await prisma.specialization.update({ where: { id }, data: input });
    res.json({ specialization: toSpecialization(updated) });
  } catch (err) {
    if (uniqueViolationIndex(err)) throw alreadyExists();
    throw err;
  }
});
