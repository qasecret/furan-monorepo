# Security Policy

We take security seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/qasecret/furan-monorepo/security/advisories/new)**
(the repository's **Security** tab → **Report a vulnerability**).

The report is visible only to the maintainers. Include a description,
reproduction steps, the affected version (app image tag and/or SDK version),
and the impact you observed.

We aim to acknowledge within **72 hours** and to ship a fix or mitigation
within **90 days** of acknowledgement. Coordinated disclosure preferred — we'll
agree a disclosure date with you and credit you in the advisory unless you'd
rather stay anonymous.

## Supported versions

| Component                                 | Supported with security fixes |
| ----------------------------------------- | ----------------------------- |
| App images (`qasecret/furan-*`)           | latest `v1.1.x` release       |
| Kotlin SDK (`io.github.qasecret:furan-*`) | latest `4.x` release          |

Fixes ship in a new release; older releases are fixed by upgrading.

## In scope

- Source in this monorepo
- Container images published from this monorepo
- Dependencies bundled in the published images

## Out of scope

- Vulnerabilities requiring physical access to the host machine
- Self-inflicted misconfiguration (`.env` not protected, no TLS, etc.)
- DoS attacks; bugs only reproducible against vendored third-party services

## Safe harbor

Good-faith research is welcomed. We will not pursue legal action against
researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption.
- Give us a reasonable time to investigate and respond before publishing.
- Do not exploit the issue beyond what is necessary to demonstrate it.
