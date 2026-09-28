# Security Policy

EarnProof backend code handles wallet authentication, payment indexing, credential signing, and public verification. Please report vulnerabilities privately before opening a public issue.

## Reporting a Vulnerability

Email the maintainers at `security@veridatum.dev` with:

- affected repository and commit;
- vulnerability description;
- reproduction steps;
- expected impact;
- suggested remediation, if known.

Do not include private keys, seed phrases, real salary data, or private payment records in reports.

## Responding to an Incident

Reporting a vulnerability is the path above. Responding to one — a compromised
credential, an abusive client, a data exposure, an anchoring failure, or a
dependency outage — is documented in
[docs/incidents/README.md](docs/incidents/README.md), which defines severity,
roles, evidence handling, and safe escalation.

## Supported Scope

The current project targets Stellar testnet only. Mainnet deployments, production financial decisions, and regulated identity verification are out of scope until explicitly documented.

