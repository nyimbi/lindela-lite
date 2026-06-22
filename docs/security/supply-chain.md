# Supply Chain Security

This document describes the supply chain security controls for Lindela Lite, including how artifacts are produced, verified, and signed.

## Software Bill of Materials (SBOM)

A CycloneDX SBOM is generated for each release via the CI/CD pipeline:

- Format: CycloneDX JSON (software-bill-of-materials.cdx.json)
- Generation: Automated on every release tag via `npx @cyclonedx/cyclonedx-npm`
- Location: Attached to GitHub release as an artifact

To verify dependencies:

```bash
npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json
```

## Provenance and Attestation

Release provenance is generated using the SLSA Framework:

- Generator: slsa-github-generator v1.10.0
- Attestation: SLSA Provenance (level 3)
- Scope: Covers all published artifacts for a release

### Verification

To verify a release's provenance:

```bash
gh release view v0.1.0 --json assets
```

### Image Signing

Note: Image signing via cosign is not currently implemented but is reserved for future releases.

## Build Integrity

The CI pipeline ensures build integrity via:

1. Automated testing on all pushes and PRs
2. SBOM generation capturing all transitive dependencies
3. Provenance attestation linking artifacts to source commits
4. GitHub release signing with repository key

## Dependencies

Lindela Lite is intentionally minimal with zero npm dependencies (besides Node.js built-ins and the `pg` driver). This simplifies supply chain risk and reduces attack surface.

To audit the current dependency tree:

```bash
npm ls
```

## Disclosure

Security vulnerabilities should be reported to the maintainers privately before public disclosure. Please contact nyimbi@gmail.com with details.
