# CrowdSpark — Server

Backend / API for **CrowdSpark**, a crowdfunding platform where Creators launch campaigns, Supporters contribute credits, and Admins keep the platform running smoothly.

## Tech Stack
- Node.js + Express
- MongoDB (native driver)
- JWT (jsonwebtoken) for route protection
- Stripe for credit-purchase payments
- Role-based middleware (Supporter / Creator / Admin)

## Getting Started

```bash
npm install
cp .env.example .env   # then fill in your real values
npm run dev
```

## Environment Variables
See `.env.example`. You need:
- `DB_USER`, `DB_PASS`, `DB_NAME` — MongoDB Atlas credentials
- `ACCESS_TOKEN_SECRET` — any long random string for signing JWTs
- `STRIPE_SECRET_KEY` — from your Stripe dashboard
- `CLIENT_URL` — your deployed client URL, for CORS

## Deployment (Vercel)
1. Push this repo to GitHub.
2. Import it into Vercel.
3. Add all the environment variables above in Vercel → Project → Settings → Environment Variables — for **both** Production and Preview.
4. Deploy. `vercel.json` is already configured to route everything through `index.js`.

> **Common trap:** Vercel only knows the environment variables you add in its dashboard — it never reads your local `.env` file. If `DB_NAME` isn't set there, MongoDB will silently connect to a default/empty database and your data will look like it "disappeared." Double-check every variable from `.env.example` is present in Vercel before troubleshooting anything else.

> Also update the `origin` array in `index.js`'s `cors()` call (and the `CLIENT_URL` env var) once your client is deployed, or the browser will block requests with a CORS error.

## Main Route Groups
| Group | Examples |
|---|---|
| Auth | `POST /jwt` |
| Users | `POST /users`, `GET /users`, `PATCH /users/role/:id`, `DELETE /users/:id` |
| Campaigns | `POST /campaigns`, `GET /campaigns`, `PATCH /campaigns/status/:id`, `DELETE /campaigns/:id` |
| Contributions | `POST /contributions`, `PATCH /contributions/status/:id`, `GET /contributions/supporter/:email` |
| Withdrawals | `POST /withdrawals`, `PATCH /withdrawals/approve/:id` |
| Payments | `POST /create-payment-intent`, `POST /payments` |
| Notifications | `GET /notifications/:email` |
| Reports | `POST /reports`, `PATCH /reports/suspend/:id` |
