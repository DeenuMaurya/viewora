# Sheetwalk - Phase 0

Auth + upload + shareable 3D walkthrough platform (learning project).

## Folder structure

```
backend/
  server.js          Express app entry point
  routes/            API routes
  middleware/        Auth middleware
  db.js              SQLite setup
  data/              Local SQLite database files
  uploads/           Uploaded .glb/.gltf model files

frontend/
  public/            Static HTML, CSS, and browser JS
```

## Setup

```
npm install
```

Create your own `backend/.env` and replace `JWT_SECRET` with a real random
value. Run `openssl rand -hex 32` to generate one. Never deploy with the
placeholder secret checked into this file.

## Run

```
npm start
```

Then open http://localhost:3000

## What's here (Phase 0 scope)

- Email/password signup + login (bcrypt + JWT in an httpOnly cookie)
- Upload a .glb/.gltf model (disk storage, validated extension + size cap)
- Dashboard: list your projects, delete them
- Public shareable link per project (/view/:token) - no login needed to view
- Room editor (owner-only): click a floor point, name it, saves to the database
- Ownership checks on every write - one user can't edit/delete another's project

## What's deliberately NOT here yet

- Model compression (Draco/KTX2) - large GLBs will load slowly, this is a
  known follow-up, not an oversight
- Cloud file storage (S3/R2) - files sit on local disk in backend/uploads, fine
  for learning/single-server use, not fine at real scale
- Password reset flow
- Rate limiting / upload quotas - a single account could currently upload
  unlimited files up to the 300MB per-file cap; add this before any public
  deployment
- Project renaming, thumbnails, search

## Deploying this for real

This only runs on your own machine right now. To make it actually reachable on
the internet you'd deploy it to something like Railway, Render, or a VPS, point
a domain at it, and move file storage to S3/R2 instead of local disk. Local disk
storage is lost/inconsistent across container restarts and doesn't scale across
multiple server instances.
