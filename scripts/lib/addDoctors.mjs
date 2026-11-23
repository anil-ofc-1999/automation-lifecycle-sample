// Adds specializations and doctors through the API, skipping anything that already exists
// (D-33). Used by scripts/add-doctors.mjs; kept separate so it can be tested.
//
// `client(method, path, body)` must call the API as an ADMIN and resolve to
// { status, body }. Nothing here talks to the database directly.

const SLOT_MINUTES = [15, 30];
const key = (text) => text.trim().toLowerCase();

/** Checks the data file before anything is sent. Returns a list of problems (empty = fine). */
export function validateData(data) {
  const problems = [];
  if (!data || !Array.isArray(data.specializations) || !Array.isArray(data.doctors)) {
    return ['The file needs "specializations" and "doctors" lists.'];
  }
  const schedules = data.schedules ?? {};

  const seenSpecs = new Set();
  for (const name of data.specializations) {
    if (typeof name !== 'string' || name.trim().length < 2) {
      problems.push(`Specialization name too short: ${JSON.stringify(name)}`);
    } else if (seenSpecs.has(key(name))) {
      problems.push(`Specialization listed twice: ${name}`);
    } else seenSpecs.add(key(name));
  }

  const seenEmails = new Set();
  const seenNames = new Set();
  data.doctors.forEach((d, i) => {
    const where = `Doctor #${i + 1} (${d?.name ?? 'no name'})`;
    if (typeof d?.name !== 'string' || d.name.trim().length < 2) problems.push(`${where}: name`);
    if (typeof d?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
      problems.push(`${where}: invalid email`);
    } else if (seenEmails.has(key(d.email))) {
      problems.push(`${where}: email listed twice (${d.email})`);
    } else seenEmails.add(key(d.email));
    if (typeof d?.name === 'string') {
      if (seenNames.has(key(d.name))) problems.push(`${where}: name listed twice`);
      seenNames.add(key(d.name));
    }
    if (!seenSpecs.has(key(d?.specialization ?? ''))) {
      problems.push(`${where}: specialization "${d?.specialization}" is not in the list`);
    }
    if (typeof d?.fee !== 'number' || d.fee < 0) problems.push(`${where}: fee`);
    if (!SLOT_MINUTES.includes(d?.slotMinutes)) problems.push(`${where}: slotMinutes 15 or 30`);
    if (d?.schedule !== undefined && !schedules[d.schedule]) {
      problems.push(`${where}: unknown schedule "${d.schedule}"`);
    }
  });
  return problems;
}

async function expectOk(client, method, path, body, okStatus = [200, 201]) {
  const res = await client(method, path, body);
  if (!okStatus.includes(res.status)) {
    const message = res.body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(`${method} ${path}: ${message}`);
    err.status = res.status;
    err.code = res.body?.error?.code;
    throw err;
  }
  return res.body;
}

/** Every doctor email already in the system (active and inactive). */
async function existingDoctorEmails(client) {
  const emails = new Set();
  for (let page = 1; ; page += 1) {
    const res = await expectOk(
      client,
      'GET',
      `/doctors?includeInactive=true&pageSize=50&page=${page}`,
    );
    for (const d of res.items) if (d.email) emails.add(key(d.email));
    if (page >= res.totalPages) break;
  }
  return emails;
}

/**
 * Adds what is missing. With dryRun nothing is changed; the summary says what would happen.
 * @returns {Promise<{ specializations: object, doctors: object }>}
 */
export async function addDoctors({ client, data, doctorPassword, dryRun = false, log = () => {} }) {
  const problems = validateData(data);
  if (problems.length > 0) {
    const err = new Error(
      `The data file has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`,
    );
    err.problems = problems;
    throw err;
  }

  const summary = {
    specializations: { created: [], existing: [], inactive: [] },
    doctors: { created: [], existing: [], skipped: [] },
  };

  // 1. Specializations — matched by name, ignoring case and spaces at the ends.
  const specList = await expectOk(client, 'GET', '/specializations?includeInactive=true');
  const specByKey = new Map(specList.items.map((s) => [key(s.name), s]));
  for (const name of data.specializations) {
    const found = specByKey.get(key(name));
    if (found) {
      (found.isActive ? summary.specializations.existing : summary.specializations.inactive).push(
        found.name,
      );
      continue;
    }
    if (dryRun) {
      specByKey.set(key(name), { id: null, name: name.trim(), isActive: true });
    } else {
      const res = await expectOk(client, 'POST', '/specializations', { name: name.trim() });
      specByKey.set(key(name), res.specialization);
      log(`+ specialization ${res.specialization.name}`);
    }
    summary.specializations.created.push(name.trim());
  }

  // 2. Doctors — matched by email (unique per account, ignoring case).
  const emails = await existingDoctorEmails(client);
  for (const d of data.doctors) {
    if (emails.has(key(d.email))) {
      summary.doctors.existing.push(d.email);
      continue;
    }
    const spec = specByKey.get(key(d.specialization));
    if (!spec.isActive) {
      summary.doctors.skipped.push({ email: d.email, reason: `${spec.name} is inactive` });
      continue;
    }
    if (dryRun) {
      summary.doctors.created.push(d.email);
      emails.add(key(d.email));
      continue;
    }

    let created;
    try {
      created = await expectOk(client, 'POST', '/doctors', {
        name: d.name.trim(),
        email: d.email.trim(),
        password: doctorPassword,
        specializationId: spec.id,
        fee: d.fee,
        slotMinutes: d.slotMinutes,
        ...(d.bio ? { bio: d.bio } : {}),
      });
    } catch (err) {
      // The email belongs to a non-doctor account (e.g. a patient): leave it alone.
      if (err.code === 'EMAIL_TAKEN') {
        summary.doctors.skipped.push({ email: d.email, reason: 'email used by another account' });
        continue;
      }
      throw err;
    }
    emails.add(key(d.email));
    if (d.schedule) {
      await expectOk(client, 'PUT', `/doctors/${created.doctor.id}/schedule`, {
        blocks: data.schedules[d.schedule],
      });
    }
    summary.doctors.created.push(d.email);
    log(`+ ${d.name} (${spec.name})`);
  }
  return summary;
}
