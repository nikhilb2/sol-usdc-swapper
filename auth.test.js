// auth.test.js — Dashboard credential checks
// Run: node auth.test.js

process.env.DASHBOARD_USER = "admin";
process.env.DASHBOARD_PASSWORD = "correct-horse-battery";

const { isAuthorized, safeEqual, assertConfigured } = await import("./auth.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

test("Accepts the configured credentials", () => {
  assert(isAuthorized(basic("admin", "correct-horse-battery")), "should accept");
});

test("Rejects a wrong password", () => {
  assert(!isAuthorized(basic("admin", "wrong")), "should reject");
});

test("Rejects a wrong username", () => {
  assert(!isAuthorized(basic("root", "correct-horse-battery")), "should reject");
});

test("Rejects a missing header", () => {
  assert(!isAuthorized(undefined), "undefined");
  assert(!isAuthorized(""), "empty");
});

test("Rejects a non-Basic scheme", () => {
  assert(!isAuthorized("Bearer correct-horse-battery"), "bearer");
  assert(!isAuthorized("Basiccorrect"), "malformed prefix");
});

test("Rejects malformed base64 and missing colon", () => {
  assert(!isAuthorized("Basic !!!!not-base64!!!!"), "garbage");
  assert(!isAuthorized("Basic " + Buffer.from("nocolon").toString("base64")), "no colon");
});

test("A password containing a colon still works", () => {
  process.env.DASHBOARD_PASSWORD = "pa:ss:word:1234";
  assert(isAuthorized(basic("admin", "pa:ss:word:1234")), "splits on the FIRST colon only");
  process.env.DASHBOARD_PASSWORD = "correct-horse-battery";
});

test("An empty configured password never authorizes", () => {
  process.env.DASHBOARD_PASSWORD = "";
  assert(!isAuthorized(basic("admin", "")), "empty password must not be a valid credential");
  assert(!isAuthorized("Basic " + Buffer.from("admin:").toString("base64")), "nor an empty supplied one");
  process.env.DASHBOARD_PASSWORD = "correct-horse-battery";
});

test("safeEqual compares by value across differing lengths", () => {
  assert(safeEqual("abc", "abc"), "equal");
  assert(!safeEqual("abc", "abcd"), "different length");
  assert(!safeEqual("abc", "abd"), "same length, different content");
  assert(safeEqual("", ""), "both empty");
});

test("assertConfigured refuses to start when unset or weak", () => {
  const u = process.env.DASHBOARD_USER, p = process.env.DASHBOARD_PASSWORD;

  process.env.DASHBOARD_PASSWORD = "";
  let threw = false;
  try { assertConfigured(); } catch { threw = true; }
  assert(threw, "must refuse an unset password");

  process.env.DASHBOARD_PASSWORD = "short";
  threw = false;
  try { assertConfigured(); } catch { threw = true; }
  assert(threw, "must refuse a password under 12 chars");

  process.env.DASHBOARD_PASSWORD = "long-enough-password";
  assertConfigured();   // must not throw

  process.env.DASHBOARD_USER = u; process.env.DASHBOARD_PASSWORD = p;
});

console.log(failures === 0 ? "\nAll auth tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
