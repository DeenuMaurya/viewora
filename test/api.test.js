const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "viewora-api-test-"));
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-secret-that-is-longer-than-thirty-two-characters";
process.env.DATABASE_PATH = path.join(tempRoot, "app.db");
process.env.UPLOAD_DIR = path.join(tempRoot, "uploads");

const app = require("../backend/server");
const db = require("../backend/db");
let server;
let baseUrl;
let cookie = "";

function getCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : "";
}

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
  return { response, data: await response.json() };
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("authentication, upload, rooms, project details, and deletion", async () => {
  let result = await request("/api/projects");
  assert.equal(result.response.status, 401);

  result = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Test User",
      email: "test@example.com",
      mobile: "9876543210",
      password: "correct-horse-battery-staple"
    })
  });
  assert.equal(result.response.status, 200);
  cookie = getCookie(result.response);
  assert.match(cookie, /^token=/);

  result = await request("/api/auth/me");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.email, "test@example.com");

  const invalidLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com", password: "not-the-password" })
  });
  assert.equal(invalidLogin.response.status, 401);

  const glb = Buffer.alloc(12);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(12, 8);
  const form = new FormData();
  form.append("name", "Test walkthrough");
  form.append("model", new Blob([glb], { type: "model/gltf-binary" }), "test.glb");
  result = await request("/api/projects", { method: "POST", body: form });
  assert.equal(result.response.status, 200);
  const projectId = result.data.id;

  result = await request(`/api/projects/${projectId}/rooms`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rooms: [{ label: "Entry", x: 1, y: 0, z: 2 }], start: null })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.count, 1);

  result = await request(`/api/projects/${projectId}/details`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.roomCount, 1);
  assert.equal(result.data.modelSizeBytes, 12);

  result = await request(`/api/projects/${projectId}`, { method: "DELETE" });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.cleanup.model, "removed");

  result = await request("/api/projects");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.length, 0);
});
