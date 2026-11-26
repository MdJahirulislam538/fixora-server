# FIXORA Server

The Express API for FIXORA service listings, bookings, technician job requests, dashboard summaries, and payments. Booking and service data use the same MongoDB database as FIXORA Client; the Express server is the API owner for these records.

## Requirements

- Node.js 20.9 or later
- npm
- MongoDB access to the FIXORA database

## Configuration

Create `fixora-server/.env` with:

```env
MONGODB_URI="your-mongodb-connection-string"
MONGODB_DATABASE="fixoraClientDb"
PORT=8000
FIXORA_SERVER_API_KEY="a-long-random-shared-secret"
```

Set `FIXORA_SERVER_API_KEY` to the same secret in the FIXORA Client deployment environment. The Next.js API verifies the user's Better Auth session and role, then forwards approved requests to this API using that secret. Do not expose the secret in a `NEXT_PUBLIC_` variable or commit it.

For online checkout, also configure:

```env
STRIPE_SECRET_KEY="your-stripe-secret-key"
```

If `MONGODB_URI` is not used, the server can also connect with `DB_USER` and `DB_PASSWORD` plus the optional `DB_HOSTS`, `DB_REPLICA_SET`, `DB_NAME`, `DB_SSL`, and `DB_AUTH_SOURCE` settings.

## Vercel deployment

Configure these variables in the **fixora-server** Vercel project:

- `MONGODB_URI` (or `DB_USER` and `DB_PASSWORD`)
- `MONGODB_DATABASE=fixoraClientDb`
- `FIXORA_SERVER_API_KEY`
- `STRIPE_SECRET_KEY` if online checkout is enabled

Configure these variables in the **fixora-client** Vercel project:

- `NEXT_PUBLIC_API_URL=https://fixora-server-coral.vercel.app`
- `FIXORA_SERVER_API_KEY` — use the exact same secret as the server project
- `MONGODB_URI` and `MONGODB_DATABASE=fixoraClientDb` for Better Auth and client-owned profile/user data
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL` set to the client project's public URL

Add the variables to the Production environment (and Preview if used), then redeploy both projects. `NEXT_PUBLIC_API_URL` is used by the client deployment; `FIXORA_SERVER_API_KEY` must stay server-side and must never use a `NEXT_PUBLIC_` prefix.

## Run locally

```bash
npm install
npm run dev
```

The API listens on `http://localhost:8000` by default. Use `npm start` for a non-watch run. The server must be running for FIXORA Client's service, booking, and payment APIs to work.