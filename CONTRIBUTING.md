# How We Work

## Branches

- `main` — always deployable. **No direct pushes**; changes only through pull requests.
- Work branches are created from `main`:

| Prefix | Use | Example |
|---|---|---|
| `feature/` | New functionality | `feature/FR-4-booking-api` |
| `fix/` | Bug fix | `fix/double-booking-race` |
| `chore/` | Tooling, deps, config | `chore/add-eslint` |
| `docs/` | Documentation only | `docs/update-requirements` |
| `test/` | Tests only | `test/k6-booking-load` |

Include the requirement ID (e.g. `FR-4`) in the branch name when there is one.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(booking): reject booking of past slots (FR-4.2)
fix(auth): return 401 for expired token
test(api): add 409 conflict test for same slot
docs: add decisions log
chore(ci): add lint job
```

## Pull requests

1. Keep PRs small: one feature or fix.
2. Fill in the PR template (what, why, requirement IDs, how tested).
3. All required CI checks must pass before merge.
4. At least one review (for this personal sample: self-review using the checklist).
5. Squash-merge into `main` and delete the branch.

## Daily flow

```powershell
git switch main
git pull
git switch -c feature/FR-x-short-name
# ...make changes, run checks locally...
git add .
git commit -m "feat(scope): message"
git push -u origin feature/FR-x-short-name
# open a pull request on GitHub
```

## Never commit

- `.env` files, passwords, tokens, private keys, connection strings
- Real personal / patient data
- `node_modules/`, build output, coverage reports
