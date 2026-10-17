import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { createApp } from "./server.js";

let directory;
let db;
let server;
let baseUrl;
const idempotencyKey = "test-checkout-key-0001";
const requestBody = {
  paymentMethod: "cod",
  customer: {
    name: "Test Customer",
    email: "customer@example.test",
    phone: "9876543210",
    addressLine1: "12 Test Street",
    addressLine2: "",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400001"
  },
  items: [{ id: 1, size: "8", qty: 1, price: 1 }]
};

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "fashionhub-test-"));
  const instance = createApp({ dbPath: path.join(directory, "test.sqlite") });
  db = instance.db;
  server = instance.app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("creates a persisted COD order using server-side prices", async () => {
  const response = await fetch(`${baseUrl}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(requestBody)
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.match(body.orderId, /^FH-/);
  assert.equal(body.total, 8995);
  assert.equal(body.paymentMethod, "cod");
  assert.equal(body.paymentStatus, "pending_collection");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(db.prepare("SELECT unit_price FROM order_items").get().unit_price, 8995);
});

test("returns the original order for a matching retry without duplicating it", async () => {
  const response = await fetch(`${baseUrl}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(requestBody)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.total, 8995);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
});

test("rejects an invalid product size without writing an order", async () => {
  const response = await fetch(`${baseUrl}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "invalid-item-key-001" },
    body: JSON.stringify({ ...requestBody, items: [{ id: 1, size: "XXL", qty: 1 }] })
  });
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
});

test("rejects reusing an idempotency key for a different order", async () => {
  const response = await fetch(`${baseUrl}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...requestBody, items: [{ id: 1, size: "8", qty: 2 }] })
  });
  assert.equal(response.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
});

test("rejects malformed quantities and overlong delivery fields", async () => {
  const requests = [
    { ...requestBody, items: [{ id: 1, size: "8", qty: "1" }] },
    { ...requestBody, customer: { ...requestBody.customer, pincode: "4000019" } }
  ];
  for (const [index, body] of requests.entries()) {
    const response = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `malformed-order-${index}` },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
});

test("serves searchable products and rejects unauthenticated private API access", async () => {
  const [productsResponse, filteredResponse, cartResponse, adminResponse, paymentResponse] = await Promise.all([
    fetch(`${baseUrl}/api/products/`),
    fetch(`${baseUrl}/api/products?q=nike&sort=price-asc`),
    fetch(`${baseUrl}/api/cart`),
    fetch(`${baseUrl}/api/admin/dashboard`),
    fetch(`${baseUrl}/api/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  ]);
  const products = await productsResponse.json();
  const filtered = await filteredResponse.json();
  assert.equal(products.pagination.total, 16);
  assert.equal(filtered.products.length, 3);
  assert.equal(filtered.products[0].brand, "Nike");
  assert.equal(cartResponse.status, 401);
  assert.equal(adminResponse.status, 401);
  assert.equal(paymentResponse.status, 503);
  assert.equal((await paymentResponse.json()).code, "PAYMENT_GATEWAY_NOT_CONFIGURED");
});

test("supports customer auth, persistent cart/wishlist, and order ownership", async () => {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Customer", email: "customer@example.test", password: "correct-horse-battery", role: "admin" })
  });
  assert.equal(register.status, 201);
  const account = await register.json();
  assert.equal(account.user.role, "customer");
  const cookie = register.headers.get("set-cookie").split(";")[0];
  const headers = { "Content-Type": "application/json", Cookie: cookie };

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal((await me.json()).user.email, "customer@example.test");
  const crossOriginMutation = await fetch(`${baseUrl}/api/wishlist`, {
    method: "POST",
    headers: { ...headers, Origin: "https://attacker.example" },
    body: JSON.stringify({ productId: 1 })
  });
  assert.equal(crossOriginMutation.status, 403);
  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Customer", email: "customer@example.test", password: "correct-horse-battery" })
  });
  assert.equal(duplicate.status, 409);

  const addCart = await fetch(`${baseUrl}/api/cart`, {
    method: "POST", headers, body: JSON.stringify({ productId: 1, size: "8", quantity: 2 })
  });
  assert.equal(addCart.status, 201);
  const cart = await fetch(`${baseUrl}/api/cart`, { headers });
  assert.equal((await cart.json()).items[0].quantity, 2);
  const patchCart = await fetch(`${baseUrl}/api/cart/1`, {
    method: "PATCH", headers, body: JSON.stringify({ size: "8", quantity: 1 })
  });
  assert.equal(patchCart.status, 200);

  const wish = await fetch(`${baseUrl}/api/wishlist`, {
    method: "POST", headers, body: JSON.stringify({ productId: 1 })
  });
  assert.equal(wish.status, 201);
  assert.equal((await (await fetch(`${baseUrl}/api/wishlist`, { headers })).json()).products.length, 1);
  assert.equal((await fetch(`${baseUrl}/api/wishlist/1`, { method: "DELETE", headers })).status, 204);
  assert.equal((await (await fetch(`${baseUrl}/api/wishlist`, { headers })).json()).products.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/cart/1?size=8`, { method: "DELETE", headers })).status, 204);
  assert.equal((await (await fetch(`${baseUrl}/api/cart`, { headers })).json()).items.length, 0);
  await fetch(`${baseUrl}/api/cart`, {
    method: "POST", headers, body: JSON.stringify({ productId: 1, size: "8", quantity: 1 })
  });

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "customer-order-key-0001" },
    body: JSON.stringify({
      paymentMethod: "cod",
      customer: { name: "Test Customer", phone: "9876543210", addressLine1: "12 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
      items: [{ id: 1, size: "8", qty: 1 }]
    })
  });
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.equal(order.paymentStatus, "pending_collection");
  assert.equal((await (await fetch(`${baseUrl}/api/cart`, { headers })).json()).items.length, 0);
  const retry = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "customer-order-key-0001" },
    body: JSON.stringify({
      paymentMethod: "cod",
      customer: { name: "Test Customer", phone: "9876543210", addressLine1: "12 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
      items: [{ id: 1, size: "8", qty: 1 }]
    })
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).orderId, order.orderId);
  const crossAccountRetry = await fetch(`${baseUrl}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "customer-order-key-0001" },
    body: JSON.stringify({
      paymentMethod: "cod",
      customer: { name: "Test Customer", email: "customer@example.test", phone: "9876543210", addressLine1: "12 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
      items: [{ id: 1, size: "8", qty: 1 }]
    })
  });
  assert.equal(crossAccountRetry.status, 409);
  assert.equal((await (await fetch(`${baseUrl}/api/orders/my-orders`, { headers })).json()).orders[0].id, order.orderId);
  assert.equal((await (await fetch(`${baseUrl}/api/orders/${order.orderId}`, { headers })).json()).order.id, order.orderId);
  assert.equal((await fetch(`${baseUrl}/api/admin/dashboard`, { headers })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/orders/${idempotencyKey}`, { headers })).status, 404);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "customer@example.test", password: "correct-horse-battery" })
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, "customer");

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers })).status, 401);
});

test("protects product management and order administration with the admin role", async () => {
  const customer = db.prepare("SELECT id FROM users WHERE email=?").get("customer@example.test");
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(customer.id);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "customer@example.test", password: "correct-horse-battery" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { "Content-Type": "application/json", Cookie: cookie };

  const created = await fetch(`${baseUrl}/api/products`, {
    method: "POST", headers,
    body: JSON.stringify({
      brand: "Test Brand", name: "Test Shoe", category: "Sneakers", description: "A sample product.",
      material: "Leather", price: 5000, oldPrice: 6000, rating: 4.5, reviews: 0,
      color: "Black", sizes: ["8", "9"], image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff",
      badge: "Test", inventory: 5
    })
  });
  assert.equal(created.status, 201);
  const product = (await created.json()).product;
  const updated = await fetch(`${baseUrl}/api/products/${product.id}`, {
    method: "PUT", headers, body: JSON.stringify({ price: 4500, oldPrice: 6000, inventory: 4 })
  });
  assert.equal((await updated.json()).product.price, 4500);

  const dashboard = await fetch(`${baseUrl}/api/admin/dashboard`, { headers });
  assert.equal(dashboard.status, 200);
  assert.ok((await dashboard.json()).orders.total >= 2);
  assert.equal((await fetch(`${baseUrl}/api/admin/orders`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/users`, { headers })).status, 200);

  const order = db.prepare("SELECT order_id FROM orders WHERE user_id=?").get(customer.id);
  const status = await fetch(`${baseUrl}/api/admin/orders/${order.order_id}/status`, {
    method: "PATCH", headers, body: JSON.stringify({ status: "processing" })
  });
  assert.equal((await status.json()).order.status, "processing");
  const cancelled = await fetch(`${baseUrl}/api/admin/orders/${order.order_id}/status`, {
    method: "PATCH", headers, body: JSON.stringify({ status: "cancelled" })
  });
  assert.equal((await cancelled.json()).order.status, "cancelled");
  const invalidTransition = await fetch(`${baseUrl}/api/admin/orders/${order.order_id}/status`, {
    method: "PATCH", headers, body: JSON.stringify({ status: "processing" })
  });
  assert.equal(invalidTransition.status, 409);

  const removed = await fetch(`${baseUrl}/api/products/${product.id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${baseUrl}/api/products/${product.id}`)).status, 404);
});

test("bootstraps an admin account from environment configuration", async () => {
  const oldEmail = process.env.FASHIONHUB_ADMIN_EMAIL;
  const oldPassword = process.env.FASHIONHUB_ADMIN_PASSWORD;
  const adminDirectory = await mkdtemp(path.join(os.tmpdir(), "fashionhub-admin-test-"));
  let adminDb;
  let adminServer;
  try {
    process.env.FASHIONHUB_ADMIN_EMAIL = "bootstrap-admin@example.test";
    process.env.FASHIONHUB_ADMIN_PASSWORD = "long-bootstrap-secret-2026";
    const instance = createApp({ dbPath: path.join(adminDirectory, "admin.sqlite") });
    adminDb = instance.db;
    adminServer = instance.app.listen(0);
    await new Promise(resolve => adminServer.once("listening", resolve));
    const base = `http://127.0.0.1:${adminServer.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bootstrap-admin@example.test", password: "long-bootstrap-secret-2026" })
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.role, "admin");
  } finally {
    if (oldEmail === undefined) delete process.env.FASHIONHUB_ADMIN_EMAIL;
    else process.env.FASHIONHUB_ADMIN_EMAIL = oldEmail;
    if (oldPassword === undefined) delete process.env.FASHIONHUB_ADMIN_PASSWORD;
    else process.env.FASHIONHUB_ADMIN_PASSWORD = oldPassword;
    if (adminServer) await new Promise(resolve => adminServer.close(resolve));
    if (adminDb) adminDb.close();
    await rm(adminDirectory, { recursive: true, force: true });
  }
});

test("migrates existing COD orders without losing their line items", async () => {
  const legacyDirectory=await mkdtemp(path.join(os.tmpdir(),"fashionhub-migration-test-"));
  const legacyPath=path.join(legacyDirectory,"legacy.sqlite");
  const legacyDb=new DatabaseSync(legacyPath);
  legacyDb.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
      customer_name TEXT NOT NULL,customer_email TEXT NOT NULL,customer_phone TEXT NOT NULL,
      address_line_1 TEXT NOT NULL,address_line_2 TEXT NOT NULL,city TEXT NOT NULL,state TEXT NOT NULL,
      pincode TEXT NOT NULL,total INTEGER NOT NULL CHECK (total > 0),
      payment_method TEXT NOT NULL CHECK (payment_method = 'cod'),
      payment_status TEXT NOT NULL CHECK (payment_status = 'pending_collection'),
      order_status TEXT NOT NULL CHECK (order_status = 'confirmed'),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL,product_name TEXT NOT NULL,size TEXT NOT NULL,
      unit_price INTEGER NOT NULL CHECK (unit_price > 0),quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (order_id,product_id,size)
    );
    INSERT INTO orders VALUES (
      'FH-LEGACY-001','legacy-idempotency-key','legacy-hash','Legacy Customer',
      'legacy@example.test','9876543210','12 Legacy Street','','Mumbai','Maharashtra',
      '400001',8995,'cod','pending_collection','confirmed','2025-01-01 00:00:00'
    );
    INSERT INTO order_items VALUES ('FH-LEGACY-001',1,'Air Force 1 ''07','8',8995,1);
  `);
  legacyDb.close();
  const instance=createApp({dbPath:legacyPath});
  try {
    const migrated=instance.db.prepare(`
      SELECT orders.user_id,orders.order_status,order_items.product_name
      FROM orders JOIN order_items USING(order_id) WHERE order_id='FH-LEGACY-001'
    `).get();
    assert.equal(migrated.user_id,null);
    assert.equal(migrated.order_status,"confirmed");
    assert.equal(migrated.product_name,"Air Force 1 '07");
    instance.db.prepare("UPDATE orders SET order_status='processing' WHERE order_id=?").run("FH-LEGACY-001");
    assert.equal(instance.db.prepare("PRAGMA foreign_key_check").all().length,0);
  } finally {
    instance.db.close();
    await rm(legacyDirectory,{recursive:true,force:true});
  }
});
