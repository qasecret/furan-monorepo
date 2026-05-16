# Security Policy

We take security seriously and appreciate responsible disclosure.

## Reporting a Vulnerability

Email **security@furan.dev** with a description, reproduction steps, and impact.
GPG-encrypt the body using the key below for anything sensitive.

- GPG fingerprint: `BC9C7F950A0446E7BC5C97133858ABC603091FB6`
- Public key available on keys.openpgp.org and reproduced at the bottom of this file

We aim to acknowledge within **72 hours** and to ship a fix or mitigation
within **90 days** of acknowledgement. Coordinated disclosure preferred.

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

## Public key (ASCII-armored)

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEagfkNBYJKwYBBAHaRw8BAQdAjKptpl1YePg5a+bcqtJ7U3GxZ8BpiUFCAyAR
LdvaYVi0I0Z1cmFuIFNlY3VyaXR5IDxzZWN1cml0eUBmdXJhbi5kZXY+iJkEExYK
AEEWIQS8nH+VCgRG57xclxM4WKvGAwkftgUCagfkNAIbIwUJA8JnAAULCQgHAgIi
AgYVCgkICwIEFgIDAQIeBwIXgAAKCRA4WKvGAwkftg9pAQCdvxHMLJz0Wn4+EGQS
SnSE32/eB8vkAsFUz3EcGxxO+AD+IBEb4TSe/Md4qvuZQXhKMVHTAs8Dwlz8D6/K
ucwuywa4OARqB+Q0EgorBgEEAZdVAQUBAQdAgGOvIE0lXwgIt8mICHQ6DPEDDXwm
hgB6RexYpvhzQhMDAQgHiH4EGBYKACYWIQS8nH+VCgRG57xclxM4WKvGAwkftgUC
agfkNAIbDAUJA8JnAAAKCRA4WKvGAwkfttjNAP9FOVWNic1RhJPf2mbwuBB3an81
eXuLaq+E0K2N6Sc2pQD/eX3dQmsuQ7kBKF63GcR+edEFwbw/yBs2d7mtoE/TfAo=
=2qcl
-----END PGP PUBLIC KEY BLOCK-----
```
