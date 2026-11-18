# How We Work

## Branches

We use **two long-lived branches** only (decision D-21):

| Branch    | Purpose                                                             |
| --------- | ------------------------------------------------------------------- |
| `main`    | Released, always working code. **No direct pushes** — only via PR.  |
| `develop` | All day-to-day work. Commit here, push here, CI runs on every push. |

When `develop` is ready, open **one pull request `develop` → `main`**.
The same flow is used in `appointment_web`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(booking): reject booking of past slots (FR-4.2)
fix(auth): return 401 for expired token
test(api): add 409 conflict test for same slot
docs: add decisions log
chore(ci): add lint job
```

## Pull requests (`develop` → `main`)

1. Fill in the PR template (what, why, requirement IDs, how tested).
2. All required CI checks must pass before merge.
3. Self-review using the checklist (personal sample).
4. Merge with **"Create a merge commit"** — **not** squash. Squash would make
   `develop` and `main` drift apart and cause conflicts on the next PR.
5. Do **not** delete `develop` after merging.

## Daily flow

```powershell
git switch develop
git pull
# ...make changes, run checks locally...
git add .
git commit -m "feat(scope): message"
git push
# when ready to release: open a pull request develop -> main on GitHub
```

A **pre-commit hook** (`.githooks/pre-commit`, enabled by `npm install`) runs `npm run check`
before every commit. If lint, formatting or tests fail, the commit is blocked.

## Never commit

- `.env` files, passwords, tokens, private keys, connection strings
- Real personal / patient data
- `node_modules/`, build output, coverage reports
