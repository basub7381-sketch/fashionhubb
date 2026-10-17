# FashionHub — Clothes & Shoes Brands

FashionHub is a responsive React/Vite fashion storefront backed by an Express API and SQLite. The recommended application is in `cindrela/client` and `cindrela/server`; the original root storefront and server remain for compatibility.

## Requirements

- Windows 10/11 with PowerShell
- Node.js 22.13 or newer (includes the built-in `node:sqlite` module)
- npm (included with Node.js)

Check versions from the repository root:

```powershell
node --version
npm --version
```

## Install and configure

Run these commands in PowerShell from the repository root:

```powershell
npm install --prefix .\cindrela\server
npm install --prefix .\cindrela\client
Copy-Item .\cindrela\server\.env.example .\cindrela\server\.env
notepad .\cindrela\server\.env
```

Set `FASHIONHUB_ADMIN_EMAIL` and `FASHIONHUB_ADMIN_PASSWORD` in the server `.env` before launching it to bootstrap an admin account. Use a unique password of at least 16 characters. There are no built-in admin credentials; public registration creates customer accounts only. Never commit `.env` files, credentials, API keys, or database files. `.gitignore` excludes environment and SQLite files.

The client defaults to same-origin `/api` and needs no environment file for standard local development. Templates are provided in [the client environment example](./cindrela/client/.env.example) and [the server environment example](./cindrela/server/.env.example).

For a one-off PowerShell session instead of storing bootstrap credentials in `.env`, enter the password without placing it in command history:

```powershell
$env:FASHIONHUB_ADMIN_EMAIL = Read-Host "Administrator email"
$securePassword = Read-Host "Administrator password (16+ characters)" -AsSecureString
$env:FASHIONHUB_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password
```

The values apply to processes launched from that PowerShell window. Clear them when finished:

```powershell
Remove-Item Env:FASHIONHUB_ADMIN_EMAIL -ErrorAction SilentlyContinue
Remove-Item Env:FASHIONHUB_ADMIN_PASSWORD -ErrorAction SilentlyContinue
```

## Database and sample products

On first server startup, FashionHub creates the SQLite schema and seeds 16 sample products. The default Windows database is `%LOCALAPPDATA%\FashionHub\fashionhub.sqlite`; product images are stored beside it under `%LOCALAPPDATA%\FashionHub\uploads`. Set `FASHIONHUB_DATA_DIR` to change the data directory or `DB_PATH` to select a specific database file. Keep both database and uploads on persistent storage and back them up together.

Check/initialize the database and show the active catalog count:

```powershell
npm run seed --prefix .\cindrela\server
```

This is safe to rerun; it does not reset or erase customer or order data.

## Start for development

Open two PowerShell terminals at the repository root.

Terminal 1 — API server:

```powershell
npm run dev --prefix .\cindrela\server
```

Terminal 2 — React/Vite client:

```powershell
npm run dev --prefix .\cindrela\client
```

Visit <http://localhost:5173>. Vite proxies `/api` and `/uploads` to the API server on port 3000. Check the API:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/products
```

If the API uses another port, set the Vite proxy target before starting the client:

```powershell
$env:API_PROXY_TARGET = "http://localhost:3001"
npm run dev --prefix .\cindrela\client
```

## Production build and startup

```powershell
npm run build --prefix .\cindrela\client
npm start --prefix .\cindrela\server
```

The API serves the built frontend from `cindrela/client/dist`. For production, set `NODE_ENV=production`, use TLS, store admin credentials in a secret manager, and configure `CLIENT_ORIGINS` with exact trusted origins when hosting the client separately. Set `TRUST_PROXY=true` only behind a trusted proxy that overwrites forwarded IP headers. Keep the SQLite file and images on persistent, access-controlled storage.

## Security and file uploads

- Helmet security headers with a restrictive Content Security Policy.
- Per-IP limits per 15 minutes: API 300 requests, authentication 20, admin 60, and payments 10. Configure trusted proxies correctly so limits use the real client address.
- Same-origin browser access is supported. Cross-origin requests are denied unless their exact origin is listed in comma-separated `CLIENT_ORIGINS`; development allows Vite's `localhost:5173` and `127.0.0.1:5173`.
- JSON request bodies are limited to 32 KiB. API fields are validated and trimmed; database operations use parameterized SQLite statements and schema constraints.
- Admin uploads accept one JPEG, PNG, or WebP image up to 5 MiB. MIME types and file signatures are checked, filenames are randomly generated, and files are stored outside the static client directory. SVG and other active document formats are rejected. Product HTTPS image URLs are also supported.
- Sessions use HttpOnly, SameSite=Lax cookies and Secure cookies in production. Passwords are stored using scrypt. Admin credentials are configured through environment variables, never hardcoded in application source.
- Online payment verification is disabled until a real provider is configured. `/api/payments/verify` returns `503 PAYMENT_GATEWAY_NOT_CONFIGURED`; a COD order records an order, not a successful payment.

## API overview

All endpoints use `/api`. Protected routes use the HttpOnly session cookie set by registration/login. Public registration cannot create admin accounts.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Public or signed in | Account and session management |
| `GET /api/products`, `GET /api/products/:id` | Public | Search, filter, sort, paginate, and view catalog |
| `POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id` | Admin | Product management |
| `POST /api/admin/uploads/images` | Admin | Validated multipart image upload; field name `image` |
| `GET/POST/PATCH/DELETE /api/cart` | Signed in | Server-synchronized shopping cart |
| `GET/POST/DELETE /api/wishlist` | Signed in | Saved products |
| `POST /api/orders`, `GET /api/orders/my-orders`, `GET /api/orders/:id` | Signed in | COD ordering and history |
| `POST /api/payments/create-order` | Public checkout | Idempotent COD order creation; requires `Idempotency-Key` |
| `POST /api/payments/verify` | Disabled | Returns 503 until a real payment provider is configured |
| `GET /api/admin/dashboard`, `GET /api/admin/orders`, `GET /api/admin/users`, `PATCH /api/admin/orders/:id/status` | Admin | Store operations |
| `GET /api/health` | Public | Health check |

Checkout validates stock, sizes, and delivery fields and computes prices on the server. COD order responses have `paymentStatus: "pending_collection"`; that does not mean funds were collected. A matching idempotent retry returns the original order.

## Verify

Run from the repository root:

```powershell
npm test --prefix .\cindrela\server
npm test
npm run build --prefix .\cindrela\client
```

The client and server have separate `package.json` files and lockfiles. See [the server README](./cindrela/server/README.md) for backend-specific notes.

## Troubleshooting

**`node:sqlite` is unavailable:** Install Node.js 22.13 or newer, reopen PowerShell, then verify `node --version`.

**Port 3000 or 5173 is busy:** Inspect listeners first:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
```

Stop the relevant development server in its terminal with `Ctrl+C`, or configure a different API `PORT` and matching `API_PROXY_TARGET`.

**Admin sign-in fails:** Check the server `.env` for a valid email and unique password of at least 16 characters. Restart the server after changing bootstrap configuration, then sign out and in to refresh the session.

**CORS errors:** Use <http://localhost:5173> in development. For a separately hosted client, add its exact scheme, host, and port to `CLIENT_ORIGINS` and restart the API. Do not use a wildcard for credentialed requests.

**Database or image writes fail:** Ensure the current Windows user can write to `%LOCALAPPDATA%\FashionHub`, or set `FASHIONHUB_DATA_DIR`/`DB_PATH` to a writable location.

**An image upload is rejected:** Use an actual JPEG, PNG, or WebP no larger than 5 MiB. Renaming a different file does not pass server signature checks; SVG is deliberately unsupported.

**Production frontend changes do not appear:** Rebuild the client bundle, then restart the server:

```powershell
npm run build --prefix .\cindrela\client
```

**Dependencies need reinstalling:** From the repository root, run `npm install --prefix .\cindrela\server` and `npm install --prefix .\cindrela\client`. Check the npm error output and supported Node.js version if installation fails.
