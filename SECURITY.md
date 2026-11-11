# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security vulnerability. Report it privately through GitHub's private vulnerability reporting on this repository (Security tab > Report a vulnerability), or contact the maintainer through GitHub.

Include a description of the issue, steps to reproduce it, and the impact if known. We will confirm receipt, investigate, and fix verified issues before disclosing them publicly.

## Scope

This policy covers the code in this repository, including the scraper, renderer, tests, and GitHub Actions workflows. It does not cover the live site's hosting providers.

## Secrets

This repository must never contain real secrets, API keys, or credentials. If you find one committed by mistake, report it privately as above so it can be rotated and removed from history.
