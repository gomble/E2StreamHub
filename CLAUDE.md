# E2StreamHub — Claude Code Instructions

## Versioning

Bei **jedem Commit** muss die Versionsnummer in `package.json` hochgezählt werden (Patch-Level, z.B. `0.2.0` → `0.2.1`). Bei neuen Features wird die Minor-Version erhöht (z.B. `0.2.1` → `0.3.0`).

Nach dem Push muss immer ein **Git-Tag** erstellt und gepusht werden (`git tag vX.Y.Z && git push origin vX.Y.Z`). Das triggert den Docker-Hub-Build mit dem Versions-Tag.

## Git

- Commits als `gomble <gomble@users.noreply.github.com>`
- Kein `Co-Authored-By` in Commit-Messages
