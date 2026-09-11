# SafetySpell

## Documentation lives in the wiki

SafetySpell's durable documentation lives at `D:\project-wiki\10-systems\safetyspell\`. Read `WIKI_SYNC.md` before changing behavior and start with the project overview when context is needed.

- The public scan view must receive only data already filtered by the backend consent boundary.
- Treat guardian-controlled health information as sensitive: public fields are opt-in; home address and full records are never public.
- Keep the public scan experience fast, login-free, and focused on immediate action.
- Verify locally before a change is considered complete. Do not deploy or merge without the owner's explicit go-ahead.

## Wiki maintenance

For behavior, data, or interface changes, update the mapped SafetySpell page in the wiki during the same session. Use `D:\project-wiki\_tools\lint.sh safetyspell`, `align.sh safetyspell`, and `sync-check.sh safetyspell` before committing a documentation batch.
