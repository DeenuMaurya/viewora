# Viewora Improvement Status

This document tracks the original Sheetwalk roadmap after the Viewora rebrand.

## Completed in the repository

- Security: ignored secrets/runtime files, startup secret validation, auth and upload rate limits, per-user project/storage limits, and GLB magic-byte validation.
- Uploads: self-contained GLB 2.0 uploads, client-side size checks, real upload progress, useful validation errors, validated PNG/JPG/WebP cover images, and quota-aware thumbnail storage.
- Project management: rename, search, visibility filtering/sorting, token regeneration, owner-only editor/model access, project metrics (size/date/views/room count), and deletion cleanup reporting.
- Viewer/editor UX: real model loading progress, failure messages, mobile control help, room reorder, full view rotation cloning, Ctrl/Cmd+S, undo/redo, autosave, and navigation-away warnings.
- Reliability: configurable database/upload paths, WAL SQLite, schema migration records, database backup command, structured JSON request/error logs with request IDs, and pinned Babylon.js assets.
- Quality: Node test coverage for registration, authentication, upload, room saving, details, and deletion; ESLint; Prettier; and GitHub Actions CI.

## Production activation required

The following need deployment-account values and cannot be safely enabled without them:

- Object storage/CDN: set up an S3-compatible R2/S3 bucket, private credentials, an HTTPS custom domain, and lifecycle/backup retention policy. The app currently keeps uploads on the configured local `UPLOAD_DIR` to preserve existing data and access controls.
- Error monitoring: connect the structured request/error logs to your preferred provider (for example, CloudWatch, Datadog, or Sentry) and configure alert recipients.

## Operational commands

```bash
npm test
npm run lint
npm run format:check
npm run backup
```

For scheduled backups, run `npm run backup` daily using your host's scheduler and set `BACKUP_DIR` to a protected, backed-up location.

## 3D model optimisation

Viewora accepts already-compressed GLB 2.0 models. For production uploads, use Draco mesh compression and KTX2/Basis texture compression in your 3D export pipeline before upload; this keeps server upload handling safe and avoids modifying an artist's source model unexpectedly.
