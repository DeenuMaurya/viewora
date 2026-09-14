# Viewora - Phase 0

Auth + upload + shareable 3D walkthrough platform (learning project).

## Folder structure

```
backend/
  server.js          Express app entry point
  routes/            API routes
  middleware/        Auth middleware
  db.js              SQLite setup
  data/              Local SQLite database files
  uploads/           Uploaded .glb model files

frontend/
  public/            Static HTML, CSS, and browser JS
```

## Setup

Use Node.js 22 or later.

```
npm install
```

Copy `backend/.env.example` to `backend/.env`, then replace `JWT_SECRET` with
a real random value. Run `openssl rand -hex 32` to generate one. The server
will not start until the secret is at least 32 characters and is not a
placeholder. Never commit `backend/.env`.

`backend/data/`, `backend/uploads/`, and `node_modules/` are local runtime
state and are deliberately ignored by Git.

## Run

```
npm start
```

Then open http://localhost:3000

## What's here (Phase 0 scope)

- Email/password signup + login (bcrypt + JWT in an httpOnly cookie)
- Upload a validated, self-contained GLB 2.0 model (disk storage, size cap)
- Dashboard: list your projects, delete them
- Public shareable link per project (/view/:token) - no login needed to view
- Room editor (owner-only): click a floor point, name it, saves to the database
- Ownership checks on every write - one user can't edit/delete another's project
- Owner-only editor project loading, so the project ID cannot be mixed with a public share token
- Login and upload rate limits plus per-account project/storage quotas
- Project rename and share-link regeneration
- Server-side project search, visibility filtering, and newest/oldest/name sorting
- Optional protected dashboard cover images (PNG, JPG, or WebP), including replace/remove controls
- Protected model delivery: private models require the owner session and public models require a valid share link

## What's deliberately NOT here yet

- Model compression (Draco/KTX2) - large GLBs will load slowly, this is a
  known follow-up, not an oversight
- Cloud file storage (S3/R2) - files sit on local disk in backend/uploads, fine
  for learning/single-server use, not fine at real scale
- Password reset flow
- Distributed rate limiting / quotas - the included in-memory limits are for a
  single server; use Redis or equivalent when running multiple app instances

## Deploying this for real

This only runs on your own machine right now. To make it actually reachable on
the internet you'd deploy it to something like Railway, Render, or a VPS, point
a domain at it, and move file storage to S3/R2 instead of local disk. Local disk
storage is lost/inconsistent across container restarts and doesn't scale across
multiple server instances.
