# Security policy

Do not disclose vulnerabilities, API keys, private keys, identity documents or customer data in public issues. Contact the maintainers privately through GitHub's **Report a vulnerability** flow when enabled, or another private channel listed by the repository owner.

This repository is a development sandbox. Paystack accepts test keys only and no fiat payout moves real money. QIE Mainnet is real: users can send native QIEV3 from wallets they link and control, and each Personal account is issued an app-managed (Privy) wallet address that cannot send yet, so the app does not display it for deposits. Rotate any credential posted in chat, an issue, a log or a commit. A sandbox is not suitable for custody or production financial services.

## Accepted dependency advisories

- **GHSA-mrhx-c7xc-m3w5** (zod memory exhaustion on oversized collections).
  Microsendr' own code uses zod 4.6.6 or later, which is fixed. The advisory
  remains only for zod 3, which Privy's browser SDK pulls in through
  `@base-org/account` and Reown/WalletConnect. No zod 3 release is patched,
  and forcing zod 4 onto those packages risks breaking them. Exposure is limited
  to the client-side Privy chunk, which only the legacy "restore a previous
  account" sign-in loads, and its effect is a slow tab, not data access. Remove
  the ignore in `package.json` (`pnpm.auditConfig`) once Privy ships with zod 4.
