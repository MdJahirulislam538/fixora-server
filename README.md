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
PORT=5000
FIXORA_SERVER_API_KEY="a-long-random-shared-secret"
```

Set `FIXORA_SERVER_API_KEY` to the same secret in the FIXORA Client deployment environment. The Next.js API verifies the user's Better Auth session and role, then forwards approved requests to this API using that secret. Do not expose the secret in a `NEXT_PUBLIC_` variable or commit it.

For online checkout, also configure:

```env
STRIPE_SECRET_KEY="your-stripe-secret-key"
```

If `MONGODB_URI` is not used, the server can also connect with `DB_USER` and `DB_PASSWORD` plus the optional `DB_HOSTS`, `DB_REPLICA_SET`, `DB_NAME`, `DB_SSL`, and `DB_AUTH_SOURCE` settings.

## Run locally

```bash
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default. Use `npm start` for a non-watch run. The server must be running for FIXORA Client's service, booking, and payment APIs to work.