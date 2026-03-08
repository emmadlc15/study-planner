# Study Planner
A full-stack study planner with coursework tracking, calendar views, session logging, and priority recommendations.

## Is a public GitHub repo enough?
No. This app needs a running Node.js server and a PostgreSQL database, so visitors cannot use it directly from GitHub source alone.

For your portfolio, link to:
- a live deployed URL (for users to try it), and
- your GitHub repo (for code review).

## Stack
- Backend: Node.js + Express
- Database: PostgreSQL
- Frontend: HTML/CSS/JS served by Express

## Local setup
1. Install dependencies:
```bash
npm install
```
2. Create env file:
```bash
cp .env.example .env
```
3. Fill in your Postgres values in `.env`.
4. Create database schema:
```bash
psql -U <postgres-user> -d study_planner -f db/schema.sql
```
5. Start app:
```bash
npm start
```
6. Open:
- [http://localhost:3000](http://localhost:3000)

## Environment variables
Use either `DATABASE_URL` (recommended for deployment) or individual `DB_*` values.

- `DATABASE_URL` (example: `postgres://user:password@host:5432/database`)
- `DB_SSL` (`true` for most managed Postgres providers)
- `DB_USER`
- `DB_PASSWORD`
- `DB_HOST`
- `DB_NAME`
- `DB_PORT`
- `PORT` (optional, defaults to `3000`)

## Deploy for portfolio (quick path)
Use a platform that supports Node + Postgres (Render, Railway, Fly.io, etc.).

This repo includes a `render.yaml` blueprint for Render.

Typical setup:
1. Create a managed Postgres database.
2. Create a web service from this repo.
3. Set start command to:
```bash
npm start
```
4. Set env vars:
- `DATABASE_URL` from provider
- `DB_SSL=true`
- (optional) `NODE_ENV=production`
5. Run schema once against production database:
```bash
psql "<DATABASE_URL>" -f db/schema.sql
```
6. Add the deployed URL to your portfolio.

## Security note before publishing
Your local `.env` currently contains real credentials. Even after adding `.gitignore`, if `.env` was ever committed, rotate the DB password and remove `.env` from Git tracking:
```bash
git rm --cached .env
```
Then commit the cleanup and keep only `.env.example` in the repo.
