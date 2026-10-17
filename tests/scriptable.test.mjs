// Scriptable 스크립트 테스트 (node --test tests/scriptable.test.mjs)
// 실제 네트워크·키체인·iCloud를 쓰지 않는다. Request/FileManager/Keychain/Alert/위젯은 모두 합성 모의 객체다.
// 스크립트 끝의 진입점(await main(); Script.complete();)만 제거하고 VM에서 그대로 실행한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER = path.join(ROOT, "scriptable", "songpa-loan-tracker.js");
const ACCOUNTS = path.join(ROOT, "scriptable", "songpa-accounts.js");
const BASE = "https://splib.or.kr";
const LOGIN = `${BASE}/intro/program/memberLoginProc.do`;
const LOAN_PATH = "/intro/program/mypage/loanStatusList.do";
const DOO_PATH = "/intro/program/mypage/dooraeLillStatusList.do";
const LEASE = "/local/Library/songpa-loan-tracker.lease.json";
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- 스크립트 로더
function loadScript(file, globals) {
  const src = readFileSync(file, "utf8");
  const entry = /\nawait main\(\);\s*\nScript\.complete\(\);\s*$/;
  assert.match(src, entry, "trailing entrypoint must exist");
  const ctx = vm.createContext(globals);
  vm.runInContext(src.replace(entry, "\n"), ctx, { filename: path.basename(file) });
  return (expr) => vm.runInContext(expr, ctx);
}

// ---------------------------------------------------------------- Scriptable 모의 환경
function createEnv({ handler = async () => ({ throw: "no network" }), runsInWidget = false, keychain = {}, files = {} } = {}) {
  const log = { requests: [], offered: 0, followed: [], widgets: [], html: [], alerts: [], console: [] };
  const env = {
    log,
    jar: { cookie: null }, // Scriptable의 앱 공용 자동 쿠키 저장소 흉내
    keychain: new Map(Object.entries(keychain)),
    files: new Map(Object.entries(files)),
    alertScript: [],
    failLoadHTML: false
  };

  class Request {
    constructor(url) {
      this.url = url;
      this.method = "GET";
      this.headers = {};
      this.timeoutInterval = 60;
    }
    async loadString() {
      await tick();
      let current = this;
      for (let hop = 0; hop < 5; hop++) {
        const headers = { ...(current.headers || {}) };
        const key = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
        const cookie = key ? headers[key] : env.jar.cookie ? `JSESSIONID=${env.jar.cookie}` : null;
        const entry = { url: current.url, method: current.method || "GET", headers, body: current.body, cookie, explicitCookie: Boolean(key), timeout: current.timeoutInterval };
        log.requests.push(entry);
        const res = (await handler(entry)) || {};
        if (res.throw) throw new Error(res.throw);
        const resHeaders = { ...(res.headers || {}) };
        if (res.setSession) {
          resHeaders["Set-Cookie"] = `JSESSIONID=${res.setSession}; Path=/; HttpOnly`;
          env.jar.cookie = res.setSession;
        }
        if (res.location) resHeaders.Location = res.location;
        const response = {
          url: res.url || current.url,
          statusCode: res.status ?? 200,
          headers: resHeaders,
          cookies: res.cookies || (res.setSession ? [{ name: "JSESSIONID", value: res.setSession, domain: "splib.or.kr" }] : [])
        };
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && res.location) {
          const next = new Request(res.location.startsWith("/") ? BASE + res.location : res.location);
          let decision = next;
          if (typeof current.onRedirect === "function") {
            log.offered++;
            decision = current.onRedirect(next);
          }
          if (decision) {
            log.followed.push(next.url);
            current = decision;
            continue;
          }
        }
        this.response = response;
        return res.body ?? "";
      }
      throw new Error("too many redirects");
    }
  }

  const fm = {
    joinPath: (a, b) => `${a}/${b}`,
    libraryDirectory: () => "/local/Library",
    documentsDirectory: () => "/local/Documents",
    fileExists: (p) => env.files.has(p),
    readString: (p) => (env.files.has(p) ? env.files.get(p) : null),
    writeString: (p, s) => env.files.set(p, String(s)),
    remove: (p) => env.files.delete(p)
  };

  const makeStack = (texts) => ({
    addText(t) { texts.push(String(t)); return {}; },
    addStack() { return makeStack(texts); },
    addSpacer() {},
    centerAlignContent() {},
    layoutHorizontally() {},
    layoutVertically() {}
  });
  class ListWidget {
    constructor() {
      this.texts = [];
      Object.assign(this, makeStack(this.texts));
    }
  }
  class Color {
    constructor(hex) { this.hex = hex; }
    static dynamic(l, d) { return { l, d }; }
  }
  class WebView {
    async loadHTML(h) {
      if (env.failLoadHTML) throw new Error("render failed");
      log.html.push(h);
    }
    async present() {}
  }
  class Alert {
    constructor() {
      this.title = "";
      this.message = "";
      this.actions = [];
      this.fields = [];
      this.values = [];
    }
    addAction(t) { this.actions.push(t); }
    addDestructiveAction(t) { this.actions.push(t); }
    addCancelAction(t) { this.cancel = t; }
    addTextField(p, v = "") { this.fields.push({ p, v }); }
    addSecureTextField(p, v = "") { this.fields.push({ p, v, secure: true }); }
    async presentAlert() {
      log.alerts.push({ title: this.title, message: this.message, actions: [...this.actions], fields: plain(this.fields) });
      const step = env.alertScript.shift();
      if (!step) return -1;
      this.values = step.fields || [];
      return step.choice;
    }
    textFieldValue(i) {
      return this.values[i] !== undefined ? this.values[i] : this.fields[i].v;
    }
  }
  const capture = (...a) => log.console.push(a.map(String).join(" "));

  env.globals = {
    console: { log: capture, warn: capture, error: capture },
    Request,
    Keychain: {
      contains: (k) => env.keychain.has(k),
      get: (k) => { if (!env.keychain.has(k)) throw new Error("missing"); return env.keychain.get(k); },
      set: (k, v) => env.keychain.set(k, v),
      remove: (k) => env.keychain.delete(k)
    },
    FileManager: { local: () => fm, iCloud: () => fm },
    config: { runsInWidget },
    Script: { setWidget: (w) => log.widgets.push(w), complete() {}, name: () => "songpa-loan-tracker" },
    URLScheme: { forRunningScript: () => "scriptable:///run/songpa-loan-tracker" },
    ListWidget,
    Color,
    Font: { boldSystemFont: (s) => ({ s, bold: true }), systemFont: (s) => ({ s }) },
    WebView,
    Alert
  };
  return env;
}

// ---------------------------------------------------------------- 합성 도서관 서버
// 화면 구조는 테스트용으로 만든 것이며 실제 splib.or.kr 화면을 그대로 옮긴 것이 아니다.
function barcodeInfo(m) {
  return `<div class="barcodeInfo">${m.name} <span class="num">회원번호 : ${m.memberId}</span><img src="/barcode.do?t=1" alt=""></div>`;
}
function indexHtml(m, userId) {
  return `<html><body><header>${barcodeInfo(m)}<input type="hidden" name="userId" value="${userId}"><a href="/intro/memberLogout.do">로그아웃</a></header><main>홈</main></body></html>`;
}
function listPage(m, inner, kind, identity = true) {
  const self = kind === "loan" ? "loanStatusList.do" : "dooraeLillStatusList.do";
  return `<html><body><header>${identity && m ? barcodeInfo(m) : ""}</header>` +
    `<form id="searchForm" action="/intro/program/mypage/${self}" method="get"><input type="hidden" name="currentPageNo" value="1"></form>` +
    `<div class="list">${inner}</div><div class="paging"></div></body></html>`;
}
function loanRow(b) {
  return `<div class="myArticle-list">
    ${b.loanKey ? `<input type="hidden" name="loanKey" value="${b.loanKey}">` : ""}
    <input type="hidden" name="bookKey" value="BK1">
    <div class="title">${b.title}</div>
    <p><strong>${b.lib || "송파글마루도서관"}</strong></p>
    ${b.regNo ? `<span>등록번호 : ${b.regNo}</span>` : ""}
    <span>반납예정일 : ${b.due || "2099.12.31"}</span>
    <div class="statusBox">${b.booksole ? "책솔이 대출" : "대출중"}</div>
  </div>`;
}
function dooRow(d) {
  return `<div class="myArticle-list">
    ${d.illKey ? `<input type="hidden" name="illKey" value="${d.illKey}">` : ""}
    <div class="title">${d.title}</div>
    <p><span class="tit">제공도서관 : </span>${d.providing || "송파위례도서관"}
    </p><p><span class="tit">수령도서관 : </span>${d.receiving || "송파거마도서관"}
    </p>${d.regNo ? `<span>등록번호 : ${d.regNo}</span>` : ""}
    <div class="statusBox">${d.status} <button>신청취소</button></div>
  </div>`;
}
function listHtml(kind, m, pageNo, opts = {}) {
  const all = (kind === "loan" ? m.loans : m.doo) || [];
  const rows = all.slice((pageNo - 1) * 10, pageNo * 10);
  const inner = rows.length
    ? rows.map(kind === "loan" ? loanRow : dooRow).join("\n")
    : `<div class="noData">조회된 내역이 없습니다.</div>`;
  return listPage(m, inner, kind, opts.pageIdentity !== false);
}
const LOGIN_FORM = `<html><body><form action="/intro/program/memberLoginProc.do" method="post"><input type="text" name="userId"><input type="password" name="password"></form></body></html>`;

function makeLibrary(members, opts = {}) {
  const lib = { sessions: new Map(), issued: [], counter: 0, members };
  lib.newSession = (userId) => {
    const s = `SESS${String(++lib.counter).padStart(4, "0")}ABCDEFGH`;
    lib.sessions.set(s, userId);
    lib.issued.push(s);
    return s;
  };
  lib.handler = async (req) => {
    const u = new URL(req.url);
    if (u.host !== "splib.or.kr") return { throw: "offline (synthetic)" };
    const sid = /JSESSIONID=([^;]+)/.exec(req.cookie || "")?.[1] || null;
    const ctx = { path: u.pathname, page: Number(u.searchParams.get("currentPageNo") || 1), sid, userId: sid ? lib.sessions.get(sid) : null };
    ctx.member = ctx.userId ? members[ctx.userId] : null;
    if (opts.override) {
      const r = await opts.override(req, ctx, lib);
      if (r) return r;
    }
    if (ctx.path === "/intro/program/memberLoginProc.do") {
      const p = new URLSearchParams(req.body || "");
      const m = members[p.get("userId")];
      if (!m || m.pw !== p.get("password")) return { status: 200, body: "<script>alert('로그인 정보가 올바르지 않거나 존재하지 않습니다');history.back();</script>" };
      return { status: 302, location: "/intro/index.do", setSession: lib.newSession(p.get("userId")) };
    }
    if (!ctx.member) return { status: 302, location: "/intro/memberLogin.do" };
    if (ctx.path === "/intro/index.do") return { status: 200, body: indexHtml(ctx.member, ctx.userId) };
    if (ctx.path === LOAN_PATH) return { status: 200, body: listHtml("loan", ctx.member, ctx.page, opts) };
    if (ctx.path === DOO_PATH) return { status: 200, body: listHtml("doo", ctx.member, ctx.page, opts) };
    return { status: 404, body: "not found" };
  };
  return lib;
}

// ---------------------------------------------------------------- 공통 데이터
function books(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({ title: `${prefix} 책 ${i + 1}`, loanKey: `${prefix}-L${i + 1}`, regNo: `${prefix}R${i + 1}` }));
}
const A = { label: "엄마 김하나", id: "alice", pw: "pw-alice-1", memberId: "11110001" };
const B = { label: "아빠 이두리", id: "bob", pw: "pw-bob-22", memberId: "22220002" };
function members(overrides = {}) {
  return {
    alice: { pw: A.pw, memberId: "11110001", name: "김하나", loans: books("A", 2), doo: [], ...(overrides.alice || {}) },
    bob: { pw: B.pw, memberId: "22220002", name: "이두리", loans: books("B", 1), doo: [], ...(overrides.bob || {}) }
  };
}

function setup({ mem = members(), accounts = [A, B], opts = {}, runsInWidget = false, files = {} } = {}) {
  const lib = makeLibrary(mem, opts);
  const env = createEnv({ handler: lib.handler, runsInWidget, files, keychain: { SPLIB_ACCOUNTS: JSON.stringify(accounts) } });
  const run = loadScript(TRACKER, env.globals);
  const fetchAll = async (accs = accounts) => plain(await run("fetchAllAccounts")(accs, 60000));
  return { lib, env, run, fetchAll };
}
const titles = (r) => r.items.map((i) => i.title).sort();
const requestsFor = (t, p) => t.env.log.requests.filter((r) => r.url.startsWith(BASE + p));

// 로그인 요청은 JSESSIONID 없는 익명 Cookie를 명시하고(공유 저장소 병합 방지), 이후 모든 요청은 방금 받은 JSESSIONID를 직접 고정해야 한다
const ANON_LOGIN_COOKIE = "cookie=1";
function assertCookiePinned(t) {
  let k = -1;
  for (const r of t.env.log.requests) {
    if (!r.url.startsWith(BASE)) continue;
    if (r.url.startsWith(LOGIN)) {
      assert.equal(r.explicitCookie, true, "login must send an explicit anonymous cookie");
      assert.equal(r.cookie, ANON_LOGIN_COOKIE);
      assert.doesNotMatch(r.cookie, /JSESSIONID/i);
      k++;
      continue;
    }
    assert.equal(r.explicitCookie, true, `cookie must be pinned: ${r.url}`);
    assert.equal(r.cookie, `JSESSIONID=${t.lib.issued[k]}`);
  }
}

// ================================================================ 1. 신원 바인딩
test("A/B control: each account sees only its own books and every request pins its own cookie", async () => {
  const t = setup();
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
  assert.deepEqual(titles(b), ["B 책 1"]);
  assert.equal(a.items[0].user, "엄마 김하나");
  assertCookiePinned(t);
  assert.equal(t.env.log.followed.length, 0);
});

test("wrong identity on the first account: A is rejected and B is quarantined too (first is never trusted)", async () => {
  const t = setup({
    opts: {
      override: (req, ctx, lib) => {
        if (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=alice")) {
          return { status: 302, location: "/intro/index.do", setSession: lib.newSession("bob") };
        }
      }
    }
  });
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /다른 회원/);
  assert.equal(b.status, "error");
  assert.match(b.error, /엄마 김하나.*같은 회원번호/);
  assert.equal(a.items.length + b.items.length, 0);
});

test("later identity collision clears the earlier, previously clean account as well", async () => {
  const t = setup({
    opts: {
      override: (req, ctx, lib) => {
        if (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=bob")) {
          return { status: 302, location: "/intro/index.do", setSession: lib.newSession("alice") };
        }
      }
    }
  });
  const [a, b] = await t.fetchAll();
  assert.equal(b.status, "error");
  assert.equal(a.status, "error");
  assert.match(a.error, /아빠 이두리/);
  assert.equal(a.items.length, 0);
});

test("reused session across accounts quarantines both even when identities differ", async () => {
  const t = setup({
    opts: {
      override: (req, ctx, lib) => {
        if (ctx.path.endsWith("memberLoginProc.do")) {
          const userId = new URLSearchParams(req.body).get("userId");
          lib.sessions.set("SESSSHARED0001", userId);
          return { status: 302, location: "/intro/index.do", setSession: "SESSSHARED0001" };
        }
      }
    }
  });
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.equal(b.status, "error");
  assert.match(a.error, /같은 세션/);
  assert.match(b.error, /같은 세션/);
});

test("homonyms with distinct member IDs both work (name is not identity)", async () => {
  const mem = {
    k1: { pw: "pw-k1-aaa", memberId: "30000001", name: "김민수", loans: books("K1", 1), doo: [] },
    k2: { pw: "pw-k2-bbb", memberId: "30000002", name: "김민수", loans: books("K2", 1), doo: [] }
  };
  const accounts = [
    { label: "김민수 (큰집)", id: "k1", pw: "pw-k1-aaa", memberId: "30000001", siteName: "김민수" },
    { label: "김민수 (작은집)", id: "k2", pw: "pw-k2-bbb", memberId: "30000002", siteName: "김민수" }
  ];
  const t = setup({ mem, accounts });
  const [x, y] = await t.fetchAll();
  assert.equal(x.status, "ok");
  assert.equal(y.status, "ok");
  assert.deepEqual(titles(x), ["K1 책 1"]);
  assert.deepEqual(titles(y), ["K2 책 1"]);
});

test("absent expected member ID fails closed without contacting the site or enrolling", async () => {
  const legacy = { label: "예전 계정", id: "carol", pw: "pw-carol" };
  const t = setup({ accounts: [A, legacy] });
  const before = t.env.keychain.get("SPLIB_ACCOUNTS");
  const [a, c] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(c.status, "error");
  assert.match(c.error, /회원번호 미설정/);
  assert.match(c.error, /songpa-accounts/);
  assert.ok(c.error.includes("https://github.com/pchuri/songpa-loan-tracker/blob/main/scriptable/songpa-accounts.js"), c.error);
  assert.match(c.error, /새 버전.*교체.*계정 수정/);
  assert.equal(t.env.log.requests.filter((r) => String(r.body || "").includes("userId=carol")).length, 0);
  assert.equal(t.env.keychain.get("SPLIB_ACCOUNTS"), before);
});

test("configured member ID that does not match the site is rejected", async () => {
  const t = setup({ accounts: [{ ...A, memberId: "99990009" }] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /다른 회원/);
  assert.equal(a.items.length, 0);
});

test("same member ID configured on two accounts fails both before any login", async () => {
  const t = setup({ accounts: [A, { ...B, memberId: "1111-0001" }] });
  const r = await t.fetchAll();
  assert.ok(r.every((x) => x.status === "error" && /같은 회원번호가 다른 계정/.test(x.error)));
  assert.equal(requestsFor(t, "/intro/program/memberLoginProc.do").length, 0);
});

test("identity parser: hidden userId / book IDs are ignored, ambiguous IDs rejected, semantic member field accepted", async () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  const onlyGeneric = `<div class="barcodeInfo">김하나 님</div><input type="hidden" name="userId" value="11110001"><input name="bookKey" value="11110001"><input name="regNo" value="11110001">`;
  assert.equal(parse(onlyGeneric).status, "missing");
  assert.equal(parse(`<input type="hidden" name="memberNo" value="1111-0001">`).memberId, "11110001");
  assert.equal(parse(`<div data-member-barcode="ab12cd34"></div>`).memberId, "AB12CD34");
  assert.equal(parse(`<div class="barcodeInfo">김하나<span>회원번호 : 11110001</span></div><input name="memberNo" value="22220002">`).status, "ambiguous");
  assert.equal(parse(`<input name="memberNo" value="1!">`).status, "ambiguous");
  const p = parse(`<div class="barcodeInfo">김하나 <span>바코드 : 11110001</span></div>`);
  assert.equal(p.memberId, "11110001");
  assert.deepEqual(p.siteNames, ["김하나"]);

  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === "/intro/index.do" && ctx.member ? { status: 200, body: `<html>${onlyGeneric}</html>` } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /회원번호를 찾지 못/);
});

// ================================================================ 2. 세션·리다이렉트
test("missing JSESSIONID never falls back to the shared automatic cookie", async () => {
  const t = setup({
    opts: {
      override: (req, ctx) => {
        if (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=bob")) return { status: 302, location: "/intro/index.do" };
      }
    }
  });
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(b.status, "error");
  assert.match(b.error, /JSESSIONID/);
  const reqs = t.env.log.requests;
  const bobLogin = reqs.findIndex((r) => String(r.body || "").includes("userId=bob"));
  assert.equal(reqs.length, bobLogin + 1, "no request may follow a login without a fresh cookie");
  assert.ok(t.env.jar.cookie, "the shared jar still held an earlier cookie that must not be used");
});

test("login sends an explicit anonymous cookie so a preloaded stale jar session is never sent or reused", async () => {
  // 서버 모델: 로그인 요청에 JSESSIONID가 있으면 그 세션을 그대로 재사용(새 세션 미발급, Set-Cookie 없음)하고,
  // JSESSIONID가 없을 때만 새 세션을 발급한다. 스크립트가 공유 저장소 쿠키를 흘리면 B는 새 세션을 받지 못한다.
  const STALE = "STALEOLDJAR0001XYZ";
  const loginCookies = [];
  const t = setup({
    opts: {
      override: (req, ctx, lib) => {
        if (!ctx.path.endsWith("memberLoginProc.do")) return null;
        loginCookies.push(req.cookie);
        if (ctx.sid) return { status: 302, location: "/intro/index.do" }; // 기존 세션 유지 → Set-Cookie 없음
        return null; // 기본 처리: 새 세션 발급
      }
    }
  });
  t.lib.sessions.set(STALE, "bob"); // 이전 실행·다른 계정이 남긴 저장소 세션
  t.env.jar.cookie = STALE;
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
  assert.deepEqual(titles(b), ["B 책 1"]);
  assert.equal(loginCookies.length, 2);
  assert.ok(loginCookies.every((c) => c === ANON_LOGIN_COOKIE), JSON.stringify(loginCookies));
  assert.equal(t.lib.issued.length, 2);
  assert.notEqual(t.lib.issued[0], t.lib.issued[1], "each login must get its own fresh session");
  assert.ok(!t.lib.issued.includes(STALE));
  for (const r of t.env.log.requests) assert.ok(!String(r.cookie || "").includes(STALE), `stale jar cookie leaked: ${r.url}`);
  assertCookiePinned(t);
});

test("control: a login that leaks the jar cookie would get no fresh session and fail closed", async () => {
  // 위 서버 모델이 의미 있는지 확인: 로그인 Cookie를 제거해 저장소가 붙게 하면 새 세션이 없어 오류로 끝나야 한다
  const STALE = "STALEOLDJAR0002XYZ";
  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path.endsWith("memberLoginProc.do") && ctx.sid ? { status: 302, location: "/intro/index.do" } : null) }
  });
  t.lib.sessions.set(STALE, "bob");
  t.env.jar.cookie = STALE;
  const RealRequest = t.env.globals.Request;
  t.env.globals.Request = class extends RealRequest {
    async loadString() {
      if (String(this.url).startsWith(LOGIN) && this.headers) delete this.headers.Cookie;
      return super.loadString();
    }
  };
  // env.globals는 createEnv/setup에서 이미 VM 컨텍스트 전역 객체로 쓰이므로, 위 대입이 곧 VM 안의 Request를 바꾼다.
  // 스크립트를 다시 로드하지 않고(이중 const 선언 방지) 기존 평가기로 래퍼가 실제 적용됐는지 확인한다.
  assert.equal(t.run("Request"), t.env.globals.Request, "wrapper must be the Request seen inside the existing VM");
  const [a] = await t.fetchAll([A]);
  assert.equal(a.status, "error");
  assert.match(a.error, /JSESSIONID/);
  assert.equal(t.env.log.requests[0].cookie, `JSESSIONID=${STALE}`);
  assert.equal(t.env.log.requests.length, 1);
});

test("multiple or invalid JSESSIONID values in the login response are rejected", async () => {
  for (const setCookie of ["JSESSIONID=AAAAAAAA11; Path=/, JSESSIONID=BBBBBBBB22; Path=/", "JSESSIONID=a<b>; Path=/"]) {
    const t = setup({
      accounts: [A],
      opts: { override: (req, ctx) => (ctx.path.endsWith("memberLoginProc.do") ? { status: 302, location: "/intro/index.do", headers: { "Set-Cookie": setCookie } } : null) }
    });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error");
    assert.match(a.error, /세션 쿠키/);
    assert.equal(t.env.log.requests.length, 1);
  }
});

test("redirect lifecycle: login redirect is stopped (onRedirect → null) and the completed 302 is inspected", async () => {
  const ok = setup({ accounts: [A] });
  const [a] = await ok.fetchAll();
  assert.equal(a.status, "ok");
  assert.ok(ok.env.log.offered >= 1, "onRedirect was offered the login redirect");
  assert.equal(ok.env.log.followed.length, 0, "no redirect was followed");

  const toLogin = setup({
    accounts: [A],
    opts: {
      override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do")
        ? { status: 302, location: "/intro/memberLogin.do?fail=1", setSession: lib.newSession("alice") }
        : null)
    }
  });
  const [x] = await toLogin.fetchAll();
  assert.equal(x.status, "error");
  assert.match(x.error, /로그인 화면/);
  assert.equal(toLogin.env.log.requests.length, 1, "redirect target and member pages were not requested");

  const body200 = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path.endsWith("memberLoginProc.do") ? { status: 200, body: LOGIN_FORM } : null) } });
  const [y] = await body200.fetchAll();
  assert.equal(y.status, "error");
  assert.match(y.error, /로그인/);
});

test("list page redirect to login is not followed and quarantines the account", async () => {
  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH ? { status: 302, location: "/intro/memberLogin.do" } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.equal(a.items.length, 0);
  assert.equal(t.env.log.followed.length, 0);
  assert.equal(requestsFor(t, "/intro/memberLogin.do").length, 0);
});

test("final URL different from the requested page is rejected", async () => {
  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH ? { status: 200, url: `${BASE}/intro/memberLogin.do`, body: listHtml("loan", ctx.member, 1) } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /주소/);
});

// ================================================================ 3. 목록 페이지 검증
test("list page returning a login form with HTTP 200 quarantines all of the account's data", async () => {
  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === DOO_PATH ? { status: 200, body: LOGIN_FORM } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.equal(a.items.length, 0, "already fetched loans are discarded on authentication failure");
  assert.match(a.error, /로그인 화면/);
});

test("page identity drift on a later page quarantines everything", async () => {
  const mem = members({ alice: { loans: books("A", 15) } });
  const t = setup({
    mem,
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 2 ? { status: 200, body: listHtml("loan", { ...mem.bob, loans: books("A", 15) }, 2) } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /대출 목록 2페이지.*다른 회원/);
  assert.equal(a.items.length, 0);
});

test("list pages without a trusted member ID are rejected even when index before/after are A; post-check still catches drift", async () => {
  // 앞뒤 메인 화면이 A여도 목록 페이지 자체에 회원번호가 없으면 데이터 주인을 증명할 수 없다 → 이름만으로 대체하지 않음
  const noId = setup({ accounts: [A], opts: { pageIdentity: false } });
  const [x] = await noId.fetchAll();
  assert.equal(x.status, "error");
  assert.match(x.error, /대출 목록 1페이지.*회원번호를 찾지 못/);
  assert.equal(x.items.length, 0);

  const named = setup({ accounts: [{ ...A, siteName: "김하나" }], opts: { pageIdentity: false } });
  const [y] = await named.fetchAll();
  assert.equal(y.status, "error", "name-only page is never accepted");
  assert.equal(y.items.length, 0);

  let indexCalls = 0;
  const mem = members();
  const t = setup({
    mem,
    accounts: [A],
    opts: {
      override: (req, ctx) => {
        if (ctx.path !== "/intro/index.do" || !ctx.member) return null;
        indexCalls++;
        return indexCalls === 2 ? { status: 200, body: indexHtml(mem.bob, "bob") } : null;
      }
    }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /조회 후 재확인/);
  assert.equal(a.items.length, 0);
});

test("after-check network failure discards the result (cannot confirm bracket)", async () => {
  let indexCalls = 0;
  const t = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === "/intro/index.do" && ++indexCalls === 2 ? { throw: "timeout" } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /조회 후 재확인/);
  assert.equal(a.items.length, 0);
});

test("transient wrong page: ID-less list page carrying B's books (index is A before and after) discards A", async () => {
  const mem = members({ alice: { loans: books("A", 12) } });
  const wrong = setup({
    mem,
    accounts: [A],
    opts: {
      override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 2
        ? { status: 200, body: listHtml("loan", { ...mem.bob, loans: books("B", 12) }, 2, { pageIdentity: false }) }
        : null)
    }
  });
  const [a] = await wrong.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /대출 목록 2페이지.*회원번호를 찾지 못/);
  assert.equal(a.items.length, 0);
  assert.equal(requestsFor(wrong, "/intro/index.do").length, 1, "index looked fine, yet the page alone decides");

  // 확인된 빈 끝 페이지에도 회원번호가 있어야 한다
  const emptyEnd = setup({
    mem: members({ alice: { loans: books("A", 10) } }),
    accounts: [A],
    opts: {
      override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 2
        ? { status: 200, body: listPage(null, `<div class="noData">조회된 내역이 없습니다.</div>`, "loan", false) }
        : null)
    }
  });
  const [e] = await emptyEnd.fetchAll();
  assert.equal(e.status, "error");
  assert.equal(e.items.length, 0);
});

test("supported authenticated empty lists are a confirmed zero", async () => {
  const t = setup({ mem: members({ alice: { loans: [] } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(a.items.length, 0);
  assert.equal(a.loanComplete, true);
  assert.equal(a.dooComplete, true);
});

test("unrecognized empty HTML is never a zero", async () => {
  const unknown = (ctx) => ({ status: 200, body: `<html><body>${barcodeInfo(ctx.member)}<p>점검 중</p></body></html>` });
  const one = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH ? unknown(ctx) : null) } });
  const [p] = await one.fetchAll();
  assert.equal(p.status, "partial");
  assert.equal(p.loanComplete, false);
  assert.ok(p.warnings.some((w) => /인식하지 못함/.test(w)));

  const both = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH || ctx.path === DOO_PATH ? unknown(ctx) : null) } });
  const [e] = await both.fetchAll();
  assert.equal(e.status, "error");
  const html = both.run("buildHtmlPage")([e]);
  assert.doesNotMatch(html, /현재 이용 중인 도서가 없습니다/);
  assert.doesNotMatch(html, /총 0권/);
});

// ================================================================ 6. 페이지 넘김
const loanPagesRequested = (t) => requestsFor(t, LOAN_PATH).map((r) => new URL(r.url).searchParams.get("currentPageNo"));

test("21 books: a short page 3 is not trusted as the end; authenticated empty page 4 ends the list", async () => {
  const t = setup({ mem: members({ alice: { loans: books("A", 21) } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(a.items.length, 21);
  assert.equal(a.loanCount, 21, "validation pass does not double count");
  assert.deepEqual(titles(a), books("A", 21).map((b) => b.title).sort());
  assert.equal(a.loanComplete, true);
  // 첫 조회 + 같은 페이지(빈 끝 페이지 포함) 재확인
  assert.deepEqual(loanPagesRequested(t), [null, "2", "3", "4", null, "2", "3", "4"]);
  assertCookiePinned(t);
});

test("exactly 20 books ends on the authenticated empty page 3", async () => {
  const t = setup({ mem: members({ alice: { loans: books("A", 20) } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(a.items.length, 20);
  assert.deepEqual(loanPagesRequested(t), [null, "2", "3", null, "2", "3"]);
});

test("server page size 5 with 7 books: the short first page does not end the list (all 7 kept)", async () => {
  const seven = books("A", 7);
  const t = setup({
    accounts: [A],
    opts: {
      override: (req, ctx) => {
        if (ctx.path !== LOAN_PATH || !ctx.member) return null;
        const rows = seven.slice((ctx.page - 1) * 5, ctx.page * 5);
        const inner = rows.length ? rows.map(loanRow).join("\n") : `<div class="noData">조회된 내역이 없습니다.</div>`;
        return { status: 200, body: listPage(ctx.member, inner, "loan") };
      }
    }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.deepEqual(titles(a), seven.map((b) => b.title).sort());
  assert.deepEqual(loanPagesRequested(t), [null, "2", "3", null, "2", "3"]);
});

// 대출 목록 요청 순서(첫 조회·재확인 포함)를 세면서 페이지를 만들어 주는 합성 서버
function sequencedLoans(initial, hook) {
  const state = { loans: initial.slice(), calls: 0 };
  return {
    state,
    opts: {
      override: (req, ctx) => {
        if (ctx.path !== LOAN_PATH || !ctx.member) return null;
        const call = ++state.calls;
        const custom = hook && hook(call, ctx, state);
        if (custom) return custom;
        const rows = state.loans.slice((ctx.page - 1) * 10, ctx.page * 10);
        return { status: 200, body: listPage(ctx.member, rows.length ? rows.map(loanRow).join("\n") : `<div class="noData">조회된 내역이 없습니다.</div>`, "loan") };
      }
    }
  };
}

test("deletion between pages (no duplicate) is caught by validation: partial in data, widget and HTML", async () => {
  // 1페이지(L1~L10)를 읽은 뒤 L3가 반납되어 2페이지가 L12~L21로 밀림 → L11은 첫 조회에서 빠짐
  const make = () => sequencedLoans(books("A", 21), (call, ctx, state) => {
    if (call === 2) state.loans = state.loans.filter((b) => b.loanKey !== "A-L3");
    return null;
  });
  const s = make();
  const t = setup({ accounts: [A], opts: s.opts });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.loanComplete, false);
  assert.equal(a.loanCount, 20, "first-pass records are kept, not re-added");
  assert.ok(!titles(a).includes("A 책 11"));
  assert.ok(a.warnings.some((w) => /대출 목록: 조회 중 1페이지 내용이 바뀌어/.test(w)));
  assert.deepEqual(loanPagesRequested(t), [null, "2", "3", null]);
  assert.match(t.run("buildHtmlPage")([a]), /일부 계정·목록만 확인됨/);
  const w = await renderWidget({ accounts: [A], opts: make().opts });
  assert.match(w.text, /일부만 확인/);
  assert.doesNotMatch(w.text, /조회 완료/);
});

test("validation phase: identity drift or changed cookie hides all; ordinary failure, budget and new terminal row are partial", async () => {
  // 15권: 첫 조회 3요청(1·2·빈 3페이지), 4번째 요청부터 재확인
  const run = async (hook, mutate) => {
    const s = sequencedLoans(books("A", 15), hook);
    let t;
    t = setup({ accounts: [A], opts: { override: (req, ctx) => { if (mutate) mutate(t, ctx, s.state); return s.opts.override(req, ctx); } } });
    return { t, a: (await t.fetchAll())[0] };
  };
  const mem = members();

  const drift = await run((call, ctx) => (call === 5 ? { status: 200, body: listHtml("loan", { ...mem.bob, loans: books("A", 15) }, ctx.page) } : null));
  assert.equal(drift.a.status, "error");
  assert.match(drift.a.error, /재확인 2페이지.*다른 회원/);
  assert.equal(drift.a.items.length, 0);

  const cookie = await run((call, ctx) => (call === 4
    ? { status: 200, body: listHtml("loan", ctx.member, ctx.page), headers: { "Set-Cookie": "JSESSIONID=ROTATED00001XYZ; Path=/" } }
    : null));
  assert.equal(cookie.a.status, "error");
  assert.match(cookie.a.error, /세션 쿠키/);
  assert.equal(cookie.a.items.length, 0);

  const http500 = await run((call) => (call === 5 ? { status: 500, body: "" } : null));
  assert.equal(http500.a.status, "partial");
  assert.equal(http500.a.loanComplete, false);
  assert.equal(http500.a.loanCount, 15);
  assert.ok(http500.a.warnings.some((w) => /재확인 2페이지를 불러오지 못했습니다/.test(w)));

  const budget = await run(null, (t, ctx, state) => { if (state.calls === 3) t.run("clock").now = () => Date.now() + 1e9; });
  assert.equal(budget.a.status, "partial");
  assert.equal(budget.a.loanComplete, false);
  assert.equal(budget.a.loanCount, 15);
  assert.ok(budget.a.warnings.some((w) => /시간 제한으로 재확인/.test(w)));

  const grown = await run((call, ctx) => (call === 6
    ? { status: 200, body: listPage(ctx.member, loanRow({ title: "새 책", loanKey: "A-NEW", regNo: "ANEW1" }), "loan") }
    : null));
  // 1·2페이지는 같고, 빈 끝 페이지(3)에 새 책이 생김
  assert.equal(grown.a.status, "partial");
  assert.equal(grown.a.loanComplete, false);
  assert.equal(grown.a.loanCount, 15);
  assert.ok(grown.a.warnings.some((w) => /3페이지 내용이 바뀌어/.test(w)));
});

test("empty-only list is confirmed by a single request; capped/partial first pass gets no validation pass", async () => {
  const empty = setup({ mem: members({ alice: { loans: [] } }), accounts: [A] });
  const [e] = await empty.fetchAll();
  assert.equal(e.status, "ok");
  assert.deepEqual(loanPagesRequested(empty), [null]);

  const capped = setup({ mem: members({ alice: { loans: books("A", 35) } }), accounts: [A] });
  capped.run("LIMITS").maxPages = 2;
  await capped.fetchAll();
  assert.deepEqual(loanPagesRequested(capped), [null, "2"]);
});

test("repeated page is partial, not complete", async () => {
  const mem = members({ alice: { loans: books("A", 30) } });
  const t = setup({
    mem,
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page > 1 ? { status: 200, body: listHtml("loan", ctx.member, 1) } : null) }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.items.length, 10);
  assert.ok(a.warnings.some((w) => /앞 페이지와 같아/.test(w)));
});

test("page cap and runtime budget produce partial results", async () => {
  const capped = setup({ mem: members({ alice: { loans: books("A", 35) } }), accounts: [A] });
  capped.run("LIMITS").maxPages = 2;
  const [c] = await capped.fetchAll();
  assert.equal(c.status, "partial");
  assert.equal(c.items.length, 20);
  assert.ok(c.warnings.some((w) => /최대 2페이지/.test(w)));

  let timed;
  timed = setup({
    mem: members({ alice: { loans: books("A", 35) } }),
    accounts: [A],
    opts: {
      override: (req, ctx) => {
        if (ctx.path === LOAN_PATH && ctx.page === 2) timed.run("clock").now = () => Date.now() + 1e9;
        return null;
      }
    }
  });
  const [d] = await timed.fetchAll();
  assert.equal(d.status, "partial");
  assert.equal(d.items.length, 20);
  assert.ok(d.warnings.some((w) => /시간 제한/.test(w)));
});

test("malformed or failed late page keeps validated pages as partial; late auth failure discards all", async () => {
  const mem = () => members({ alice: { loans: books("A", 25) } });
  const late = (res) => setup({ mem: mem(), accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 3 ? res(ctx) : null) } });

  const malformed = late((ctx) => ({ status: 200, body: listPage(ctx.member, `<div class="myArticle-list"><div class="title">반납일 없는 행</div></div>`, "loan") }));
  const [m] = await malformed.fetchAll();
  assert.equal(m.status, "partial");
  assert.equal(m.items.length, 20);
  assert.ok(m.warnings.some((w) => /3페이지/.test(w)));

  const http500 = late(() => ({ status: 500, body: "error" }));
  const [h] = await http500.fetchAll();
  assert.equal(h.status, "partial");
  assert.equal(h.items.length, 20);

  const auth = late(() => ({ status: 200, body: LOGIN_FORM }));
  const [x] = await auth.fetchAll();
  assert.equal(x.status, "error");
  assert.equal(x.items.length, 0);
});

// ================================================================ 5. 기록 식별자
test("same-title different copies are both kept (no title+date+library dedup)", async () => {
  const loans = [{ title: "어린왕자", regNo: "EM001" }, { title: "어린왕자", regNo: "EM002" }];
  const t = setup({ mem: members({ alice: { loans } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.items.length, 2);
  assert.equal(a.loanCount, 2);
  assert.ok(!a.warnings.some((w) => /식별번호/.test(w)));
});

test("same-title pickup of a different copy is shown separately; same copy is joined", async () => {
  const distinct = setup({
    mem: members({ alice: { loans: [{ title: "어린왕자", regNo: "EM001" }], doo: [{ title: "어린왕자", status: "입수", regNo: "EM002", illKey: "I1" }] } }),
    accounts: [A]
  });
  const [d] = await distinct.fetchAll();
  assert.deepEqual(d.items.map((i) => i.statusType).sort(), ["대출중", "픽업필요"]);
  assert.equal(d.pickupCount, 1);

  // 연결 대조군: 대출 행 도서관(글마루)과 상호대차 제공 도서관(글마루)이 같아 같은 범위의 같은 등록번호
  const same = setup({
    mem: members({ alice: { loans: [{ title: "어린왕자", regNo: "EM001" }], doo: [{ title: "어린왕자", status: "발송", regNo: "EM001", illKey: "I1", providing: "송파글마루도서관", receiving: "송파거마도서관" }] } }),
    accounts: [A]
  });
  const [s] = await same.fetchAll();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].isInter, true);
  assert.equal(s.items[0].lib, "송파거마도서관");
  assert.equal(s.transitCount, 0);

  const noId = setup({
    mem: members({ alice: { loans: [{ title: "어린왕자", regNo: "EM001" }], doo: [{ title: "어린왕자", status: "입수" }] } }),
    accounts: [A]
  });
  const [n] = await noId.fetchAll();
  assert.equal(n.items.length, 2, "title-only match must not suppress the pickup");
  assert.ok(n.warnings.some((w) => /같은 책인지/.test(w)));
});

test("stable-ID duplicates across pages are counted once but mark the result partial (list shifted)", async () => {
  const loans = books("A", 12);
  loans.splice(10, 0, { ...loans[0] }); // 11번째(2페이지 첫 항목)가 1번과 같은 대출
  const t = setup({ mem: members({ alice: { loans } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.items.length, 12);
  assert.ok(a.warnings.some((w) => /한 번만/.test(w)));
});

test("rows without stable IDs are all preserved with a warning; shared bookKey is not used as an ID", async () => {
  const loans = [{ title: "같은 책" }, { title: "같은 책" }];
  const t = setup({ mem: members({ alice: { loans } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.items.length, 2);
  assert.ok(a.warnings.some((w) => /식별번호가 없어/.test(w)));
});

// 대출 1페이지만 직접 만든 HTML로 바꾼다 (2페이지는 기본 빈 페이지)
function customPage(path, inner, kind) {
  return { accounts: [A], opts: { override: (req, ctx) => (ctx.path === path && ctx.page === 1 ? { status: 200, body: listPage(ctx.member, inner, kind) } : null) } };
}
const rawLoan = (lib, title = "같은 제목") => `<div class="myArticle-list"><input type="hidden" name="loanKey" value="L1">
  <div class="title">${title}</div>${lib}<span>반납예정일 : 2099.12.31</span><div class="statusBox">대출중</div></div>`;

test("attributed/nested <strong> library is read; same local loan ID in two libraries keeps both", async () => {
  const inner = rawLoan(`<p><strong class="library"><span>Library X</span></strong></p>`) + rawLoan(`<p><strong class="library">Library Y</strong></p>`);
  const t = setup({ mem: members({ alice: { loans: [] } }), ...customPage(LOAN_PATH, inner, "loan") });
  const [a] = await t.fetchAll();
  assert.equal(a.loanCount, 2);
  assert.deepEqual(a.items.map((i) => i.lib).sort(), ["Library X", "Library Y"]);
  assert.equal(a.status, "ok");
});

test("missing loan library: same local loan IDs are not merged under an unknown scope; partial warning", async () => {
  const t = setup({ mem: members({ alice: { loans: [] } }), ...customPage(LOAN_PATH, rawLoan("") + rawLoan(""), "loan") });
  const [a] = await t.fetchAll();
  assert.equal(a.loanCount, 2);
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /도서관을 확인하지 못한 대출 2건/.test(w)));
});

test("unknown ILL provider/route: same ILL IDs are never merged; partial warning", async () => {
  const row = `<div class="myArticle-list"><input type="hidden" name="illKey" value="ILL001"><div class="title">픽업 책</div>
    <p><span class="tit">수령도서관 : </span>Library Z</p><div class="statusBox">입수</div></div>`;
  const t = setup({ mem: members({ alice: { loans: [] } }), ...customPage(DOO_PATH, row + row, "doo") });
  const [a] = await t.fetchAll();
  assert.equal(a.pickupCount, 2);
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /제공·수령 도서관을 확인하지 못한 상호대차 2건/.test(w)));
});

test("same scoped copy ID with conflicting titles is not joined; matching title still joins", async () => {
  const loan = { title: "Actual loan title", loanKey: "LOAN1", regNo: "COPY001", lib: "Library X" };
  const doo = { title: "Different pickup title", illKey: "ILL001", regNo: "COPY001", providing: "Library X", receiving: "Library Z", status: "입수" };
  const t = setup({ mem: members({ alice: { loans: [loan], doo: [doo] } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.loanCount, 1);
  assert.equal(a.pickupCount, 1);
  assert.equal(a.items.find((i) => i.statusType === "대출중").lib, "Library X");
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /제목이 다른/.test(w)));

  const ok = setup({ mem: members({ alice: { loans: [loan], doo: [{ ...doo, title: "Actual loan title" }] } }), accounts: [A] });
  const [o] = await ok.fetchAll();
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].lib, "Library Z");
  assert.equal(o.pickupCount, 0);
  assert.equal(o.status, "ok");
});

test("active ILL with missing receiving library is not joined, so its warning remains", async () => {
  const loan = { title: "같은 책", loanKey: "LOAN1", regNo: "COPY001", lib: "Library X" };
  const row = `<div class="myArticle-list"><input type="hidden" name="illKey" value="ILL001"><div class="title">같은 책</div>
    <p><span class="tit">제공도서관 : </span>Library X</p><span>등록번호 : COPY001</span><div class="statusBox">발송</div></div>`;
  const t = setup({ mem: members({ alice: { loans: [loan] } }), ...customPage(DOO_PATH, row, "doo") });
  const [a] = await t.fetchAll();
  assert.equal(a.loanCount, 1);
  assert.equal(a.transitCount, 1);
  assert.equal(a.items.find((i) => i.statusType === "대출중").lib, "Library X");
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /수령처 미확인/.test(w)));
});

test("shifted pagination (exact cross-page duplicate) is partial in data, widget and HTML", async () => {
  const all = books("A", 20); // 새 L0가 앞에 끼어 2페이지가 L10부터 다시 시작
  const pages = { 1: all.slice(0, 10), 2: all.slice(9, 19), 3: all.slice(19, 20), 4: [] };
  const opts = {
    override: (req, ctx) => {
      if (ctx.path !== LOAN_PATH) return null;
      const rows = pages[ctx.page] || [];
      return { status: 200, body: listPage(ctx.member, rows.length ? rows.map(loanRow).join("") : `<div class="noData">조회된 내역이 없습니다.</div>`, "loan") };
    }
  };
  const t = setup({ accounts: [A], opts });
  const data = await t.fetchAll();
  assert.equal(data[0].status, "partial");
  assert.equal(data[0].loanCount, 20);
  assert.ok(data[0].warnings.some((w) => /한 번만/.test(w)));
  assert.match(t.run("buildHtmlPage")(data), /일부 계정·목록만 확인됨/);
  const w = await renderWidget({ accounts: [A], opts });
  assert.match(w.text, /일부만 확인/);
  assert.doesNotMatch(w.text, /조회 완료/);
});

test("sidebar noData with an unrecognized real list is not a confirmed zero", async () => {
  const opts = {
    override: (req, ctx) => (ctx.path === LOAN_PATH ? {
      status: 200,
      body: `<html><body>${barcodeInfo(ctx.member)}<form action="${LOAN_PATH}"></form><aside><div class="noData">자료가 없습니다</div></aside>` +
        `<section class="renamedList"><article class="book">숨은 대출 책</article></section></body></html>`
    } : null)
  };
  const t = setup({ accounts: [A], opts });
  const [a] = await t.fetchAll();
  assert.notEqual(a.status, "ok");
  assert.equal(a.loanComplete, false);
  assert.ok(a.warnings.some((w) => /목록 형식을 인식하지 못함/.test(w)));
});

test("same JSESSIONID with a past Expires is a deletion; future Expires and no cookie are fine", async () => {
  const withCookie = (expires) => ({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.member ? { status: 200, body: listHtml("loan", ctx.member, ctx.page), headers: { "Set-Cookie": `JSESSIONID=${ctx.sid}; Path=/; Expires=${expires}; HttpOnly` } } : null) }
  });
  const [past] = await setup(withCookie("Thu, 01 Jan 1970 00:00:00 GMT")).fetchAll();
  assert.equal(past.status, "error");
  assert.match(past.error, /바뀌거나 삭제/);
  assert.equal(past.items.length, 0);

  const [future] = await setup(withCookie("Fri, 31 Dec 2100 23:59:59 GMT")).fetchAll();
  assert.equal(future.status, "ok");
  const [none] = await setup({ accounts: [A] }).fetchAll();
  assert.equal(none.status, "ok");
});

test("same JSESSIONID Max-Age: <=0 or malformed deletes (even with future Expires); positive Max-Age overrides past Expires", async () => {
  const NOW = Date.parse("2026-10-17T00:00:00Z");
  const withCookie = async (attrs, now = NOW) => {
    const t = setup({
      accounts: [A],
      opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.member ? { status: 200, body: listHtml("loan", ctx.member, ctx.page), headers: { "Set-Cookie": `JSESSIONID=${ctx.sid}${attrs}` } } : null) }
    });
    t.run("clock").now = () => now;
    return (await t.fetchAll())[0];
  };
  const rejected = [
    "; Path=/; Expires=Fri, 31 Dec 2100 23:59:59 GMT; Max-Age=0; HttpOnly",
    "; Expires=Fri, 31 Dec 2100 23:59:59 GMT; Max-Age=0, OTHER=1; Path=/",
    "; Path=/; Max-Age=-1",
    "; Path=/; Max-Age=abc",
    "; Max-Age=3600; Max-Age=0"
  ];
  for (const attrs of rejected) {
    const a = await withCookie(attrs);
    assert.equal(a.status, "error", attrs);
    assert.match(a.error, /바뀌거나 삭제/);
    assert.equal(a.items.length, 0);
  }
  for (const attrs of ["; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600", "; Max-Age=+60; Path=/", "; Path=/", "; Expires=Sat, 17 Oct 2026 01:00:00 GMT"]) {
    const a = await withCookie(attrs);
    assert.equal(a.status, "ok", `${attrs} ${a.error}`);
    assert.equal(a.items.length, 2);
  }
  // Expires는 clock.now 기준으로 판단한다
  const later = await withCookie("; Expires=Fri, 31 Dec 2100 23:59:59 GMT", Date.parse("2101-01-01T00:00:00Z"));
  assert.equal(later.status, "error");
  assert.equal(later.items.length, 0);
});

// ================================================================ 4. 화면
function widgetTexts(t) {
  const w = t.env.log.widgets.at(-1);
  return w.texts.join("\n");
}
async function renderWidget(opts) {
  const t = setup({ ...opts, runsInWidget: true });
  await t.run("main")();
  return { t, text: widgetTexts(t) };
}

test("widget: all-failed, partial and confirmed zero are visibly different with full labels", async () => {
  const failed = await renderWidget({ mem: members({ alice: { pw: "x" }, bob: { pw: "y" } }) });
  assert.match(failed.text, /⚠️ 조회 실패/);
  assert.match(failed.text, /엄마 김하나: 로그인 실패/);
  assert.match(failed.text, /아빠 이두리: 로그인 실패/);
  assert.doesNotMatch(failed.text, /총 0권|조회 완료/);

  const partial = await renderWidget({ mem: members({ bob: { pw: "y" } }) });
  assert.match(partial.text, /일부만 확인/);
  assert.match(partial.text, /아빠 이두리: 로그인 실패/);
  assert.match(partial.text, /엄마 김하나: A 책 1/);

  const listPartial = await renderWidget({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === DOO_PATH ? { status: 500, body: "" } : null) } });
  assert.match(listPartial.text, /일부만 확인/);
  assert.match(listPartial.text, /엄마 김하나: 일부만 확인 - 상호대차 목록/);

  const zero = await renderWidget({ mem: members({ alice: { loans: [] }, bob: { loans: [] } }) });
  assert.match(zero.text, /✓ 조회 완료/);
  assert.match(zero.text, /현재 이용 중인 도서가 없습니다/);
  assert.doesNotMatch(zero.text, /실패|일부/);
});

test("HTML: escaped labels and warnings, no cookies/member IDs/passwords, clear status text", async () => {
  const evil = { ...A, label: `<img src=x onerror=alert(1)>` };
  const t = setup({ accounts: [evil, B], mem: members({ alice: { loans: [{ title: "<b>책</b>" }, { title: "<b>책</b>" }] }, bob: { pw: "wrong" } }) });
  const data = await t.fetchAll();
  const html = t.run("buildHtmlPage")(data);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<b>책<\/b>/);
  assert.match(html, /warn-box/);
  assert.match(html, /일부 계정·목록만 확인됨/);
  assert.match(html, /조회 오류: 로그인 실패/);
  for (const secret of [...t.lib.issued, "11110001", "22220002", A.pw, B.pw, "JSESSIONID"]) {
    assert.ok(!html.includes(secret), `rendered HTML must not contain ${secret}`);
  }
  for (const line of t.env.log.console) for (const s of t.lib.issued) assert.ok(!line.includes(s));

  const allFailed = t.run("buildHtmlPage")([data[1]]);
  assert.match(allFailed, /모두 조회 실패/);
  assert.doesNotMatch(allFailed, /총 0권/);

  const zero = setup({ mem: members({ alice: { loans: [] }, bob: { loans: [] } }) });
  const zeroHtml = zero.run("buildHtmlPage")(await zero.fetchAll());
  assert.match(zeroHtml, /현재 이용 중인 도서 없음 \(조회 완료\)/);
});

// ================================================================ 실행 겹침 (권고용 잠금)
test("overlapping invocations: the second one backs off; lease released afterwards", async () => {
  const t = setup();
  const main = t.run("main");
  await Promise.all([main(), main()]);
  assert.equal(t.env.log.html.length, 2);
  const busy = t.env.log.html.filter((h) => h.includes("다른 실행이 조회 중"));
  assert.equal(busy.length, 1);
  assert.ok(t.env.log.html.some((h) => h.includes("A 책 1")));
  assert.equal(t.env.files.has(LEASE), false);
});

test("expired lease is taken over; a live foreign lease is respected and left intact", async () => {
  const expired = setup({ files: { [LEASE]: JSON.stringify({ owner: "old", expiresAt: Date.now() - 1000 }) } });
  await expired.run("main")();
  assert.ok(expired.env.log.html[0].includes("A 책 1"));
  assert.equal(expired.env.files.has(LEASE), false);

  // 명시적 탈취 확인: 만료/깨진 잠금 위에 우리 owner로 새로 쓰고, 조회 중에는 그 owner가 파일에 있어야 한다
  for (const stale of [JSON.stringify({ owner: "old", expiresAt: Date.now() - 1000 }), "{not json"]) {
    let during = null;
    let tk;
    tk = setup({
      accounts: [A],
      files: { [LEASE]: stale },
      opts: { override: (req, ctx) => { if (ctx.path === LOAN_PATH && during === null) during = JSON.parse(tk.env.files.get(LEASE)); return null; } }
    });
    await tk.run("main")();
    assert.ok(during && during.owner !== "old" && during.expiresAt > Date.now(), "lease was taken over by this run");
    assert.ok(tk.env.log.html[0].includes("A 책 1"));
    assert.equal(tk.env.files.has(LEASE), false);
  }

  const foreign = JSON.stringify({ owner: "other", expiresAt: Date.now() + 60000 });
  const live = setup({ files: { [LEASE]: foreign } });
  await live.run("main")();
  assert.match(live.env.log.html[0], /다른 실행이 조회 중/);
  assert.equal(live.env.files.get(LEASE), foreign);
  assert.equal(requestsFor(live, "/intro").length, 0);
});

test("release only removes our own lease (owner check)", async () => {
  let t;
  t = setup({
    opts: {
      override: (req, ctx) => {
        if (ctx.path === LOAN_PATH) t.env.files.set(LEASE, JSON.stringify({ owner: "intruder", expiresAt: Date.now() + 60000 }));
        return null;
      }
    }
  });
  await t.run("main")();
  assert.equal(JSON.parse(t.env.files.get(LEASE)).owner, "intruder");
  // 관측된 잠금 탈취: 결과를 화면에 쓰지 않는다
  assert.match(t.env.log.html[0], /다른 실행이 실행 표시\(잠금\)를 가져가/);
  assert.ok(!t.env.log.html[0].includes("A 책 1"));
});

test("lease is released on network failure and on unexpected exceptions", async () => {
  const offline = createEnv({ keychain: { SPLIB_ACCOUNTS: JSON.stringify([A]) } });
  const run = loadScript(TRACKER, offline.globals);
  await run("main")();
  assert.match(offline.log.html[0], /모두 조회 실패/);
  assert.equal(offline.files.has(LEASE), false);

  const t = setup();
  t.run("fetchAllAccounts = async () => { throw new Error('boom'); }");
  await assert.rejects(t.run("main")(), /boom/);
  assert.equal(t.env.files.has(LEASE), false);

  const r = setup();
  r.env.failLoadHTML = true;
  await assert.rejects(r.run("main")(), /render failed/);
  assert.equal(r.env.files.has(LEASE), false);
});

// ================================================================ 계정 설정 스크립트
function accountsScript(stored) {
  const env = createEnv({ keychain: stored ? { SPLIB_ACCOUNTS: JSON.stringify(stored) } : {} });
  const run = loadScript(ACCOUNTS, env.globals);
  const saved = () => (env.keychain.has("SPLIB_ACCOUNTS") ? JSON.parse(env.keychain.get("SPLIB_ACCOUNTS")) : []);
  return { env, run, saved };
}

test("member ID normalization is identical in both scripts", () => {
  const tr = loadScript(TRACKER, createEnv().globals)("normalizeMemberId");
  const ac = accountsScript().run("normalizeMemberId");
  for (const v of ["1111-0001", " ab12 34 ", "12", "가나다라", "", null, undefined, "A".repeat(33), "Z9Z9"]) {
    assert.equal(ac(v), tr(v), String(v));
  }
});

test("setup: new account requires a manually entered member ID; add flow stores it", async () => {
  const s = accountsScript();
  const r = plain(s.run("mergeAccount")([], { label: "엄마", id: "alice", pw: "pw1" }));
  assert.equal(r.ok, false);
  assert.match(r.message, /회원번호를 입력/);

  s.env.alertScript.push(
    { choice: 0 },
    { choice: 0, fields: ["엄마", "alice", "pw1", "1111-0001", "김하나"] },
    { choice: 0 },
    { choice: -1 }
  );
  await s.run("main")();
  assert.deepEqual(s.saved(), [{ label: "엄마", id: "alice", pw: "pw1", memberId: "11110001", siteName: "김하나" }]);
});

test("setup: password/label update preserves the existing identity", async () => {
  const stored = [{ label: "엄마", id: "alice", pw: "pw1", memberId: "11110001", siteName: "김하나" }];
  const viaAdd = accountsScript(stored);
  viaAdd.env.alertScript.push({ choice: 0 }, { choice: 0, fields: ["엄마(새)", "alice", "pw2", "", ""] }, { choice: 0 }, { choice: -1 });
  await viaAdd.run("main")();
  assert.deepEqual(viaAdd.saved(), [{ label: "엄마(새)", id: "alice", pw: "pw2", memberId: "11110001", siteName: "김하나" }]);

  const viaEdit = accountsScript(stored);
  viaEdit.env.alertScript.push({ choice: 1 }, { choice: 0 }, { choice: 0, fields: [undefined, "", undefined, undefined] }, { choice: 0 }, { choice: -1 });
  await viaEdit.run("main")();
  assert.deepEqual(viaEdit.saved(), stored);
});

test("setup: legacy account gets identity via edit; duplicates rejected; '-' clears site name", async () => {
  const legacy = accountsScript([{ label: "예전", id: "carol", pw: "pwc" }, { label: "엄마", id: "alice", pw: "pw1", memberId: "11110001" }]);
  legacy.env.alertScript.push({ choice: 1 }, { choice: 0 }, { choice: 0, fields: [undefined, "", "33330003", ""] }, { choice: 0 }, { choice: -1 });
  await legacy.run("main")();
  assert.equal(legacy.saved()[0].memberId, "33330003");
  assert.equal(legacy.saved()[0].pw, "pwc");
  assert.match(legacy.env.log.alerts[0].message, /회원번호 미설정/);

  const merge = legacy.run("mergeAccount");
  const accs = legacy.saved();
  const dup = plain(merge(accs, { id: "carol", memberId: "1111 0001" }));
  assert.equal(dup.ok, false);
  assert.match(dup.message, /이미 등록/);
  const withSite = plain(merge(accs, { id: "alice", siteName: "김하나" })).accounts;
  assert.equal(withSite[1].siteName, "김하나");
  assert.equal(plain(merge(withSite, { id: "alice", siteName: "-" })).accounts[1].siteName, undefined);
  assert.equal(plain(merge(accs, { id: "alice", memberId: "12" })).ok, false);
});

test("setup: adding a trusted member ID to a legacy account keeps password/label/site name; padded legacy id is matched safely", () => {
  const s = accountsScript();
  const merge = s.run("mergeAccount");
  const legacy = [{ label: "예전", id: " carol ", pw: "pwc", siteName: "박세번" }];
  const r = plain(merge(legacy, { id: "carol", memberId: "3333-0003" }));
  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.deepEqual(r.accounts, [{ label: "예전", id: "carol", pw: "pwc", siteName: "박세번", memberId: "33330003" }]);
  assert.deepEqual(legacy[0], { label: "예전", id: " carol ", pw: "pwc", siteName: "박세번" }, "input array is not mutated");

  const twins = [{ label: "a", id: "carol", pw: "x" }, { label: "b", id: "carol ", pw: "y" }];
  const amb = plain(merge(twins, { id: "carol", memberId: "33330003" }));
  assert.equal(amb.ok, false);
});

test("update alert flags the manual songpa-accounts.js migration for v1.2", async () => {
  const env = createEnv({ handler: async () => ({ body: 'const SCRIPT_VERSION = "1.3.0";' }) });
  const run = loadScript(TRACKER, env.globals);
  await run("checkUpdateIfNeeded")();
  assert.match(env.log.alerts[0].message, /songpa-accounts\.js/);
  assert.ok(env.log.alerts[0].message.includes(run("ACCOUNTS_SOURCE_URL")));
});

// ================================================================ 추가 검증: 도서관 범위 식별자
test("cross-library loans with the same local regNo are both kept", async () => {
  const loans = [
    { title: "같은 제목", loanKey: "LX-1", lib: "Library X", regNo: "LOCAL001" },
    { title: "같은 제목", loanKey: "LY-2", lib: "Library Y", regNo: "LOCAL001" }
  ];
  const t = setup({ mem: members({ alice: { loans } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(a.items.length, 2);
  assert.equal(a.loanCount, 2);
  assert.deepEqual(a.items.map((i) => i.lib).sort(), ["Library X", "Library Y"]);
  assert.deepEqual(a.warnings, []);
});

test("cross-library join is forbidden: same regNo but different providing library stays separate", async () => {
  const t = setup({
    mem: members({
      alice: {
        loans: [{ title: "같은 제목", loanKey: "LX-1", lib: "Library X", regNo: "LOCAL001" }],
        doo: [{ title: "같은 제목", status: "발송", illKey: "IY-1", regNo: "LOCAL001", providing: "Library Y", receiving: "Library Z" }]
      }
    }),
    accounts: [A]
  });
  const [a] = await t.fetchAll();
  assert.equal(a.items.length, 2);
  const loan = a.items.find((i) => i.statusType === "대출중");
  assert.equal(loan.lib, "Library X", "return location not moved by an unrelated library's request");
  assert.equal(loan.isInter, false);
  assert.equal(a.transitCount, 1);
});

test("conflicting IDs and ambiguous history are preserved and warned (partial), never merged or relocated", async () => {
  const t = setup({
    mem: members({
      alice: {
        loans: [
          { title: "충돌", loanKey: "L1", regNo: "R001" },
          { title: "충돌", loanKey: "L2", regNo: "R001" },
          { title: "두 신청", loanKey: "L3", regNo: "R009" },
          { title: "이력", loanKey: "HL1", regNo: "H001", lib: "송파거마도서관", booksole: true }
        ],
        doo: [
          { title: "두 신청", status: "발송", illKey: "I1", regNo: "R009", providing: "송파글마루도서관" },
          { title: "두 신청", status: "입수", illKey: "I2", regNo: "R009", providing: "송파글마루도서관" },
          { title: "이력", status: "완료", illKey: "X1", regNo: "H001", providing: "송파위례도서관", receiving: "송파소나무언덕2호도서관" },
          { title: "이력", status: "완료", illKey: "X2", regNo: "H001", providing: "송파위례도서관", receiving: "송파글마루도서관" }
        ]
      }
    }),
    accounts: [A]
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.items.length, 6);
  assert.equal(a.loanCount, 4);
  assert.equal(a.pickupCount, 1);
  assert.equal(a.transitCount, 1);
  assert.equal(a.items.filter((i) => i.title === "충돌").length, 2);
  assert.equal(a.items.find((i) => i.title === "이력").lib, "송파거마도서관", "inactive history does not move the return location");
  assert.ok(a.warnings.some((w) => /합치지 않고/.test(w)));
  assert.ok(a.warnings.some((w) => /연결하지 않고/.test(w)));
});

test("conflict fixture rows really parse non-null scoped copy IDs (short IDs like R1 would not)", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const loan = plain(run("parseLoanRow")(loanRow({ title: "충돌", loanKey: "L1", regNo: "R001" })));
  assert.equal(loan.ids.copy, "R001");
  assert.equal(loan.scoped.copy, "송파글마루도서관#R001");
  const doo = plain(run("parseDooraeRow")(dooRow({ title: "두 신청", status: "발송", illKey: "I1", regNo: "R009", providing: "송파글마루도서관" })));
  assert.equal(doo.scoped.copy, "송파글마루도서관#R009");
  assert.equal(plain(run("parseLoanRow")(loanRow({ title: "짧음", regNo: "R1" }))).ids.copy, null, "documents why the old fixture never hit the conflict path");
});

// ================================================================ 추가 검증: 페이지 전체 신원
test("list page identity is read from the whole page: trailing B identity after rows is rejected", async () => {
  const footerB = (ctx, extra) => listPage(ctx.member, books("A", 2).map(loanRow).join("\n"), "loan") + extra;
  for (const extra of [`<footer>${barcodeInfo({ name: "김하나", memberId: "22220002" })}</footer>`, `<aside><input type="hidden" name="memberNo" value="22220002"></aside>`]) {
    const t = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.member ? { status: 200, body: footerB(ctx, extra) } : null) } });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error");
    assert.match(a.error, /대출 목록 1페이지.*둘 이상/);
    assert.equal(a.items.length, 0);
  }

  // 대조군: 회원번호가 목록 아래쪽(사이드바)에만 있어도 같은 회원이면 인정
  const onlyFooter = setup({
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.member && ctx.page === 1 ? { status: 200, body: listPage(null, books("A", 2).map(loanRow).join("\n"), "loan", false) + `<aside>${barcodeInfo(ctx.member)}</aside>` } : null) }
  });
  const [o] = await onlyFooter.fetchAll();
  assert.equal(o.status, "ok", String(o.error));
  assert.equal(o.items.length, 2);
});

// ================================================================ 추가 검증: 응답 쿠키 교체
test("authenticated responses that rotate or delete JSESSIONID are rejected even with a matching member ID", async () => {
  const rotations = ["JSESSIONID=ROTATED00001XYZ; Path=/", "JSESSIONID=; Max-Age=0; Path=/", "JSESSIONID=a<b>; Path=/"];
  for (const where of [LOAN_PATH, "/intro/index.do"]) {
    for (const setCookie of rotations) {
      const t = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === where && ctx.member ? { status: 200, body: where === LOAN_PATH ? listHtml("loan", ctx.member, ctx.page) : indexHtml(ctx.member, ctx.userId), headers: { "Set-Cookie": setCookie } } : null) } });
      const [a] = await t.fetchAll();
      assert.equal(a.status, "error", `${where} ${setCookie}`);
      assert.match(a.error, /세션 쿠키/);
      assert.equal(a.items.length, 0);
    }
    const viaCookies = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === where && ctx.member ? { status: 200, body: where === LOAN_PATH ? listHtml("loan", ctx.member, ctx.page) : indexHtml(ctx.member, ctx.userId), cookies: [{ name: "JSESSIONID", value: "OTHERSESS0001", domain: "splib.or.kr" }] } : null) } });
    const [c] = await viaCookies.fetchAll();
    assert.equal(c.status, "error");
    assert.match(c.error, /세션 쿠키/);

    // 대조군: 같은 값을 다시 내려보내는 것은 정상
    const same = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === where && ctx.member ? { status: 200, body: where === LOAN_PATH ? listHtml("loan", ctx.member, ctx.page) : indexHtml(ctx.member, ctx.userId), headers: { "Set-Cookie": `JSESSIONID=${ctx.sid}; Path=/` } } : null) } });
    const [s] = await same.fetchAll();
    assert.equal(s.status, "ok");
    assert.equal(s.items.length, 2);
  }
  // 대조군: 새 쿠키가 없는 일반 응답 (기본 서버)
  const none = setup({ accounts: [A] });
  const [n] = await none.fetchAll();
  assert.equal(n.status, "ok");
});

// ================================================================ 추가 검증: 상호대차 상태 문구
test("doorae status: cancel-action suffix is removed conservatively", () => {
  const parse = loadScript(TRACKER, createEnv().globals)("parseDooraeRow");
  const st = (cell) => plain(parse(`<div class="title">책</div><span>수령도서관 : 송파거마도서관</span><div class="statusBox">${cell}</div>`));
  const cases = [
    ["요청중신청취소", "요청중", true],
    ["요청중 <a href=\"#\">신청취소</a>", "요청중", true],
    ["요청중 <button>신청취소</button>", "요청중", true],
    ["신청중 신청취소", "신청중", true],
    ["입수", "입수", true],
    ["발송", "발송", true],
    ["복귀중", "복귀중", false],
    ["완료", "완료", false],
    ["신청취소", "신청취소", false]
  ];
  for (const [cell, status, active] of cases) {
    const r = st(cell);
    assert.equal(r.status, status, cell);
    assert.equal(r.isActive, active, cell);
    assert.equal(r.isKnownStatus, true, cell);
  }
  const u = st("입수취소");
  assert.equal(u.status, "입수취소");
  assert.equal(u.isKnownStatus, false);
});

// ================================================================ 추가 검증: div/li 행, 제목 없는 이력
test("div and li row wrappers parse identically", async () => {
  const doo = [{ title: "픽업 책", status: "입수", illKey: "P1", regNo: "P001" }, { title: "이동 책", status: "발송", illKey: "P2" }];
  const asLi = (html) => html.replace(/^<div class="myArticle-list">/, '<li class="myArticle-list">').replace(/<\/div>\s*$/, "</li>");
  const run = async (wrap) => {
    const t = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === DOO_PATH && ctx.member && ctx.page === 1 ? { status: 200, body: listPage(ctx.member, `<ul>${doo.map(dooRow).map(wrap).join("\n")}</ul>`, "doo") } : null) } });
    return (await t.fetchAll())[0];
  };
  const d = await run((x) => x);
  const l = await run(asLi);
  assert.equal(d.status, "ok");
  assert.equal(l.status, "ok");
  assert.equal(l.pickupCount, 1);
  assert.equal(l.transitCount, 1);
  assert.deepEqual(l.items, d.items);
});

test("titleless known-inactive history row is skipped; titleless active or status-less rows are partial", async () => {
  const pickup = dooRow({ title: "픽업 책", status: "입수", illKey: "P1" });
  const page = (extra) => (req, ctx) => (ctx.path === DOO_PATH && ctx.member && ctx.page === 1 ? { status: 200, body: listPage(ctx.member, `<ul>${extra}</ul>\n${pickup}`, "doo") } : null);
  const history = `<li class="myArticle-list"><div class="statusBox">복귀중</div></li>`;
  const ok = setup({ accounts: [A], opts: { override: page(history) } });
  const [o] = await ok.fetchAll();
  assert.equal(o.status, "ok");
  assert.equal(o.pickupCount, 1);
  assert.equal(o.items.find((i) => i.statusType === "픽업필요").title, "픽업 책");

  for (const bad of [`<li class="myArticle-list"><div class="statusBox">입수</div></li>`, `<li class="myArticle-list"><div class="title">상태 없음</div></li>`]) {
    const t = setup({ accounts: [A], opts: { override: page(bad) } });
    const [p] = await t.fetchAll();
    assert.equal(p.status, "partial", bad);
    assert.equal(p.dooComplete, false);
    assert.ok(p.warnings.some((w) => /형식을 알 수 없는 항목/.test(w)));
  }
});

// ================================================================ 추가 검증: 상호대차 도서관 표기 두 형태
test("doorae parser reads library labels inside and outside the label span (spacing/entities)", () => {
  const parse = loadScript(TRACKER, createEnv().globals)("parseDooraeRow");
  const inside = plain(parse(`<div class="title">안쪽</div><p><span>수령도서관 : Library X</span><span>제공도서관 : Library Y</span></p><div class="statusBox">입수</div>`));
  assert.equal(inside.receiving, "Library X");
  assert.equal(inside.providing, "Library Y");
  const outside = plain(parse(`<div class="title">바깥</div><p><span class="tit">제공도서관 : </span>송파위례도서관\n </p><p><span class="tit">수령도서관 :</span> 송파거마도서관</p><div class="statusBox">발송</div>`));
  assert.equal(outside.providing, "송파위례도서관");
  assert.equal(outside.receiving, "송파거마도서관");
  const entity = plain(parse(`<div class="title">엔티티</div><span>수령도서관&nbsp;:&nbsp;송파&amp;거마</span><span>제공 도서관</span> : 위례<div class="statusBox">입수</div>`));
  assert.equal(entity.receiving, "송파&거마");
  assert.equal(entity.providing, "위례");
});

test("inside-span pickup routes correctly; active request without receiving library is partial with a warning", async () => {
  const rows = [
    `<div class="myArticle-list"><input type="hidden" name="illKey" value="IN1"><div class="title">안쪽 책</div><p><span>수령도서관 : Library X</span><span>제공도서관 : Library Y</span></p><div class="statusBox">입수</div></div>`,
    `<div class="myArticle-list"><input type="hidden" name="illKey" value="IN2"><div class="title">수령처 없음</div><p><span>제공도서관 : Library Y</span></p><div class="statusBox">발송</div></div>`
  ].join("\n");
  const t = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === DOO_PATH ? { status: 200, body: listPage(ctx.member, rows, "doo") } : null) } });
  const [a] = await t.fetchAll();
  const pickup = a.items.find((i) => i.title === "안쪽 책");
  assert.equal(pickup.statusType, "픽업필요");
  assert.equal(pickup.lib, "Library X");
  assert.equal(pickup.provLib, "Library Y");
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /수령도서관을 확인하지 못한/.test(w)));
  assert.equal(a.items.find((i) => i.title === "수령처 없음").lib, "수령도서관 미확인");
});

// ================================================================ 추가 검증: 데이터 품질 불확실성은 0권 확정이 아님
test("unknown doorae status with zero loans is partial and visible in widget and HTML (not a confirmed zero)", async () => {
  const mem = members({ alice: { loans: [], doo: [{ title: "보류 책", status: "보류", illKey: "Q1" }] } });
  const t = setup({ mem, accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.items.length, 0);
  assert.ok(a.warnings.some((w) => /알 수 없는 상호대차 상태/.test(w)));

  const { text } = await renderWidget({ mem, accounts: [A] });
  assert.match(text, /일부만 확인/);
  assert.match(text, /알 수 없는 상호대차 상태/);
  assert.doesNotMatch(text, /✓ 조회 완료|현재 이용 중인 도서가 없습니다/);

  const html = t.run("buildHtmlPage")([a]);
  assert.match(html, /알 수 없는 상호대차 상태/);
  assert.match(html, /일부 계정·목록만 확인됨/);
  assert.doesNotMatch(html, /조회 완료/);
});

test("idless duplicate-looking doorae rows are all kept and flagged partial", async () => {
  const t = setup({ mem: members({ alice: { loans: [], doo: [{ title: "같은 신청", status: "입수" }, { title: "같은 신청", status: "입수" }] } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.items.length, 2);
  assert.equal(a.pickupCount, 2);
  assert.equal(a.status, "partial");
  assert.ok(a.warnings.some((w) => /같은 신청인지/.test(w)));
});

test("idless loan duplicates make the widget show the warning", async () => {
  const { text } = await renderWidget({ accounts: [A], mem: members({ alice: { loans: [{ title: "같은 책" }, { title: "같은 책" }] } }) });
  assert.match(text, /일부만 확인/);
  assert.match(text, /식별번호가 없어/);
});

// ================================================================ 추가 검증: 날짜·시간 예산
test("impossible calendar due dates are rejected, not rolled into another month", async () => {
  const parse = loadScript(TRACKER, createEnv().globals)("parseLoanRow");
  const row = (d) => `<div class="title">책</div><span>반납예정일 : ${d}</span>`;
  assert.equal(parse(row("2026.02.30")), null);
  assert.equal(parse(row("2026.13.01")), null);
  assert.equal(parse(row("2026.04.31")), null);
  assert.notEqual(parse(row("2028.02.29")), null);

  const t = setup({ mem: members({ alice: { loans: [{ title: "이상한 날짜", loanKey: "B1", due: "2026.02.30" }] } }), accounts: [A] });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "partial");
  assert.equal(a.loanComplete, false);
  assert.equal(a.items.length, 0);
});

test("request timeouts are capped to the remaining budget; no list call starts after the deadline", async () => {
  const t = setup({ accounts: [A] });
  await t.run("fetchAllAccounts")([A], 3000);
  const reqs = t.env.log.requests.filter((r) => r.url.startsWith(BASE));
  assert.ok(reqs.length >= 4);
  for (const r of reqs) assert.ok(r.timeout > 0 && r.timeout <= 3, `timeout ${r.timeout} for ${r.url}`);

  let late;
  late = setup({
    accounts: [A],
    opts: {
      override: (req, ctx) => {
        if (ctx.path === LOAN_PATH) late.run("clock").now = () => Date.now() + 1e9;
        return null;
      }
    }
  });
  const [d] = await late.fetchAll();
  assert.equal(d.status, "partial");
  assert.equal(requestsFor(late, DOO_PATH).length, 0);
  assert.ok(d.warnings.some((w) => /상호대차 목록: 시간 제한/.test(w)));
});

test("bold text inside the title is not used as the loan library scope", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = run("parseLoanRow");
  const build = run("buildMemberBooks");
  const row = (lib) =>
    `<div class="title"><strong>Same Title</strong></div>${lib}` +
    `<input type="hidden" name="loanKey" value="L1"><span>반납예정일 : 2026.05.01</span>`;

  const x = parse(row(`<strong class="lib"><span>Library X</span></strong>`));
  const y = parse(row(`<strong>Library Y</strong>`));
  assert.equal(x.rawLib, "Library X");
  assert.equal(y.rawLib, "Library Y");
  assert.notEqual(x.scoped.loan, y.scoped.loan);
  const both = build([x, y], [], "u", { loanPages: 1, dooPages: 1 });
  assert.equal(both.items.length, 2);
  assert.deepEqual(plain(both.items.map((i) => i.lib).sort()),["Library X", "Library Y"]);

  const none = parse(row(""));
  assert.equal(none.rawLib, "");
  assert.equal(none.scoped.loan, null);
  const r = build([none, parse(row(""))], [], "u", { loanPages: 1, dooPages: 1 });
  assert.equal(r.items.length, 2);
  assert.equal(r.uncertain, true);
  assert.ok(r.warnings.some((w) => /도서관을 확인하지 못한 대출/.test(w)));
});
