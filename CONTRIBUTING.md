# Contributing

Microsendr handles financial state. Keep each change small enough to review and prove its accounting effects.

1. Describe the behavior and financial invariant being changed.
2. Update domain code and API contract together; run `pnpm generate`.
3. Test idempotency, duplicate callbacks, unknown outcomes, concurrency and journal balance when money movement changes.
4. Run `pnpm build`, `pnpm check` and the relevant browser or provider suite.
5. Update `docs/microsendr-settlement-status.md` with changed capabilities and launch gates.

Never commit provider keys, identity documents, wallet secrets, production customer data or live transaction fixtures. Use synthetic identities and test accounts. Report security issues privately as described in [SECURITY.md](SECURITY.md).
