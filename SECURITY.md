# Security policy

## Supported versions

Security fixes are provided for the latest 0.1.x release. Pre-release builds and older 0.1.x versions may be used to reproduce a report but are not maintained separately.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `anirudh/parallelplay`. Do not open a public issue for suspected credential exposure, containment escape, authority bypass, receipt forgery, cross-site request forgery, or arbitrary external effects.

Include the affected commit or artifact digest, supported platform, minimal reproduction, observed authority/effect, and whether any credential or external system may have been touched. Do not include real secrets. You should receive acknowledgement within five business days.

Maintainers will coordinate validation, remediation, disclosure timing, CVE/GHSA handling when appropriate, and a release. Good-faith research that avoids privacy violations, service disruption, persistence, and unnecessary data access is welcome.

## Release security

Consumers should verify `SHA256SUMS`, the relevant SBOM and license inventory, and the GitHub artifact attestation before running an archive. Compatibility approval is not a security certification.
