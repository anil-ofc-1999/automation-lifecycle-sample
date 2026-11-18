// NFR-8: docs/openapi.yaml must document exactly the routes the code serves.
import { readFileSync } from 'node:fs';

import { describe, it, expect, vi } from 'vitest';
import { parse } from 'yaml';

vi.mock('../src/db.js', () => ({
  prisma: {},
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: vi.fn(),
}));

import { appointmentsRouter } from '../src/routes/appointments.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { doctorsRouter } from '../src/routes/doctors.js';
import { specializationsRouter } from '../src/routes/specializations.js';
import { meRouter } from '../src/routes/users.js';

// Same mount points as src/app.js
const MOUNTS = {
  '/auth': createAuthRouter(),
  '/me': meRouter,
  '/specializations': specializationsRouter,
  '/doctors': doctorsRouter,
  '/appointments': appointmentsRouter,
};

// Express "/:id" -> OpenAPI "/{id}"
const toOpenApiPath = (prefix, path) =>
  (prefix + (path === '/' ? '' : path)).replace(/:(\w+)/g, '{$1}');

function routesInCode() {
  const routes = [];
  for (const [prefix, router] of Object.entries(MOUNTS)) {
    for (const layer of router.stack.filter((l) => l.route)) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${toOpenApiPath(prefix, layer.route.path)}`);
      }
    }
  }
  return routes.sort();
}

const spec = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));

function routesInSpec() {
  const routes = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) routes.push(`${method.toUpperCase()} ${path}`);
  }
  return routes.sort();
}

describe('OpenAPI spec (NFR-8)', () => {
  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('documents exactly the routes implemented in code', () => {
    expect(routesInSpec()).toEqual(routesInCode());
  });

  it('every operation has a summary and responses', () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('every $ref points to an existing component', () => {
    const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) ?? [];
    for (const ref of new Set(refs)) {
      const [, , section, name] = JSON.parse(ref).split('/');
      expect(spec.components[section]?.[name], ref).toBeDefined();
    }
  });
});
