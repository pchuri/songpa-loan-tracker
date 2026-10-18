// Scriptable 스크립트 테스트 (node --test tests/scriptable.test.mjs)
// 실제 네트워크·키체인·iCloud를 쓰지 않는다. Request/FileManager/Keychain/Alert/위젯은 모두 합성 모의 객체다.
// 스크립트 끝의 진입점(await main(); Script.complete();)만 제거하고 VM에서 그대로 실행한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER = path.join(ROOT, "scriptable", "songpa-loan-tracker.js");
const ACCOUNTS = path.join(ROOT, "scriptable", "songpa-accounts.js");
const BASE = "https://splib.or.kr";
const LOGIN = `${BASE}/intro/program/memberLoginProc.do`;
const LOAN_PATH = "/intro/program/mypage/loanStatusList.do";
const DOO_PATH = "/intro/program/mypage/dooraeLillStatusList.do";
const LEASE = "/local/Library/songpa-loan-tracker.lease.json";
const PROFILE_PATH = "/intro/menu/10101/program/30045/memberModifyPwCheck.do";
const PROFILE_URL = `${BASE}${PROFILE_PATH}`;
const VKEY = "SPLIB_VERIFIED_MEMBERS_V1";
const BIND_LOCK = "/local/Library/songpa-verified-members.lock";
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
    writeString: (p, s) => env.files.set(p, String(s)), // Scriptable writeString은 덮어쓴다
    remove: (p) => env.files.delete(p),
    // Scriptable 문서의 copy 계약: 대상 파일이 이미 있으면 실패하고 복사하지 않는다 (writeString·move와 다름).
    // copyHook: 복사 직전에 실행 (다른 실행이 먼저 잠금을 만드는 경쟁을 흉내). failCopy: 원인과 무관한 복사 실패.
    copy: (src, dst) => {
      if (env.copyHook) env.copyHook(src, dst);
      if (env.failCopy) throw new Error("copy failed (synthetic)");
      if (!env.files.has(src)) throw new Error("source does not exist (synthetic)");
      if (env.files.has(dst)) throw new Error("destination exists (synthetic)");
      env.files.set(dst, env.files.get(src));
    }
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
      if (this.slot===undefined) {this.slot=log.html.length;log.html.push(h);} else log.html[this.slot]=h;
      (log.frames ||= []).push(h);
    }
    present() {return new Promise(resolve=>{this.close=resolve;});}
    async evaluateJavaScript(code) {
      const view=this;
      const body={set innerHTML(value){log.html[view.slot]=value;(log.frames ||= []).push(value);},setAttribute(name,value){if(name==="data-finished"&&value==="true") view.close();}};
      return vm.runInNewContext(code,{document:{body},window:{scrollY:0,scrollTo(){}}});
    }
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
    Timer: {schedule(ms,repeats,callback) {(log.timers ||= []).push(ms);const id=setTimeout(callback,ms===1500?0:ms);return {invalidate(){clearTimeout(id);}};}},
    WebView,
    Alert
  };
  return env;
}

// ---------------------------------------------------------------- 합성 도서관 서버
// 화면 구조는 테스트용으로 만든 것이며 실제 splib.or.kr 화면을 그대로 옮긴 것이 아니다.
// 관측된 최소 구조(값은 모두 지어낸 것)는 tests/fixtures/scriptable-identity/MANIFEST.json 에 적혀 있다.
const IDENTITY_MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "tests", "fixtures", "scriptable-identity", "MANIFEST.json"), "utf8"));
const SSO = IDENTITY_MANIFEST.logged_in_home;
const SSO_ACTION = `${SSO.action_origin}${SSO.action_path}`;
// 메인 화면의 전자책 SSO 폼 (합성). o로 이름·method·주소·안쪽을 바꿔 변형을 만든다. null이면 속성을 뺀다.
function ssoForm(values, o = {}) {
  const pick = (k, d) => (o[k] === undefined ? d : o[k]);
  const attrs = [["name", pick("name", SSO.form_name)], ["method", pick("method", "post")], ["action", pick("action", SSO_ACTION)]]
    .filter(([, v]) => v != null).map(([k, v]) => `${k}="${v}"`).join(" ");
  const inputs = o.inputs !== undefined ? o.inputs : SSO.input_names.map((n) => `<input type="hidden" name="${n}" value="${values[n]}">`).join("");
  return `<form ${attrs}>${inputs}${o.extra || ""}</form>`;
}
// m.plain: 실제 사이트에서 관측한 라벨 없는 형태 (div.barcodeInfo 안에 표시 이름 글자 + 직접 자식 span 하나)
// m.plain === "spanOnly": 표시 이름 글자 없이 span만 있는 최소 변형
function barcodeInfo(m) {
  if (m.plain === "spanOnly") return `<div class="barcodeInfo"><span>${m.memberId}</span></div>`;
  if (m.plain) return `<div class="barcodeInfo">${m.name}<span>${m.memberId}</span></div>`;
  return `<div class="barcodeInfo">${m.name} <span class="num">회원번호 : ${m.memberId}</span><img src="/barcode.do?t=1" alt=""></div>`;
}
function indexHtml(m, userId) {
  const sso = m.plain ? ssoForm({ id: userId, name: m.name }) : "";
  return `<html><body><header>${barcodeInfo(m)}${sso}<input type="hidden" name="userId" value="${userId}"><a href="/intro/memberLogout.do">로그아웃</a></header><main>홈</main></body></html>`;
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
// 회원정보 수정 전 비밀번호 확인 화면 (합성, 값은 지어낸 것). 관측된 최소 모양: hidden userId 하나, barcodeInfo 하나, 비밀번호 칸.
// 폼으로 감싸는지는 관측하지 않았으므로 감싸지 않는다. o.field로 userId 칸을, o.identity=false로 회원번호를, o.extra로 추가 내용을 바꾼다.
function profileHtml(m, userId, o = {}) {
  const field = o.field !== undefined ? o.field : `<input type="hidden" id="userId" name="userId" value="${userId}">`;
  return `<html><body><header>${o.identity === false || !m ? "" : barcodeInfo(m)}</header>` +
    `<main>${field}<input type="password" name="password" title="비밀번호">${o.extra || ""}</main></body></html>`;
}

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
    if (ctx.path === PROFILE_PATH) return { status: 200, body: profileHtml(ctx.member, ctx.userId) };
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

function setup({ mem = members(), accounts = [A, B], opts = {}, runsInWidget = false, files = {}, keychain = {} } = {}) {
  const lib = makeLibrary(mem, opts);
  const env = createEnv({ handler: lib.handler, runsInWidget, files, keychain: { SPLIB_ACCOUNTS: JSON.stringify(accounts), ...keychain } });
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

test("wrong first account is rejected; independently final-proven B keeps only its own rows", async () => {
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
  assert.equal(b.status, "ok");
  assert.equal(a.items.length,0);
  assert.deepEqual(titles(b),["B 책 1"]);
});

test("later failed account does not clear an earlier final-proven account", async () => {
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
  assert.equal(a.status, "ok");
  assert.deepEqual(titles(a),["A 책 1","A 책 2"]);
  assert.equal(b.items.length,0);
});

// (수정됨) 순차 실행에서 양쪽의 초기/최종 ID 증명과 모든 페이지 번호 대조가 완료되면 SID 문자열 재사용만으로 숨기지 않는다.
test("sequential SID reuse with fully verified distinct account snapshots keeps each account's own rows", async () => {
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
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
  assert.deepEqual(titles(b), ["B 책 1"]);
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

// (수정됨) v1.2에서는 회원번호 없는 계정을 접속 없이 실패시켰다. 이제 아이디·비밀번호만 있는 계정도 허용되므로
// 일반 로그인을 하되, 로그인에 실패하면 결과·첫 확인 기록 모두 없고 계정 목록은 그대로여야 한다.
test("ID/PW-only account that fails login: error, no verified binding, account records byte-identical", async () => {
  const legacy = { label: "예전 계정", id: "carol", pw: "pw-carol" };
  const t = setup({ accounts: [A, legacy] });
  const before = t.env.keychain.get("SPLIB_ACCOUNTS");
  const [a, c] = await t.fetchAll();
  assert.equal(a.status, "ok");
  assert.equal(c.status, "error");
  assert.match(c.error, /로그인 실패/);
  assert.equal(t.env.log.requests.filter((r) => String(r.body || "").includes("userId=carol")).length, 1, "one normal login only");
  assert.equal(requestsFor(t, PROFILE_PATH).length, 2, "only A's initial/final proof; no proof after a failed login");
  assert.equal(t.env.keychain.get("SPLIB_ACCOUNTS"), before);
  assert.equal(t.env.keychain.has(VKEY), false, "manual A is not cached; failed carol is never bound");
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

// (수정됨) v1.2에서는 새 계정에 회원번호가 필수였다. 이제 아이디·비밀번호만으로 저장할 수 있고, 입력한 회원번호는 검사 후 저장한다.
test("setup: ID/PW-only account is accepted without a member ID; an entered member ID is validated and stored", async () => {
  const s = accountsScript();
  const r = plain(s.run("mergeAccount")([], { label: "엄마", id: "alice", pw: "pw1" }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.accounts, [{ label: "엄마", id: "alice", pw: "pw1" }], "no memberId key is invented");
  assert.equal(plain(s.run("mergeAccount")([], { label: "엄마", id: "alice", pw: "pw1", memberId: "12" })).ok, false);
  assert.equal(plain(s.run("mergeAccount")([], { label: "엄마", id: "alice" })).ok, false, "password still required");

  const idOnlyFlow = accountsScript();
  idOnlyFlow.env.alertScript.push({ choice: 0 }, { choice: 0, fields: ["엄마", "alice", "pw1", "", ""] }, { choice: 0 }, { choice: -1 });
  await idOnlyFlow.run("main")();
  assert.deepEqual(idOnlyFlow.saved(), [{ label: "엄마", id: "alice", pw: "pw1" }]);
  assert.match(idOnlyFlow.env.log.alerts.at(-1).message, /회원번호 미설정 \(선택/);
  assert.equal(idOnlyFlow.env.keychain.has(VKEY), false, "setup script never touches the verified-member key");

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
  // (추가) 회원번호가 필수라는 예전 안내는 더 이상 하지 않는다
  assert.doesNotMatch(env.log.alerts[0].message, /회원번호가 필요/);
  assert.match(env.log.alerts[0].message, /회원번호는 선택/);
  assert.equal(env.log.requests.length, 1, "only the version check; no account or library request");
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

test("idless loan duplicates keep raw warnings/partial status but show no ID-only warning in widget or HTML", async () => {
  const dup = { title: "식별번호 없는 책", lib: "송파글마루도서관", due: "2099.09.09" };
  const t = setup({ accounts: [A], mem: members({ alice: { loans: [dup, { ...dup }] } }) });
  const [d] = await t.fetchAll();
  assert.equal(d.items.length, 2, "raw records kept");
  assert.equal(d.loanCount, 2);
  assert.equal(d.status, "partial", "raw data-quality status unchanged");
  assert.ok(d.warnings.some((w) => w.includes("식별번호가 없어")), "raw warning kept internally");
  assert.equal(d.displayWarnings.some((w) => w.includes("식별번호")), false);
  assert.ok(d.items.every((i) => i.qualityNotes.includes("중복 여부 미확정")), "raw notes kept internally");
  const html = t.run("buildHtmlPage")([d]);
  const body = html.slice(html.indexOf("<tbody>"));
  assert.equal(body.split('class="title-text">식별번호 없는 책<').length - 1, 2, "same-kind duplicates stay separate");
  assert.doesNotMatch(html, /class="warn-box"|중복 여부 미확정|중복 가능|일부만 확인/);
  const texts = (await t.run("createWidget")([d], null)).texts;
  assert.ok(texts.every((x) => !x.includes("식별번호가 없어") && !x.includes("⚠️") && !x.includes("중복 가능")));
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

// ================================================================ 관측 구조 호환: 라벨 없는 barcodeInfo span + 메인 화면 SSO 폼
// 구조만 관측값을 따르고, 회원번호·아이디·이름은 모두 지어낸 값이다.
const realMembers = (o = {}) => members({ alice: { plain: true, ...(o.alice || {}) }, bob: { plain: true, ...(o.bob || {}) } });
const LOGIN_FORM_ONLY = `<form action="/intro/program/memberLoginProc.do" method="post"><input type="text" name="userId"><input type="password" name="password"></form>`;

// (수정됨) 이전에는 회원정보 확인 화면을 쓰지 않는다는 것을 확인했다. 이번 변경에서 서버 주체 증명에 정확한 상수 주소 하나로만 쓴다.
test("fixture manifest matches the production SSO constants; the profile/password-check endpoint is one exact constant", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const f = plain(run("INDEX_SSO_FORM"));
  assert.equal(f.name, SSO.form_name);
  assert.equal(f.method, "post");
  assert.equal(f.action, SSO_ACTION);
  assert.deepEqual(f.inputs, SSO.input_names);
  assert.equal(SSO.member_selector, "div.barcodeInfo > span");
  assert.equal(run("PROFILE_PROOF_URL"), `${BASE}${IDENTITY_MANIFEST.profile_gate.path}`);
  assert.equal(PROFILE_PATH, IDENTITY_MANIFEST.profile_gate.path);
  const src = readFileSync(TRACKER, "utf8");
  assert.equal(src.split("memberModifyPwCheck").length - 1, 1, "endpoint appears only in the constant");
  assert.doesNotMatch(src, /memberModifyPwCheckProc|password=.*PROFILE/, "the password gate is never submitted");
});

test("real-shape A/B control: unlabelled barcodeInfo span on every page + homepage SSO form; each account sees only its own loans and ILL", async () => {
  const mem = realMembers({ alice: { loans: books("A", 12), doo: [{ title: "A 픽업 책", status: "입수", illKey: "AI1" }] } });
  const t = setup({ mem });
  // 합성 서버가 정말 관측 구조를 내보내는지: 라벨 없음, SSO 폼은 일반 로그인 검사에 걸리는 모양
  const home = indexHtml(mem.alice, "alice");
  assert.match(home, /<div class="barcodeInfo">김하나<span>11110001<\/span><\/div>/);
  assert.doesNotMatch(home + listHtml("loan", mem.alice, 1), /회원번호|바코드/);
  assert.equal(t.run("looksLikeLoginPage")(home), true, "generic heuristic alone still rejects the SSO homepage");

  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "ok", String(a.error));
  assert.equal(b.status, "ok", String(b.error));
  assert.equal(a.loanCount, 12);
  assert.equal(a.pickupCount, 1);
  assert.ok(titles(a).includes("A 픽업 책"));
  assert.ok(!titles(a).some((x) => x.startsWith("B ")));
  assert.deepEqual(titles(b), ["B 책 1"]);
  assertCookiePinned(t);
  assert.equal(requestsFor(t, "/intro/index.do").length, 4, "before/after homepage checks for both accounts");
  assert.ok(t.env.log.requests.every((r) => r.url.startsWith(`${BASE}/`)), "SSO form is never submitted; no other host contacted");
  // (수정됨) 이전에는 회원정보 확인 화면 요청이 없어야 했다. 이제 계정마다 처음·마지막 주체 증명 2회, 정확한 주소로 GET만 한다.
  const proofs = requestsFor(t, PROFILE_PATH);
  assert.equal(proofs.length, 4);
  for (const r of proofs) {
    assert.equal(r.url, PROFILE_URL);
    assert.equal(r.method, "GET");
    assert.equal(r.body, undefined);
  }
});

test("real-shape identity mismatches still fail closed: wrong first session, swapped member IDs, later collision, B on a loan page or ILL page", async () => {
  const toBob = (who) => (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") && req.body.includes(`userId=${who}`)
    ? { status: 302, location: "/intro/index.do", setSession: lib.newSession(who === "alice" ? "bob" : "alice") }
    : null);
  const wrong = setup({ mem: realMembers(), opts: { override: toBob("alice") } });
  const [a, b] = await wrong.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /다른 회원/);
  assert.equal(b.status, "ok");
  assert.equal(a.items.length,0);
  assert.deepEqual(titles(b),["B 책 1"]);

  const later = setup({ mem: realMembers(), opts: { override: toBob("bob") } });
  const [la, lb] = await later.fetchAll();
  assert.equal(la.status,"ok");
  assert.deepEqual(titles(la),["A 책 1","A 책 2"]);
  assert.equal(lb.status,"error");assert.equal(lb.items.length,0);

  const swapped = setup({ mem: realMembers(), accounts: [{ ...A, memberId: B.memberId }, { ...B, memberId: A.memberId }] });
  const [x, y] = await swapped.fetchAll();
  for (const r of [x, y]) {
    assert.equal(r.status, "error");
    assert.match(r.error, /다른 회원/);
    assert.equal(r.items.length, 0);
  }

  const mem = realMembers({ alice: { loans: books("A", 15), doo: [{ title: "A 픽업", status: "입수", illKey: "AI1" }] } });
  const loanDrift = setup({ mem, accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 2 ? { status: 200, body: listHtml("loan", { ...mem.bob, loans: books("A", 15) }, 2) } : null) } });
  const [l] = await loanDrift.fetchAll();
  assert.equal(l.status, "error");
  assert.match(l.error, /대출 목록 2페이지.*다른 회원/);
  assert.equal(l.items.length, 0);

  const illDrift = setup({ mem, accounts: [A], opts: { override: (req, ctx) => (ctx.path === DOO_PATH ? { status: 200, body: listHtml("doo", { ...mem.bob, doo: mem.alice.doo }, ctx.page) } : null) } });
  const [d] = await illDrift.fetchAll();
  assert.equal(d.status, "error");
  assert.match(d.error, /상호대차 목록 1페이지.*다른 회원/);
  assert.equal(d.items.length, 0, "already fetched loans are discarded too");
});

test("identity parser: observed unlabelled barcodeInfo span is recognized narrowly; ambiguous, malformed or out-of-block shapes are not guessed", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  const blk = (inner) => `<div class="barcodeInfo">${inner}</div>`;

  const ok = parse(`<header>${blk("<span>1111-0001</span>")}</header><input type="hidden" name="userId" value="alice01">` +
    `<input name="bookKey" value="99990009"><input name="regNo" value="99990009"><img src="/barcode.do?no=99990009"><span>99990009</span>`);
  assert.equal(ok.status, "ok");
  assert.equal(ok.memberId, "11110001");
  assert.deepEqual(ok.siteNames, []);
  assert.equal(parse(blk(`\n  <span class="num"> ab12cd34 </span>\n`)).memberId, "AB12CD34");
  assert.equal(parse(blk("<span>11110001</span>") + `<input type="hidden" name="memberNo" value="1111-0001">`).memberId, "11110001", "agreeing semantic field");
  // 관측 형태: 표시 이름 글자 + span 하나. 이름은 siteNames로만 쓰이고 회원번호로 쓰이지 않는다.
  const named = parse(`<header>${blk("김하나<span>11110001</span>")}</header>`);
  assert.equal(named.status, "ok");
  assert.equal(named.memberId, "11110001");
  assert.deepEqual(named.candidates, ["11110001"]);
  assert.deepEqual(named.siteNames, ["김하나"]);
  assert.equal(parse(blk("\n 김하나 님 \n<span class=\"num\">1111-0001</span>\n ")).memberId, "11110001", "prefix with spaces/class/trailing whitespace");
  const numericName = parse(blk("22220002<span>11110001</span>"));
  assert.equal(numericName.memberId, "11110001", "prefix text is never read as a member number");
  assert.deepEqual(numericName.candidates, ["11110001"]);
  assert.equal(parse(blk("김하나<span>11110001</span>") + `<input type="hidden" name="memberNo" value="1111-0001">`).memberId, "11110001", "prefixed span + agreeing semantic field");
  // 기존 라벨 형태는 그대로
  assert.equal(parse(blk(`김하나 <span class="num">회원번호 : 11110001</span><img src="/barcode.do?t=1" alt="">`)).memberId, "11110001");
  // script·style·template 안의 신원은 신원으로 고르지 않지만, 화면 신원과 충돌하면 거부한다
  const shielded = blk("<span>11110001</span>") + `<!-- ${blk("<span>22220002</span>")} -->` +
    `<script>var m = '<input name="memberNo" value="22220002">';</script><style>/* data-member-no="22220002" */</style>` +
    `<template><div data-member-no="22220002"></div>${blk("<span>22220002</span>")}</template>`;
  const sh = parse(shielded);
  assert.equal(sh.status, "ambiguous");
  assert.equal(sh.memberId, null);
  // 주석만 있는 경우는 기존대로 무시 (주석은 검사하지 않음)
  const commentOnly = parse(blk("<span>11110001</span>") + `<!-- ${blk("<span>22220002</span>")}<input name="memberNo" value="22220002"> -->`);
  assert.equal(commentOnly.status, "ok");
  assert.equal(commentOnly.memberId, "11110001");
  assert.deepEqual(commentOnly.candidates, ["11110001"]);

  const ambiguous = {
    "two identical spans": blk("<span>11110001</span><span>11110001</span>"),
    "two different spans": blk("<span>11110001</span><span>22220002</span>"),
    "two plain blocks with the same value": blk("<span>11110001</span>") + blk("<span>11110001</span>"),
    "plain block plus labelled block": blk("<span>11110001</span>") + blk("김하나 <span>회원번호 : 11110001</span>"),
    "nested barcodeInfo": blk(blk("<span>11110001</span>")),
    "span wrapped in another element": blk("<div><span>11110001</span></div>"),
    "nested tag inside span": blk("<span><b>11110001</b></span>"),
    "trailing text after span": blk("<span>11110001</span> 김하나"),
    "display name prefix plus trailing text": blk("김하나<span>11110001</span>님"),
    "extra element beside span": blk(`<span>11110001</span><img src="/barcode.do?t=1">`),
    "display name prefix plus trailing element": blk(`김하나<span>11110001</span><img src="/barcode.do?t=1">`),
    "leading element before span": blk("<b>김하나</b><span>11110001</span>"),
    "display name prefix plus two spans": blk("김하나<span>11110001</span><span>11110001</span>"),
    "display name prefix plus nested tag inside span": blk("김하나<span><b>11110001</b></span>"),
    "labelled prefix text conflicting with plain span": blk("회원번호 : 11110001<span>22220002</span>"),
    "labelled prefix text agreeing with plain span": blk("회원번호 : 11110001<span>11110001</span>"),
    "label word prefix with plain span": blk("회원번호<span>11110001</span>"),
    "plain span conflicting with semantic memberNo (prefixed)": blk("김하나<span>11110001</span>") + `<input type="hidden" name="memberNo" value="22220002">`,
    "semantic memberNo before conflicting prefixed plain span": `<input type="hidden" name="memberNo" value="22220002">` + blk("김하나<span>11110001</span>"),
    "plain span conflicting with data attribute (prefixed)": blk("김하나<span>11110001</span>") + `<div data-member-no="22220002"></div>`,
    "prefixed plain block plus labelled block": blk("김하나<span>11110001</span>") + blk("김하나 <span>회원번호 : 22220002</span>"),
    "spaced span value": blk("<span>11 110 001</span>"),
    "too short span value": blk("<span>12</span>"),
    "empty span": blk("<span></span>"),
    "unclosed block": `<div class="barcodeInfo"><span>11110001</span>`,
    "unclosed span": blk("<span>11110001"),
    "conflicting semantic member field": blk("<span>11110001</span>") + `<input type="hidden" name="memberNo" value="22220002">`,
    "conflicting data attribute in footer": blk("<span>11110001</span>") + `<footer data-member-barcode="22220002"></footer>`,
    "unclosed script": blk("<span>11110001</span>") + `<script>var x = 1;`,
    "unclosed template": blk("<span>11110001</span>") + `<template><span>x</span>`
  };
  for (const [name, html] of Object.entries(ambiguous)) {
    const p = parse(html);
    assert.equal(p.status, "ambiguous", name);
    assert.equal(p.memberId, null, name);
  }

  const missing = {
    "span outside any barcodeInfo": `<div class="memberInfo"><span>11110001</span></div><span>11110001</span>`,
    "bare text without span": blk("11110001"),
    "barcode image only": blk(`<img src="/barcode.do?no=11110001" alt="11110001">`),
    "name only": blk("김하나 님"),
    "generic ids only": `<input type="hidden" name="userId" value="11110001"><input name="id" value="11110001"><input name="regNo" value="11110001">`,
    "inside comment": `<!-- ${blk("<span>11110001</span>")} -->`,
    "inside script": `<script>document.write('${blk("<span>11110001</span>")}');</script>`,
    "inside style": `<style>/* ${blk("<span>11110001</span>")} */</style>`,
    "inside template": `<template>${blk("<span>11110001</span>")}<input name="memberNo" value="11110001"></template>`
  };
  for (const [name, html] of Object.entries(missing)) assert.equal(parse(html).status, "missing", name);
});

// ================================================================ 숨은 영역(script·style·template): 선택 제외 + 충돌 검사
test("identity parser: hidden script/style/template evidence never selects identity but conflicts are rejected", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  const blk = (inner) => `<div class="barcodeInfo">${inner}</div>`;
  const visA = blk("김하나<span>11110001</span>");
  const labelledA = blk(`김하나 <span class="num">회원번호 : 11110001</span>`);

  for (const [vname, vis] of [["plain", visA], ["labelled", labelledA]]) {
    const ambiguous = {
      "script with different memberNo": `<script>var h = '<input name="memberNo" value="22220002">';</script>`,
      "style with different data attribute": `<style>/* <i data-member-no="22220002"></i> */</style>`,
      "template with different memberNo": `<template><input type="hidden" name="memberNo" value="22220002"></template>`,
      "template barcodeInfo with different value": `<template>${blk("이두리<span>22220002</span>")}</template>`,
      "template barcodeInfo with the same value": `<template>${blk("김하나<span>11110001</span>")}</template>`,
      "script barcodeInfo with the same value": `<script>document.write('${blk("<span>11110001</span>")}');</script>`,
      "template with invalid memberNo": `<template><input name="memberNo" value="1!"></template>`,
      "template with unclosed barcodeInfo": `<template><div class="barcodeInfo"><span>11110001</span></template>`,
      "nested template": `<template><template>${blk("<span>11110001</span>")}</template></template>`,
      "script containing a script tag string": `<script>var s = "<script src=x>";</script>`,
      "uppercase TEMPLATE with different memberNo": `<TEMPLATE><input name="MEMBERNO" value="22220002"></TEMPLATE>`
    };
    for (const [name, hidden] of Object.entries(ambiguous)) {
      for (const html of [vis + hidden, hidden + vis]) {
        const p = parse(html);
        assert.equal(p.status, "ambiguous", `${vname}: ${name}`);
        assert.equal(p.memberId, null, `${vname}: ${name}`);
      }
    }
    // 같은 값의 숨은 회원 필드(블록 아님)는 충돌이 아니다
    const same = parse(vis + `<script>var h = '<input name="memberNo" value="1111-0001">';</script>`);
    assert.equal(same.status, "ok", vname);
    assert.deepEqual(same.candidates, ["11110001"], vname);
    // 신원과 무관한 숨은 내용은 영향 없음
    assert.equal(parse(vis + `<script>var x = 1;</script><style>.a{}</style><template><p>x</p></template>`).memberId, "11110001", vname);
  }

  // 숨은 영역만 있는 증거는 절대 신원으로 선택되지 않는다
  for (const hiddenOnly of [
    `<template>${blk("이두리<span>22220002</span>")}<input name="memberNo" value="22220002"></template>`,
    `<script>var h = '<input name="memberNo" value="22220002">';</script>`,
    `<style>/* <i data-member-no="22220002"></i> */</style>`
  ]) {
    const p = parse(hiddenOnly);
    assert.notEqual(p.status, "ok", hiddenOnly);
    assert.equal(p.memberId, null, hiddenOnly);
    assert.deepEqual(p.candidates, [], hiddenOnly);
  }
});

test("reproduction: visible A + template holding B identity and B loan row -> identity rejected even though the row parser sees B", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const html = `<div class="barcodeInfo">김하나<span>11110001</span></div>` +
    `<template><input type="hidden" name="memberNo" value="22220002">${loanRow({ title: "B 숨은 책", loanKey: "B-L9", regNo: "BR9" })}</template>`;
  const id = plain(run("parseIdentity")(html));
  assert.equal(id.status, "ambiguous");
  assert.equal(id.memberId, null);
  // 행 파서는 이번 작업에서 바꾸지 않았다: 신원 단계에서 막혀야 한다
  const rows = plain(run("parseListPage")(run("LISTS").loan, html));
  assert.deepEqual(rows.records.map((r) => r.title), ["B 숨은 책"]);
});

test("full flow: visible A with hidden B identity + B row on a list page is an error with zero records (plain and legacy labelled A)", async () => {
  const hiddenB = `<template><div class="barcodeInfo">이두리<span>22220002</span></div><input type="hidden" name="memberNo" value="22220002">` +
    `${loanRow({ title: "B 숨은 책", loanKey: "B-L9", regNo: "BR9" })}</template>`;
  for (const [name, mem] of [["plain", realMembers()], ["labelled", members()]]) {
    for (const where of [LOAN_PATH, DOO_PATH]) {
      const t = setup({
        mem,
        accounts: [A],
        opts: {
          override: (req, ctx) => {
            if (ctx.path !== where || !ctx.member) return null;
            const kind = where === LOAN_PATH ? "loan" : "doo";
            return { status: 200, body: listHtml(kind, ctx.member, ctx.page).replace("</body>", `${hiddenB}</body>`) };
          }
        }
      });
      const [a] = await t.fetchAll();
      assert.equal(a.status, "error", `${name} ${where}`);
      assert.match(a.error, /1페이지.*둘 이상/, `${name} ${where}`);
      assert.equal(a.items.length, 0, `${name} ${where}`);
      assert.equal(a.loanCount || 0, 0, `${name} ${where}`);
    }
    // 대조군: 숨은 영역이 없으면 같은 계정이 정상 조회된다
    const ok = setup({ mem, accounts: [A] });
    const [o] = await ok.fetchAll();
    assert.equal(o.status, "ok", `${name}: ${o.error}`);
  }
});

test("identity parser: supported legacy labelled variants and conservatively rejected label+plain span", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  const blk = (inner) => `<div class="barcodeInfo">${inner}</div>`;
  // 라벨과 값이 같은 span 안
  assert.equal(parse(blk(`김하나 <span class="num">회원번호 : 1111-0001</span>`)).memberId, "11110001");
  // 라벨과 값이 span 없이 일반 글자
  const text = parse(blk("김하나 회원번호 : 11110001"));
  assert.equal(text.status, "ok");
  assert.equal(text.memberId, "11110001");
  assert.deepEqual(text.siteNames, ["김하나"]);
  // 앞쪽 라벨 + 직접 자식 span(라벨 없는 값)은 값이 같아도 거부
  for (const html of [blk("회원번호 : 11110001<span>11110001</span>"), blk("김하나 바코드 : 11110001<span>11110001</span>")]) {
    assert.equal(parse(html).status, "ambiguous", html);
  }
});

test("homepage SSO exact form: harmless whitespace/newlines, uppercase METHOD and id/target attributes are accepted; '>' inside an attribute is not", () => {
  const unit = loadScript(TRACKER, createEnv().globals);
  const strip = unit("withoutIndexSsoForm");
  const looks = unit("looksLikeLoginPage");
  const inputs = `<input type="hidden" name="id" value="u1">\n  <input type="hidden" name="name" value="n1">`;
  const accepted = {
    "newlines and indentation": `<form\n  name="ebookForm"\n  method="post"\n  action="${SSO_ACTION}"\n>\n  ${inputs}\n</form>`,
    "uppercase METHOD attribute and value": `<form name="ebookForm" METHOD="POST" action="${SSO_ACTION}">${inputs}</form>`,
    "id and target attributes": `<form id="ebookForm" name="ebookForm" method="post" action="${SSO_ACTION}" target="_blank">${inputs}</form>`
  };
  for (const [name, form] of Object.entries(accepted)) {
    const html = `<div>${form}</div>`;
    assert.equal(looks(html), true, `${name}: generic heuristic still flags it`);
    assert.equal(looks(strip(html)), false, name);
  }
  const gt = `<div><form name="ebookForm" method="post" action="${SSO_ACTION}" title="a>b">${inputs}</form></div>`;
  assert.equal(looks(strip(gt)), true, "'>' inside an attribute value is not stripped");
});

// 회귀: 제공된 관측 구조 fixture(이름 글자 + span)를 수정 없이 그대로 읽는다
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "scriptable-identity");
const HOME_FIXTURE = readFileSync(path.join(FIXTURE_DIR, "authenticated-home.html"), "utf8");
const LIST_HEADER_FIXTURE = readFileSync(path.join(FIXTURE_DIR, "authenticated-list-header.html"), "utf8");

test("regression: unchanged authenticated-home.html / list-header fixtures (display name text before the span) parse as ok", () => {
  assert.ok(HOME_FIXTURE.includes(`<div class="barcodeInfo">Synthetic User<span>SYNTHETIC0001</span></div>`), "fixture is the supplied shape");
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  for (const [name, html] of [["home", HOME_FIXTURE], ["list header", LIST_HEADER_FIXTURE]]) {
    const p = parse(html);
    assert.equal(p.status, "ok", name);
    assert.equal(p.memberId, "SYNTHETIC0001", name);
    assert.deepEqual(p.candidates, ["SYNTHETIC0001"], name);
    assert.deepEqual(p.siteNames, ["Synthetic User"], name);
  }
  // 메인 화면 fixture는 정확한 SSO 폼 하나만 빼면 로그인 화면이 아니다
  assert.equal(run("looksLikeLoginPage")(HOME_FIXTURE), true);
  assert.equal(run("looksLikeLoginPage")(run("withoutIndexSsoForm")(HOME_FIXTURE)), false);
  // verifyIdentity: 맞는 회원번호·이름이면 통과, 이름 설정이 다르면 거부, 회원번호가 다르면 거부
  const verify = run("verifyIdentity");
  const parsed = run("parseIdentity")(HOME_FIXTURE);
  assert.equal(verify(parsed, { memberId: "SYNTHETIC0001", siteName: "Synthetic User" }, new Set(), "x", true), true);
  assert.equal(verify(parsed, { memberId: "SYNTHETIC0001" }, new Set(), "x", true), true);
  assert.throws(() => verify(parsed, { memberId: "SYNTHETIC0001", siteName: "Other Name" }, new Set(), "x", true), /다른 이름/);
  assert.throws(() => verify(parsed, { memberId: "SYNTHETIC0002" }, new Set(), "x", true), /다른 회원/);
});

test("regression: full flow with the unchanged home fixture as INDEX page succeeds with and without a siteName", async () => {
  const mem = { alice: { pw: A.pw, memberId: "SYNTHETIC0001", name: "Synthetic User", plain: true, loans: books("A", 2), doo: [] } };
  for (const acc of [{ ...A, memberId: "SYNTHETIC0001" }, { ...A, memberId: "SYNTHETIC0001", siteName: "Synthetic User" }]) {
    const t = setup({ mem, accounts: [acc], opts: { override: (req, ctx) => (ctx.path === "/intro/index.do" && ctx.member ? { status: 200, body: HOME_FIXTURE } : null) } });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "ok", String(a.error));
    assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
    assertCookiePinned(t);
  }
  const wrongName = setup({ mem, accounts: [{ ...A, memberId: "SYNTHETIC0001", siteName: "Other Name" }], opts: { override: (req, ctx) => (ctx.path === "/intro/index.do" && ctx.member ? { status: 200, body: HOME_FIXTURE } : null) } });
  const [w] = await wrongName.fetchAll();
  assert.equal(w.status, "error");
  assert.equal(w.items.length, 0);
});

test("real-shape span-only minimal variant still works; prefixed variant works with siteName", async () => {
  const spanOnly = setup({ mem: realMembers({ alice: { plain: "spanOnly" }, bob: { plain: "spanOnly" } }) });
  assert.match(indexHtml(spanOnly.lib.members.alice, "alice"), /<div class="barcodeInfo"><span>11110001<\/span><\/div>/);
  const [a, b] = await spanOnly.fetchAll();
  assert.equal(a.status, "ok", String(a.error));
  assert.equal(b.status, "ok", String(b.error));

  const named = setup({ mem: realMembers(), accounts: [{ ...A, siteName: "김하나" }, { ...B, siteName: "이두리" }] });
  const [x, y] = await named.fetchAll();
  assert.equal(x.status, "ok", String(x.error));
  assert.equal(y.status, "ok", String(y.error));
  assert.deepEqual(titles(y), ["B 책 1"]);
});

test("identity parser: SSO hidden id/name values are never member identity", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const parse = (h) => plain(run("parseIdentity")(h));
  assert.equal(parse(ssoForm({ id: "11110001", name: "22220002" })).status, "missing");
  assert.equal(parse(`<div class="barcodeInfo"><span>11110001</span></div>${ssoForm({ id: "33330003", name: "김하나" })}`).memberId, "11110001");
});

test("homepage SSO exemption is narrow: only one exact ebookForm on INDEX_URL; altered, duplicated or extra-credential variants are a login page", async () => {
  const unit = loadScript(TRACKER, createEnv().globals);
  const strip = unit("withoutIndexSsoForm");
  const looks = unit("looksLikeLoginPage");
  const exact = `<div>${ssoForm({ id: "u1", name: "n1" })}</div>`;
  assert.equal(looks(exact), true, "generic heuristic is unchanged");
  assert.equal(looks(LOGIN_FORM), true);
  assert.equal(looks(strip(exact)), false);
  assert.doesNotMatch(strip(exact), /ebookForm|u1|n1/);

  const vals = (ctx) => ({ id: ctx.userId, name: ctx.member.name });
  const indexWith = (forms) => setup({
    mem: realMembers(),
    accounts: [A],
    opts: { override: (req, ctx) => (ctx.path === "/intro/index.do" && ctx.member ? { status: 200, body: `<html><body><header>${barcodeInfo(ctx.member)}${forms(ctx)}</header></body></html>` } : null) }
  });

  const good = indexWith((ctx) => ssoForm(vals(ctx)));
  const [g] = await good.fetchAll();
  assert.equal(g.status, "ok", String(g.error));
  assert.equal(g.items.length, 2);

  const variants = {
    "query on action": { action: `${SSO_ACTION}?next=1` },
    "empty query on action": { action: `${SSO_ACTION}?` },
    "fragment on action": { action: `${SSO_ACTION}#x` },
    "http scheme": { action: SSO_ACTION.replace("https:", "http:") },
    "case-altered host": { action: SSO_ACTION.replace("ebook", "EBOOK") },
    "other origin": { action: "https://ebook.example.invalid/login_sso.asp" },
    "other path": { action: `${SSO.action_origin}/login_sso2.asp` },
    "relative action": { action: "/login_sso.asp" },
    "GET method": { method: "get" },
    "missing method": { method: null },
    "renamed form": { name: "loginForm" },
    "password inside": { extra: `<input type="password" name="pw" value="">` },
    "extra hidden input": { extra: `<input type="hidden" name="memberNo" value="11110001">` },
    "button inside": { extra: `<button type="submit">로그인</button>` },
    "visible id input": { inputs: `<input type="text" name="id" value="v"><input type="hidden" name="name" value="v">` },
    "empty hidden value": { inputs: `<input type="hidden" name="id" value=""><input type="hidden" name="name" value="v">` },
    "missing name input": { inputs: `<input type="hidden" name="id" value="v">` },
    "duplicate id input": { inputs: `<input type="hidden" name="id" value="v"><input type="hidden" name="id" value="w">` },
    "two exact SSO forms": (ctx) => ssoForm(vals(ctx)) + ssoForm(vals(ctx)),
    "commented copy plus exact SSO": (ctx) => `<!-- ${ssoForm(vals(ctx))} -->${ssoForm(vals(ctx))}`,
    "exact SSO plus injected login form": (ctx) => ssoForm(vals(ctx)) + LOGIN_FORM_ONLY,
    "exact SSO plus password field elsewhere": (ctx) => ssoForm(vals(ctx)) + `<input type="password" name="password">`,
    "genuine login form only": () => LOGIN_FORM_ONLY
  };
  for (const [name, v] of Object.entries(variants)) {
    const t = indexWith((ctx) => (typeof v === "function" ? v(ctx) : ssoForm(vals(ctx), v)));
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error", name);
    assert.match(a.error, /로그인 화면/, name);
    assert.equal(a.items.length, 0, name);
    assert.equal(requestsFor(t, LOAN_PATH).length, 0, `${name}: no list request after a rejected homepage`);
    assert.ok(t.env.log.requests.every((r) => r.url.startsWith(`${BASE}/`)), name);
  }
});

test("the SSO exemption is not applied outside INDEX_URL (loan list, ILL list, login response)", async () => {
  for (const where of [LOAN_PATH, DOO_PATH]) {
    const t = setup({
      mem: realMembers(),
      accounts: [A],
      opts: { override: (req, ctx) => (ctx.path === where && ctx.member ? { status: 200, body: listHtml(where === LOAN_PATH ? "loan" : "doo", ctx.member, ctx.page).replace("</body>", `${ssoForm({ id: ctx.userId, name: ctx.member.name })}</body>`) } : null) }
    });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error", where);
    assert.match(a.error, /로그인 화면/, where);
    assert.equal(a.items.length, 0, where);
  }
  const login200 = setup({
    mem: realMembers(),
    accounts: [A],
    opts: { override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") ? { status: 200, body: `<html><body>${ssoForm({ id: "alice", name: "김하나" })}</body></html>`, setSession: lib.newSession("alice") } : null) }
  });
  const [l] = await login200.fetchAll();
  assert.equal(l.status, "error");
  assert.match(l.error, /로그인/);
  assert.equal(login200.env.log.requests.length, 1);
});

// Keychain 쓰기 감시 (키 이름만 기록, 값은 기록하지 않음)
function watchKeychain(t) {
  const kc = t.env.globals.Keychain;
  const writes = [];
  for (const k of ["set", "remove"]) {
    const orig = kc[k];
    kc[k] = (...args) => { writes.push([k, args[0]]); return orig(...args); };
  }
  return writes;
}

// (수정됨) v1.2에서는 회원번호 없는 예전 계정에 접속하지 않고 키체인에 쓰지 않았다. 이제는 서버 주체 증명을 통과한 뒤
// 별도 키(SPLIB_VERIFIED_MEMBERS_V1)에만 한 번 쓴다. 계정 목록(SPLIB_ACCOUNTS)은 여전히 절대 쓰지 않는다.
test("legacy ID/PW-only account (real shape): proven via the profile page, only the separate verified key is written", async () => {
  const only = setup({ mem: realMembers(), accounts: [{ label: "예전 계정", id: "alice", pw: A.pw }] });
  const w1 = watchKeychain(only);
  const before = only.env.keychain.get("SPLIB_ACCOUNTS");
  const [c] = await only.fetchAll();
  assert.equal(c.status, "ok", String(c.error));
  assert.deepEqual(titles(c), ["A 책 1", "A 책 2"]);
  assert.deepEqual(w1, [["set", VKEY]]);
  assert.equal(only.env.keychain.get("SPLIB_ACCOUNTS"), before);

  const mixed = setup({ mem: realMembers(), accounts: [A, { label: "예전 계정", id: "bob", pw: B.pw }] });
  const w2 = watchKeychain(mixed);
  const [a, l] = await mixed.fetchAll();
  assert.equal(a.status, "ok", String(a.error));
  assert.equal(l.status, "ok", String(l.error));
  assert.deepEqual(titles(l), ["B 책 1"]);
  assert.deepEqual(w2, [["set", VKEY]]);
  assert.deepEqual(JSON.parse(mixed.env.keychain.get(VKEY)).records, [{ origin: BASE, loginId: "bob", memberId: "22220002" }], "manual A is not cached");
});

// ================================================================ 서버 주체 증명 + 첫 확인 회원번호 저장
// 모든 값은 지어낸 것이다. 운영 코드는 합성 서버의 sessions 맵을 보지 않고 응답 HTML만 읽는다.
const idOnly = ({ memberId, ...rest }) => rest;
const AO = idOnly(A);
const BO = idOnly(B);
const rec = (loginId, memberId) => ({ origin: BASE, loginId, memberId });
const storeJson = (...records) => JSON.stringify({ version: 1, records });
const storeRecords = (t) => (t.env.keychain.has(VKEY) ? JSON.parse(t.env.keychain.get(VKEY)).records : null);
const bindingFiles = (env) => [...env.files.keys()].filter((k) => k.includes("songpa-verified-members"));
const profileOverride = (respond) => (req, ctx) => (ctx.path === PROFILE_PATH && ctx.member ? respond(ctx) : null);
const noListRequests = (t) => requestsFor(t, LOAN_PATH).length + requestsFor(t, DOO_PATH).length === 0;
function pathsBySession(t) {
  const out = [];
  let cur = null;
  for (const r of t.env.log.requests) {
    if (r.url.startsWith(LOGIN)) {
      cur = [];
      out.push(cur);
      continue;
    }
    if (cur) cur.push(new URL(r.url).pathname);
  }
  return out;
}

test("ID/PW-only A/B: exact principal proof precedes every list, first bindings are stored separately, account records untouched", async () => {
  const accounts = [Object.freeze({ ...AO }), Object.freeze({ ...BO })];
  const copy = plain(accounts);
  const t = setup({ accounts });
  const before = t.env.keychain.get("SPLIB_ACCOUNTS");
  const [a, b] = await t.fetchAll(accounts);
  assert.equal(a.status, "ok", String(a.error));
  assert.equal(b.status, "ok", String(b.error));
  assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
  assert.deepEqual(titles(b), ["B 책 1"]);
  assert.deepEqual(plain(accounts), copy, "caller accounts are not mutated");
  assert.equal(t.env.keychain.get("SPLIB_ACCOUNTS"), before, "SPLIB_ACCOUNTS byte-for-byte intact");
  assert.deepEqual(JSON.parse(t.env.keychain.get(VKEY)), { version: 1, records: [rec("alice", "11110001"), rec("bob", "22220002")] });
  const stored = t.env.keychain.get(VKEY);
  for (const s of [A.pw, B.pw, ...t.lib.issued, "JSESSIONID", "pw"]) assert.ok(!stored.includes(s), `cache must not contain ${s}`);
  const seqs = pathsBySession(t);
  assert.equal(seqs.length, 2);
  for (const seq of seqs) {
    assert.equal(seq[0], PROFILE_PATH, "principal proof is the first authenticated request");
    assert.equal(seq[1], "/intro/index.do");
    assert.equal(seq.at(-2), "/intro/index.do");
    assert.equal(seq.at(-1), PROFILE_PATH, "final proof is the last request");
  }
  for (const r of requestsFor(t, PROFILE_PATH)) {
    assert.equal(r.url, PROFILE_URL);
    assert.equal(r.method, "GET");
    assert.equal(r.body, undefined, "password gate is never submitted");
  }
  assertCookiePinned(t);
  assert.deepEqual(bindingFiles(t.env), [], "own lock and claim are removed");
});

test("repeat run is idempotent: the cached binding is compared, a fresh profile proof still runs, nothing is rewritten", async () => {
  const t = setup({ accounts: [AO, BO] });
  await t.fetchAll();
  const stored = t.env.keychain.get(VKEY);
  const writes = watchKeychain(t);
  const proofsBefore = requestsFor(t, PROFILE_PATH).length;
  const [a, b] = await t.fetchAll();
  assert.equal(a.status, "ok", String(a.error));
  assert.equal(b.status, "ok", String(b.error));
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(writes, []);
  assert.equal(t.env.keychain.get(VKEY), stored);
  assert.equal(requestsFor(t, PROFILE_PATH).length - proofsBefore, 4, "initial + final proof per account on every run");
});

test("cached binding is never a bypass: a different member or principal on the fresh proof is refused before lists; cache kept", async () => {
  const seeded = storeJson(rec("alice", "99990009"));
  const t = setup({ accounts: [AO], keychain: { [VKEY]: seeded } });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "error");
  assert.match(a.error, /이전에 확인된 회원번호와 다른 회원/);
  assert.ok(noListRequests(t));
  assert.equal(requestsFor(t, "/intro/index.do").length, 0);
  assert.equal(t.env.keychain.get(VKEY), seeded);

  const good = storeJson(rec("alice", "11110001"));
  const swapped = setup({
    accounts: [AO],
    keychain: { [VKEY]: good },
    opts: { override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") ? { status: 302, location: "/intro/index.do", setSession: lib.newSession("bob") } : null) }
  });
  const [s] = await swapped.fetchAll();
  assert.equal(s.status, "error");
  assert.match(s.error, /로그인한 아이디와 다른 회원/);
  assert.ok(noListRequests(swapped));
  assert.equal(swapped.env.keychain.get(VKEY), good);
});

test("manual member ID: correct works without caching; wrong refuses before lists; malformed present values and manual/cache disagreement make zero requests", async () => {
  const ok = setup({ accounts: [A] });
  assert.equal((await ok.fetchAll())[0].status, "ok");
  assert.equal(ok.env.keychain.has(VKEY), false);

  const wrong = setup({ accounts: [{ ...A, memberId: "99990009" }] });
  const [w] = await wrong.fetchAll();
  assert.equal(w.status, "error");
  assert.match(w.error, /등록한 회원번호와 다른 회원/);
  assert.ok(noListRequests(wrong));
  assert.equal(requestsFor(wrong, "/intro/index.do").length, 0);
  assert.equal(wrong.env.keychain.has(VKEY), false);

  for (const bad of ["12", "", "가나다라", { v: 1 }, true]) {
    const t = setup({ accounts: [{ ...A, memberId: bad }] });
    const [x] = await t.fetchAll();
    assert.equal(x.status, "error", JSON.stringify(bad));
    assert.match(x.error, /형식이 올바르지 않아/);
    assert.equal(t.env.log.requests.length, 0, "no automatic fallback to an ID/PW-only login");
    assert.equal(t.env.keychain.has(VKEY), false);
  }

  const seeded = storeJson(rec("alice", "99990009"));
  const disagree = setup({ accounts: [A], keychain: { [VKEY]: seeded } });
  const [d] = await disagree.fetchAll();
  assert.equal(d.status, "error");
  assert.match(d.error, /직접 입력한 회원번호와 이전에 확인된/);
  assert.equal(disagree.env.log.requests.length, 0);
  assert.equal(disagree.env.keychain.get(VKEY), seeded);

  const agree = setup({ accounts: [A], keychain: { [VKEY]: storeJson(rec("alice", "11110001")) } });
  assert.equal((await agree.fetchAll())[0].status, "ok");
});

test("ID/PW-only failures bind nothing: wrong first session, A/B swap, bad password, expired session; homonyms with distinct members bind correctly", async () => {
  const toOther = (who) => (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") && req.body.includes(`userId=${who}`)
    ? { status: 302, location: "/intro/index.do", setSession: lib.newSession(who === "alice" ? "bob" : "alice") }
    : null);
  const first = setup({ accounts: [AO, BO], opts: { override: toOther("alice") } });
  const [fa, fb] = await first.fetchAll();
  assert.equal(fa.status, "error");
  assert.match(fa.error, /로그인한 아이디와 다른 회원/);
  assert.equal(fb.status,"ok");assert.equal(fa.items.length,0);
  assert.deepEqual(titles(fb),["B 책 1"]);
  assert.deepEqual(storeRecords(first),[rec("bob","22220002")]);

  const swapAll = (req, ctx, lib) => {
    if (!ctx.path.endsWith("memberLoginProc.do")) return null;
    const u = new URLSearchParams(req.body).get("userId");
    return { status: 302, location: "/intro/index.do", setSession: lib.newSession(u === "alice" ? "bob" : "alice") };
  };
  const swap = setup({ accounts: [AO, BO], opts: { override: swapAll } });
  for (const r of await swap.fetchAll()) {
    assert.equal(r.status, "error");
    assert.equal(r.items.length, 0);
  }
  assert.ok(noListRequests(swap));
  assert.equal(swap.env.keychain.has(VKEY), false);

  const badPw = setup({ accounts: [AO], mem: members({ alice: { pw: "other-pw" } }) });
  const [bp] = await badPw.fetchAll();
  assert.match(bp.error, /로그인 실패/);
  assert.equal(requestsFor(badPw, PROFILE_PATH).length, 0);
  assert.equal(badPw.env.keychain.has(VKEY), false);

  const expired = setup({ accounts: [AO], opts: { override: profileOverride(() => ({ status: 302, location: "/intro/memberLogin.do" })) } });
  const [ex] = await expired.fetchAll();
  assert.equal(ex.status, "error");
  assert.ok(noListRequests(expired));
  assert.equal(expired.env.log.followed.length, 0);
  assert.equal(expired.env.keychain.has(VKEY), false);

  const mem = {
    k1: { pw: "pw-k1-aaa", memberId: "30000001", name: "김민수", loans: books("K1", 1), doo: [] },
    k2: { pw: "pw-k2-bbb", memberId: "30000002", name: "김민수", loans: books("K2", 1), doo: [] }
  };
  const homonyms = setup({ mem, accounts: [{ label: "김민수 (큰집)", id: "k1", pw: "pw-k1-aaa" }, { label: "김민수 (작은집)", id: "k2", pw: "pw-k2-bbb" }] });
  const [x, y] = await homonyms.fetchAll();
  assert.equal(x.status, "ok", String(x.error));
  assert.equal(y.status, "ok", String(y.error));
  assert.deepEqual(storeRecords(homonyms), [rec("k1", "30000001"), rec("k2", "30000002")]);
});

test("profile principal variants are rejected before any home/list request: zero rows, no binding", async () => {
  const F = (uid, extra = "") => `<input type="hidden" id="userId" name="userId" value="${uid}"${extra}>`;
  const field = (f) => (c) => profileHtml(c.member, c.userId, { field: typeof f === "function" ? f(c.userId) : f });
  const variants = {
    "absent userId": field(""),
    "empty value": field(`<input type="hidden" id="userId" name="userId" value="">`),
    "no value attribute": field(`<input type="hidden" id="userId" name="userId">`),
    "duplicate identical fields": field((u) => F(u) + F(u)),
    "conflicting extra userid field": field((u) => F(u) + `<input type="hidden" name="userid" value="bob">`),
    "extra loginId field": field((u) => F(u) + `<input type="hidden" name="loginId" value="${u}">`),
    "non-hidden field": field((u) => `<input type="text" id="userId" name="userId" value="${u}">`),
    "id attribute only": field((u) => `<input type="hidden" id="userId" value="${u}">`),
    "name attribute only": field((u) => `<input type="hidden" name="userId" value="${u}">`),
    "lowercase id/name": field((u) => `<input type="hidden" id="userid" name="userid" value="${u}">`),
    "duplicate value attribute": field((u) => F(u, ` value="bob"`)),
    "duplicate name attribute": field((u) => F(u, ` name="other"`)),
    "broken quoting": field((u) => `<input type="hidden" id="userId" name="userId value="${u}">`),
    "disabled field": field((u) => F(u, " disabled")),
    "non-input element": field((u) => `<div id="userId" name="userId" value="${u}"></div>`),
    "comment only": field((u) => `<!-- ${F(u)} -->`),
    "script only": field((u) => `<script>document.write('${F(u)}');</script>`),
    "template only": field((u) => `<template>${F(u)}</template>`),
    "textarea only": field((u) => `<textarea>${F(u)}</textarea>`),
    "noscript only": field((u) => `<noscript>${F(u)}</noscript>`),
    "reflected wrong principal in script": field((u) => F(u) + `<script>var h = '<input type="hidden" name="userId" value="bob">';</script>`),
    "reflected wrong principal in comment": field((u) => F(u) + `<!-- <input name="userId" value="bob"> -->`),
    "wrong principal": field(() => F("bob")),
    "padded principal": field((u) => F(` ${u}`)),
    "case-changed principal": field((u) => F(u.toUpperCase())),
    "prefix-extended principal": field((u) => F(`${u}2`)),
    "unclosed script": field((u) => F(u) + `<script>var a = 1;`),
    "normal login form on the page": field((u) => F(u) + `<form action="/intro/program/memberLoginProc.do" method="post"></form>`),
    "member number missing": (c) => profileHtml(c.member, c.userId, { identity: false }),
    "conflicting member number": (c) => profileHtml(c.member, c.userId, { extra: `<input type="hidden" name="memberNo" value="22220002">` }),
    "hidden conflicting member block": (c) => profileHtml(c.member, c.userId, { extra: `<template><div class="barcodeInfo">이두리<span>22220002</span></div></template>` })
  };
  for (const [name, body] of Object.entries(variants)) {
    const t = setup({ accounts: [AO], opts: { override: profileOverride((c) => ({ status: 200, body: body(c) })) } });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error", name);
    assert.equal(a.items.length, 0, name);
    assert.ok(noListRequests(t), name);
    assert.equal(requestsFor(t, "/intro/index.do").length, 0, name);
    assert.equal(t.env.keychain.has(VKEY), false, name);
  }
  // 대조군: 기본 모양은 통과
  const ok = setup({ accounts: [AO] });
  assert.equal((await ok.fetchAll())[0].status, "ok");
});

test("profile response guards: exact URL only, HTTP 200 only, no redirect follow, no SID rotation/deletion", async () => {
  const body = (c) => profileHtml(c.member, c.userId);
  const responses = {
    "query on URL": (c) => ({ status: 200, url: `${PROFILE_URL}?a=1`, body: body(c) }),
    "empty query": (c) => ({ status: 200, url: `${PROFILE_URL}?`, body: body(c) }),
    "fragment": (c) => ({ status: 200, url: `${PROFILE_URL}#x`, body: body(c) }),
    "path parameter": (c) => ({ status: 200, url: `${PROFILE_URL};jsessionid=${c.sid}`, body: body(c) }),
    "trailing slash": (c) => ({ status: 200, url: `${PROFILE_URL}/`, body: body(c) }),
    "foreign origin": (c) => ({ status: 200, url: `https://splib.example.invalid${PROFILE_PATH}`, body: body(c) }),
    "http scheme": (c) => ({ status: 200, url: PROFILE_URL.replace("https:", "http:"), body: body(c) }),
    "other page": (c) => ({ status: 200, url: `${BASE}/intro/index.do`, body: body(c) }),
    "302 to login": () => ({ status: 302, location: "/intro/memberLogin.do" }),
    "302 to itself": () => ({ status: 302, location: PROFILE_PATH }),
    "HTTP 500": (c) => ({ status: 500, body: body(c) }),
    "HTTP 403": (c) => ({ status: 403, body: body(c) }),
    "rotated cookie": (c) => ({ status: 200, body: body(c), headers: { "Set-Cookie": "JSESSIONID=ROTATED00001XYZ; Path=/" } }),
    "deleted cookie": (c) => ({ status: 200, body: body(c), headers: { "Set-Cookie": `JSESSIONID=${c.sid}; Max-Age=0; Path=/` } }),
    "rotated via cookies": (c) => ({ status: 200, body: body(c), cookies: [{ name: "JSESSIONID", value: "OTHERSESS0001", domain: "splib.or.kr" }] }),
    "network failure": () => ({ throw: "timeout" })
  };
  for (const [name, respond] of Object.entries(responses)) {
    const t = setup({ accounts: [AO], opts: { override: profileOverride(respond) } });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error", name);
    assert.equal(t.env.log.followed.length, 0, name);
    assert.ok(noListRequests(t), name);
    assert.equal(t.env.keychain.has(VKEY), false, name);
  }
  // 대조군: 같은 세션 값을 다시 내려보내는 것은 정상
  const same = setup({ accounts: [AO], opts: { override: profileOverride((c) => ({ status: 200, body: body(c), headers: { "Set-Cookie": `JSESSIONID=${c.sid}; Path=/` } })) } });
  assert.equal((await same.fetchAll())[0].status, "ok");
});

test("final drift discards every row and binds nothing (final principal, member, missing member, network, cookie, final home)", async () => {
  const mem = members();
  const second = (respond) => {
    let n = 0;
    return (req, ctx) => (ctx.path === PROFILE_PATH && ctx.member && ++n === 2 ? respond(ctx) : null);
  };
  const cases = {
    "final principal is another account": second(() => ({ status: 200, body: profileHtml(mem.bob, "bob") })),
    "final member drifts under the same principal": second((c) => ({ status: 200, body: profileHtml(mem.bob, c.userId) })),
    "final member missing": second((c) => ({ status: 200, body: profileHtml(c.member, c.userId, { identity: false }) })),
    "final proof network failure": second(() => ({ throw: "timeout" })),
    "final cookie rotation": second((c) => ({ status: 200, body: profileHtml(c.member, c.userId), headers: { "Set-Cookie": "JSESSIONID=ROTATED00002XYZ; Path=/" } }))
  };
  let homeCalls = 0;
  cases["final home shows another member"] = (req, ctx) => (ctx.path === "/intro/index.do" && ctx.member && ++homeCalls === 2 ? { status: 200, body: indexHtml(mem.bob, "bob") } : null);
  for (const [name, override] of Object.entries(cases)) {
    const t = setup({ mem, accounts: [AO], opts: { override } });
    const [a] = await t.fetchAll();
    assert.equal(a.status, "error", name);
    assert.match(a.error, /조회 후/, name);
    assert.equal(a.items.length, 0, name);
    assert.ok(requestsFor(t, LOAN_PATH).length > 0, `${name}: lists were read and then discarded`);
    assert.equal(t.env.keychain.has(VKEY), false, name);
  }
});

test("verified sequential shared SID can bind distinct members; actual member collisions still quarantine before commit", async () => {
  const shared = setup({
    accounts: [AO, BO],
    opts: {
      override: (req, ctx, lib) => {
        if (!ctx.path.endsWith("memberLoginProc.do")) return null;
        lib.sessions.set("SESSSHARED0001", new URLSearchParams(req.body).get("userId"));
        return { status: 302, location: "/intro/index.do", setSession: "SESSSHARED0001" };
      }
    }
  });
  const [sa, sb] = await shared.fetchAll();
  assert.equal(sa.status, "ok");
  assert.equal(sb.status, "ok");
  assert.deepEqual(titles(sa), ["A 책 1", "A 책 2"]);
  assert.deepEqual(titles(sb), ["B 책 1"]);
  assert.equal(shared.env.keychain.has(VKEY), true);

  const later = setup({
    accounts: [AO, BO],
    opts: { override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=bob") ? { status: 302, location: "/intro/index.do", setSession: lib.newSession("alice") } : null) }
  });
  const [la, lb] = await later.fetchAll();
  assert.equal(la.status,"ok");assert.deepEqual(titles(la),["A 책 1","A 책 2"]);
  assert.equal(lb.status,"error");assert.equal(lb.items.length,0);
  assert.deepEqual(storeRecords(later),[rec("alice","11110001")]);

  const mem = { ...members(), carol: { pw: "pw-carol-3", memberId: "33330003", name: "박세번", loans: books("C", 1), doo: [] } };
  const CO = { label: "삼촌 박세번", id: "carol", pw: "pw-carol-3" };
  const three = setup({
    mem,
    accounts: [AO, BO, CO],
    opts: { override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=carol") ? { status: 302, location: "/intro/index.do", setSession: lib.newSession("alice") } : null) }
  });
  const [ta, tb, tc] = await three.fetchAll();
  assert.equal(ta.status,"ok");assert.deepEqual(titles(ta),["A 책 1","A 책 2"]);
  assert.equal(tc.status,"error");assert.equal(tc.items.length,0);
  assert.equal(tb.status,"ok");assert.deepEqual(titles(tb),["B 책 1"]);
  assert.deepEqual(storeRecords(three),[rec("alice","11110001"),rec("bob","22220002")]);
});

test("overlapping runs on one shared mock jar: every request pins its own fresh session, rows never mix, binding written once", async () => {
  const t = setup({ accounts: [AO, BO] });
  const [r1, r2] = await Promise.all([t.fetchAll(), t.fetchAll()]);
  for (const [a, b] of [r1, r2]) {
    assert.equal(a.status, "ok", String(a.error));
    assert.equal(b.status, "ok", String(b.error));
    assert.deepEqual(titles(a), ["A 책 1", "A 책 2"]);
    assert.deepEqual(titles(b), ["B 책 1"]);
  }
  assert.equal(new Set(t.lib.issued).size, 4);
  for (const r of t.env.log.requests) {
    if (r.url.startsWith(LOGIN)) {
      assert.equal(r.cookie, ANON_LOGIN_COOKIE);
      continue;
    }
    assert.equal(r.explicitCookie, true, r.url);
    assert.ok(t.lib.issued.includes(/^JSESSIONID=(.+)$/.exec(r.cookie)?.[1]), r.url);
  }
  assert.deepEqual(storeRecords(t), [rec("alice", "11110001"), rec("bob", "22220002")]);
  assert.deepEqual(bindingFiles(t.env), []);
});

test("a server that mixes sessions between overlapping runs cannot leak rows or bindings across accounts", async () => {
  const mem = members();
  let last = null;
  // 잘못된 서버: 쿠키와 무관하게 가장 최근에 로그인한 사용자의 화면을 돌려준다
  const override = (req, ctx) => {
    if (ctx.path.endsWith("memberLoginProc.do")) {
      last = new URLSearchParams(req.body).get("userId");
      return null;
    }
    if (!ctx.member || !last) return null;
    const m = mem[last];
    if (ctx.path === PROFILE_PATH) return { status: 200, body: profileHtml(m, last) };
    if (ctx.path === "/intro/index.do") return { status: 200, body: indexHtml(m, last) };
    if (ctx.path === LOAN_PATH) return { status: 200, body: listHtml("loan", m, ctx.page) };
    if (ctx.path === DOO_PATH) return { status: 200, body: listHtml("doo", m, ctx.page) };
    return null;
  };
  const t = setup({ mem, accounts: [AO, BO], opts: { override } });
  const p1 = t.fetchAll([AO, BO]);
  for (let i = 0; i < 1000 && requestsFor(t, LOAN_PATH).length === 0; i++) await tick();
  const p2 = t.fetchAll([BO, AO]);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1[0].status, "error", "run 1's alice saw bob's pages after run 2 logged in");
  const own = { "엄마 김하나": "A ", "아빠 이두리": "B " };
  for (const r of [...r1, ...r2]) {
    if (r.status === "error") {
      assert.equal(r.items.length, 0);
      continue;
    }
    assert.ok(r.items.every((i) => i.title.startsWith(own[r.name])), r.name);
  }
  for (const x of storeRecords(t) || []) assert.deepEqual(x, x.loginId === "alice" ? rec("alice", "11110001") : rec("bob", "22220002"));
});

// ---------------------------------------------------------------- 배타 잠금·저장 단위 테스트 (모의 키체인·파일만)
function bindingHarness({ accounts = [AO, BO], store, files = {} } = {}) {
  const keychain = { SPLIB_ACCOUNTS: JSON.stringify(accounts) };
  if (store !== undefined) keychain[VKEY] = store;
  const env = createEnv({ keychain, files });
  const run = loadScript(TRACKER, env.globals);
  const commit = (cands) => {
    const o = run("commitVerifiedBindings")(cands);
    return { status: o.status, saved: [...o.saved].sort(), unchanged: [...o.unchanged].sort(), conflicts: [...o.conflicts].sort() };
  };
  return { env, run, commit, records: () => (env.keychain.has(VKEY) ? JSON.parse(env.keychain.get(VKEY)).records : null) };
}
const cand = (index, acc, memberId) => ({ index, loginId: acc.id, memberId, pw: acc.pw });

test("mock FileManager.copy honors the documented exclusive contract (destination exists → fails, nothing overwritten)", () => {
  const env = createEnv();
  const fm = env.globals.FileManager.local();
  fm.writeString("/local/Library/a", "1");
  fm.writeString("/local/Library/b", "2");
  assert.throws(() => fm.copy("/local/Library/a", "/local/Library/b"));
  assert.equal(env.files.get("/local/Library/b"), "2");
  fm.copy("/local/Library/a", "/local/Library/c");
  assert.equal(env.files.get("/local/Library/c"), "1");
  fm.writeString("/local/Library/b", "3");
  assert.equal(env.files.get("/local/Library/b"), "3", "writeString overwrites, which is why it is not used as the lock");
});

test("binding lock: success cleans own files; busy, racing, failing or missing copy fail closed without writing or deleting a foreign lock", () => {
  const one = [cand(0, AO, "11110001")];
  const ok = bindingHarness();
  assert.deepEqual(ok.commit(one), { status: "saved", saved: [0], unchanged: [], conflicts: [] });
  assert.deepEqual(ok.records(), [rec("alice", "11110001")]);
  assert.deepEqual(bindingFiles(ok.env), []);

  const busy = bindingHarness({ files: { [BIND_LOCK]: "foreign-writer" } });
  assert.equal(busy.commit(one).status, "busy");
  assert.equal(busy.env.keychain.has(VKEY), false);
  assert.deepEqual(bindingFiles(busy.env), [BIND_LOCK], "own claim removed, foreign lock kept (no TTL takeover)");
  assert.equal(busy.env.files.get(BIND_LOCK), "foreign-writer");

  const race = bindingHarness();
  race.env.copyHook = (src, dst) => { if (dst === BIND_LOCK && !race.env.files.has(dst)) race.env.files.set(dst, "racer"); };
  assert.equal(race.commit(one).status, "busy");
  assert.equal(race.env.keychain.has(VKEY), false);
  assert.equal(race.env.files.get(BIND_LOCK), "racer");
  assert.deepEqual(bindingFiles(race.env), [BIND_LOCK]);

  const broken = bindingHarness();
  broken.env.failCopy = true;
  assert.equal(broken.commit(one).status, "unavailable");
  assert.equal(broken.env.keychain.has(VKEY), false);
  assert.deepEqual(bindingFiles(broken.env), []);

  const noCopy = bindingHarness();
  delete noCopy.env.globals.FileManager.local().copy;
  assert.equal(noCopy.commit(one).status, "unavailable");
  assert.equal(noCopy.env.keychain.has(VKEY), false);
  assert.deepEqual(bindingFiles(noCopy.env), []);

  // 조회 실행 표시(lease)는 저장 잠금이 아니다
  const leased = bindingHarness({ files: { [LEASE]: JSON.stringify({ owner: "other", expiresAt: Date.now() + 60000 }) } });
  assert.equal(leased.commit(one).status, "saved");
});

test("binding commit: write/readback failures and invalid cache fail closed; differing values never overwritten; batches all-or-nothing; same value idempotent", () => {
  const one = [cand(0, AO, "11110001")];
  const setFail = bindingHarness();
  setFail.env.globals.Keychain.set = () => { throw new Error("keychain denied (synthetic)"); };
  assert.deepEqual(setFail.commit(one), { status: "failed", saved: [], unchanged: [], conflicts: [] });
  assert.equal(setFail.env.keychain.has(VKEY), false);
  assert.deepEqual(bindingFiles(setFail.env), [], "lock released after failure");

  const readback = bindingHarness();
  const origGet = readback.env.globals.Keychain.get;
  readback.env.globals.Keychain.get = (k) => (k === VKEY ? "tampered" : origGet(k));
  assert.deepEqual(readback.commit(one).saved, []);
  assert.equal(readback.commit(one).status === "saved", false);

  const invalid = [
    "{bad", "[]", "",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [], extra: 1 }),
    JSON.stringify({ version: 1, records: [{ origin: "https://splib.example.invalid", loginId: "x", memberId: "12345678" }] }),
    JSON.stringify({ version: 1, records: [rec("alice", "1111-0001")] }),
    JSON.stringify({ version: 1, records: [{ ...rec("x", "12345678"), pw: "leak" }] }),
    storeJson(rec("alice", "11110001"), rec("alice", "11110001")),
    storeJson(rec("x", "11110001"), rec("y", "11110001"))
  ];
  for (const bad of invalid) {
    const h = bindingHarness({ store: bad });
    assert.equal(h.commit(one).status, "invalid", bad);
    assert.equal(h.env.keychain.get(VKEY), bad, bad);
  }

  const seeded = storeJson(rec("alice", "99990009"));
  const diff = bindingHarness({ store: seeded });
  assert.deepEqual(diff.commit(one), { status: "conflict", saved: [], unchanged: [], conflicts: [0] });
  assert.equal(diff.env.keychain.get(VKEY), seeded);

  const taken = bindingHarness({ store: storeJson(rec("bob", "11110001")) });
  assert.equal(taken.commit(one).status, "conflict");
  assert.deepEqual(taken.records(), [rec("bob", "11110001")]);

  const manualOther = bindingHarness({ accounts: [AO, { ...B, memberId: "11110001" }] });
  assert.equal(manualOther.commit(one).status, "conflict");
  assert.equal(manualOther.env.keychain.has(VKEY), false);

  const manualSame = bindingHarness({ accounts: [{ ...AO, memberId: "99990009" }, BO] });
  assert.equal(manualSame.commit(one).status, "conflict");
  assert.equal(manualSame.env.keychain.has(VKEY), false);

  const batch = bindingHarness({ store: storeJson(rec("bob", "99990009")) });
  assert.deepEqual(batch.commit([cand(0, AO, "11110001"), cand(1, BO, "22220002")]), { status: "conflict", saved: [], unchanged: [], conflicts: [1] });
  assert.deepEqual(batch.records(), [rec("bob", "99990009")], "A is not written when B conflicts");

  const same = bindingHarness({ store: storeJson(rec("alice", "11110001")) });
  let sets = 0;
  const origSet = same.env.globals.Keychain.set;
  same.env.globals.Keychain.set = (...a) => { sets++; return origSet(...a); };
  assert.deepEqual(same.commit(one), { status: "unchanged", saved: [], unchanged: [0], conflicts: [] });
  assert.equal(sets, 0);

  for (const accounts of [[BO], [{ ...AO, pw: "changed" }, BO], [AO, { ...AO, label: "dup" }]]) {
    const h = bindingHarness({ accounts });
    assert.deepEqual(h.commit(one).saved, [], JSON.stringify(accounts.map((a) => a.label)));
    assert.equal(h.env.keychain.has(VKEY), false);
  }

  const noAcc = bindingHarness();
  noAcc.env.keychain.set("SPLIB_ACCOUNTS", "{bad");
  assert.equal(noAcc.commit(one).status, "failed");
  assert.equal(noAcc.env.keychain.has(VKEY), false);
  assert.equal(noAcc.env.keychain.get("SPLIB_ACCOUNTS"), "{bad", "account records are never rewritten");
});

test("concurrent binding writers: a second writer is busy while the first holds the lock, then merges the latest cache and preserves every record", () => {
  const CO = { label: "삼촌", id: "carol", pw: "pw-carol-3" };
  const w1 = bindingHarness({ accounts: [AO, BO, CO], store: storeJson(rec("carol", "33330003")) });
  const e2 = createEnv();
  e2.keychain = w1.env.keychain; // 같은 기기의 키체인·로컬 파일을 공유하는 두 번째 실행
  e2.files = w1.env.files;
  const run2 = loadScript(TRACKER, e2.globals);
  const commit2 = (c) => run2("commitVerifiedBindings")(c).status;
  let inner = null;
  const origSet = w1.env.globals.Keychain.set;
  w1.env.globals.Keychain.set = (k, v) => {
    if (inner === null) {
      assert.ok(w1.env.files.has(BIND_LOCK), "writer 1 holds the lock during its critical section");
      inner = commit2([cand(0, BO, "22220002")]);
    }
    return origSet(k, v);
  };
  assert.equal(w1.commit([cand(0, AO, "11110001")]).status, "saved");
  assert.equal(inner, "busy");
  assert.deepEqual(w1.records(), [rec("carol", "33330003"), rec("alice", "11110001")]);
  assert.equal(commit2([cand(0, BO, "22220002")]), "saved");
  assert.deepEqual(w1.records(), [rec("carol", "33330003"), rec("alice", "11110001"), rec("bob", "22220002")]);
  assert.deepEqual(bindingFiles(w1.env), []);
});

test("full run: busy lock or unreadable cache fail closed for initial storage; a differing value written meanwhile is never overwritten", async () => {
  const busy = setup({ accounts: [AO], files: { [BIND_LOCK]: "foreign-writer" } });
  const [b] = await busy.fetchAll();
  assert.equal(b.status, "ok", String(b.error));
  assert.ok(b.warnings.some((w) => /저장하지 못했습니다/.test(w)), "no success claim for storage");
  assert.equal(busy.env.keychain.has(VKEY), false);
  assert.equal(busy.env.files.get(BIND_LOCK), "foreign-writer");

  const corrupt = setup({ accounts: [AO, B], keychain: { [VKEY]: "{bad" } });
  const [c, m] = await corrupt.fetchAll();
  assert.equal(c.status, "error");
  assert.match(c.error, /기록을 읽을 수 없어/);
  assert.equal(corrupt.env.log.requests.filter((r) => String(r.body || "").includes("userId=alice")).length, 0);
  assert.equal(m.status, "ok", "manual account still works");
  assert.equal(corrupt.env.keychain.get(VKEY), "{bad");

  let t;
  t = setup({
    accounts: [AO],
    opts: { override: (req, ctx) => { if (ctx.path === LOAN_PATH && !t.env.keychain.has(VKEY)) t.env.keychain.set(VKEY, storeJson(rec("alice", "99990009"))); return null; } }
  });
  const [r] = await t.fetchAll();
  assert.equal(r.status, "error");
  assert.match(r.error, /달라 결과를 숨기고/);
  assert.equal(r.items.length, 0);
  assert.deepEqual(storeRecords(t), [rec("alice", "99990009")]);

  let p;
  p = setup({
    accounts: [AO],
    opts: { override: (req, ctx) => { if (ctx.path === LOAN_PATH) p.env.keychain.set("SPLIB_ACCOUNTS", JSON.stringify([{ ...AO, pw: "new-pw" }])); return null; } }
  });
  const [q] = await p.fetchAll();
  assert.equal(q.status, "ok");
  assert.ok(q.warnings.some((w) => /저장하지 못했습니다/.test(w)));
  assert.equal(p.env.keychain.has(VKEY), false, "changed account is not bound");
});

// ---------------------------------------------------------------- 본인 확인 진단 (실제 기기에서 실행하지 않음, 모의 객체만)
function diagSetup(o = {}) {
  const t = setup({ accounts: [AO, BO], ...o });
  const writes = watchKeychain(t);
  return { ...t, writes, check: async () => plain(await t.run("identityCheckMain")()) };
}

test("diagnostic: cancelling at either prompt makes zero network requests and writes nothing", async () => {
  for (const script of [[{ choice: -1 }], [{ choice: 0 }, { choice: -1 }], [{ choice: 1 }, { choice: 1 }]]) {
    const d = diagSetup();
    d.env.alertScript.push(...script);
    const report = await d.check();
    assert.equal(report.result, "CANCELLED");
    assert.equal(d.env.log.requests.length, 0);
    assert.deepEqual(d.writes, []);
    assert.equal(d.env.files.size, 0);
  }
});

test("diagnostic: one chosen account, one normal login, profile/home/final proof only; generic report without secrets; no lists, updater or writes", async () => {
  const d = diagSetup();
  d.env.alertScript.push({ choice: 1 }, { choice: 0 });
  const report = await d.check();
  assert.deepEqual(Object.keys(report), ["result", ...plain(d.run("IDENTITY_REPORT_KEYS"))]);
  assert.equal(report.result, "PASS");
  for (const k of ["loginOk", "profileResponseOk", "principalMatches", "memberUnique", "homeMatches", "finalProofMatches", "sessionStable"]) assert.equal(report[k], true, k);
  assert.equal(report.storedMemberMatches, null);
  for (const k of ["listsRequested", "bindingWritten", "accountsWritten"]) assert.equal(report[k], false, k);
  for (const [k, v] of Object.entries(report)) assert.ok(typeof v === "boolean" || v === null || (k === "result" && /^[A-Z_]+$/.test(v)), k);
  const logins = requestsFor(d, "/intro/program/memberLoginProc.do");
  assert.equal(logins.length, 1);
  assert.match(logins[0].body, /userId=bob/);
  assert.deepEqual(d.env.log.requests.map((r) => new URL(r.url).pathname), ["/intro/program/memberLoginProc.do", PROFILE_PATH, "/intro/index.do", PROFILE_PATH]);
  assert.ok(d.env.log.requests.every((r) => r.url.startsWith(`${BASE}/`)), "no updater request");
  assert.deepEqual(d.writes, []);
  assert.equal(d.env.keychain.has(VKEY), false);
  assert.equal(d.env.files.size, 0, "lease removed; no binding lock or claim");
  assert.deepEqual(d.env.log.alerts[0].actions, ["1. 엄마 김하나", "2. 아빠 이두리"]);
  const shown = d.env.log.alerts.at(-1).message;
  assert.match(shown, /result: PASS/);
  for (const secret of ["bob", "alice", B.pw, A.pw, "22220002", "11110001", ...d.lib.issued, "JSESSIONID", "barcodeInfo", "<"]) {
    assert.ok(!shown.includes(secret), secret);
    assert.ok(!JSON.stringify(report).includes(secret), secret);
    for (const line of d.env.log.console) assert.ok(!line.includes(secret), secret);
  }
});

test("diagnostic failures are classified generically and still write nothing", async () => {
  const run = async (o, script) => {
    const d = diagSetup(o);
    d.env.alertScript.push(...script);
    const r = await d.check();
    assert.deepEqual(d.writes, [], r.result);
    assert.equal(d.env.keychain.has(VKEY), Boolean(o.keychain && o.keychain[VKEY]), r.result);
    assert.ok(noListRequests(d), r.result);
    return { d, r };
  };
  const mism = await run({ opts: { override: (req, ctx, lib) => (ctx.path.endsWith("memberLoginProc.do") && req.body.includes("userId=alice") ? { status: 302, location: "/intro/index.do", setSession: lib.newSession("bob") } : null) } }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(mism.r.result, "FAIL_PRINCIPAL_MISMATCH");
  assert.equal(mism.r.loginOk, true);
  assert.equal(mism.r.profileResponseOk, true);
  assert.equal(mism.r.principalMatches, false);
  assert.equal(requestsFor(mism.d, "/intro/index.do").length, 0);

  const badPw = await run({ mem: members({ alice: { pw: "other" } }) }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(badPw.r.result, "FAIL_LOGIN");
  assert.equal(badPw.d.env.log.requests.length, 1);

  const wrongManual = await run({ accounts: [{ ...A, memberId: "99990009" }] }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(wrongManual.r.result, "FAIL_STORED_MEMBER");
  assert.equal(wrongManual.r.storedMemberMatches, false);
  assert.equal(requestsFor(wrongManual.d, "/intro/index.do").length, 0);

  const cached = await run({ accounts: [AO], keychain: { [VKEY]: storeJson(rec("alice", "11110001")) } }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(cached.r.result, "PASS");
  assert.equal(cached.r.storedMemberMatches, true);

  const badManual = await run({ accounts: [{ ...A, memberId: "12" }] }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(badManual.r.result, "FAIL_SETUP");
  assert.equal(badManual.d.env.log.requests.length, 0);

  const rotated = await run({ accounts: [AO], opts: { override: profileOverride((c) => ({ status: 200, body: profileHtml(c.member, c.userId), headers: { "Set-Cookie": "JSESSIONID=ROTATED00003XYZ; Path=/" } })) } }, [{ choice: 0 }, { choice: 0 }]);
  assert.equal(rotated.r.result, "FAIL_SESSION_CHANGED");
  assert.equal(rotated.r.sessionStable, false);

  const none = await run({ accounts: [] }, []);
  assert.equal(none.r.result, "NO_ACCOUNTS");
  assert.equal(none.d.env.log.requests.length, 0);
});

// ---------------------------------------------------------------- 진단 스크립트 생성기
test("identity-check generator is deterministic and replaces only the exact trailing entrypoint", async () => {
  const builder = await import(pathToFileURL(path.join(ROOT, "scripts", "build-scriptable-identity-check.mjs")).href);
  const src = readFileSync(TRACKER, "utf8");
  const out = builder.buildIdentityCheck(src);
  assert.equal(builder.buildIdentityCheck(src), out, "deterministic");
  assert.equal(out, src.slice(0, src.length - builder.PRODUCTION_ENTRY.length) + builder.DIAGNOSTIC_ENTRY, "only the trailing entrypoint changes");
  assert.match(out, /\nawait identityCheckMain\(\);\nScript\.complete\(\);\n$/);
  assert.doesNotMatch(out, /\nawait main\(\);/);
  assert.doesNotMatch(out, /importModule/);
  assert.ok(out.startsWith("// Variables used by Scriptable."), "Scriptable header stays at the very top");
  for (const bad of [
    src + "\n",
    src.replace(/\nawait main\(\);\nScript\.complete\(\);\n$/, "\nawait main();\n"),
    src.replace("\nasync function main()", "\nawait main();\nasync function main()"),
    src.replace(/\n/g, "\r\n")
  ]) {
    assert.throws(() => builder.buildIdentityCheck(bad));
  }
  // 호출 측이 생성본을 빌드했다면 최신이어야 한다 (생성본은 손으로 쓰지 않는다)
  if (existsSync(builder.OUTPUT_PATH)) {
    assert.equal(readFileSync(builder.OUTPUT_PATH, "utf8"), out, "regenerate with: node scripts/build-scriptable-identity-check.mjs");
  }
  // 생성본을 진단 진입점만 빼고 VM에서 평가: 취소하면 요청이 없다
  const env = createEnv({ keychain: { SPLIB_ACCOUNTS: JSON.stringify([AO]) } });
  const ctx = vm.createContext(env.globals);
  vm.runInContext(`${out.slice(0, out.length - builder.DIAGNOSTIC_ENTRY.length)}\n`, ctx, { filename: "songpa-identity-check.js" });
  const report = plain(await vm.runInContext("identityCheckMain", ctx)());
  assert.equal(report.result, "CANCELLED");
  assert.equal(env.log.requests.length, 0);
});

// ---------------------------------------------------------------- 합성 프로필 fixture
const PROFILE_FIXTURE = readFileSync(path.join(FIXTURE_DIR, "profile-password-check.html"), "utf8");

test("profile fixture: principal parsed narrowly and never returned; same-response member ok; no global password-page exemption", async () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const pp = (h, id) => plain(run("parseProfilePrincipal")(h, id)).status;
  assert.equal(pp(PROFILE_FIXTURE, "synthetic-alice"), "ok");
  assert.equal(pp(PROFILE_FIXTURE, "synthetic-bob"), "mismatch");
  assert.equal(pp(PROFILE_FIXTURE, "Synthetic-Alice"), "mismatch", "no case folding");
  assert.equal(pp(PROFILE_FIXTURE, " synthetic-alice"), "mismatch", "no trimming");
  assert.equal(pp(PROFILE_FIXTURE, ""), "ambiguous");
  assert.deepEqual(Object.keys(plain(run("parseProfilePrincipal")(PROFILE_FIXTURE, "x"))), ["status"], "the value is never returned");
  assert.equal(pp(`<input type="hidden" id="userId" name="userId" value="a&amp;b">`, "a&b"), "ok", "entity-decoded exact value");
  const id = plain(run("parseIdentity")(PROFILE_FIXTURE));
  assert.equal(id.status, "ok");
  assert.equal(id.memberId, "SYNTHETIC0001");
  assert.equal(run("looksLikeLoginPage")(PROFILE_FIXTURE), true, "generic login detection is unchanged");

  const mem = { "synthetic-alice": { pw: "pw-synthetic", memberId: "SYNTHETIC0001", name: "Synthetic User", plain: true, loans: books("S", 1), doo: [] } };
  const acc = { label: "합성 사용자", id: "synthetic-alice", pw: "pw-synthetic" };
  const t = setup({
    mem,
    accounts: [acc],
    opts: {
      override: (req, ctx) => {
        if (!ctx.member) return null;
        if (ctx.path === PROFILE_PATH) return { status: 200, body: PROFILE_FIXTURE };
        if (ctx.path === "/intro/index.do") return { status: 200, body: HOME_FIXTURE };
        return null;
      }
    }
  });
  const [a] = await t.fetchAll();
  assert.equal(a.status, "ok", String(a.error));
  assert.deepEqual(storeRecords(t), [rec("synthetic-alice", "SYNTHETIC0001")]);

  // 비밀번호 칸 예외는 회원정보 확인 화면 전용: 목록 화면의 비밀번호 칸은 그대로 로그인 화면으로 거부
  const listPw = setup({ accounts: [A], opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.member ? { status: 200, body: listHtml("loan", ctx.member, ctx.page).replace("</body>", `<input type="password" name="password"></body>`) } : null) } });
  const [l] = await listPw.fetchAll();
  assert.equal(l.status, "error");
  assert.match(l.error, /로그인 화면/);
});

// 독립 리뷰 회귀: 화면에서 버리는 실행의 초기 번호를 저장하지 않는다.
test("review regression: stolen lease discards rows AND pending bindings; collectData control still enrolls", async () => {
  const legacy = { label: A.label, id: A.id, pw: A.pw };
  let t;
  t = setup({ accounts: [legacy], opts: { override: (req, ctx) => {
    if (ctx.path === LOAN_PATH) t.env.files.set(LEASE, JSON.stringify({ owner: "intruder", expiresAt: Date.now() + 60000 }));
    return null;
  } } });
  const before = t.env.keychain.get("SPLIB_ACCOUNTS");
  const [r] = plain(await t.run("collectData")([legacy]));
  assert.equal(r.status, "error");
  assert.equal(r.items.length, 0);
  assert.equal(t.env.keychain.has("SPLIB_VERIFIED_MEMBERS_V1"), false);
  assert.equal(t.env.keychain.get("SPLIB_ACCOUNTS"), before);
  assert.equal(JSON.parse(t.env.files.get(LEASE)).owner, "intruder");
  assert.ok([...t.env.files.keys()].every(p => !p.includes("songpa-verified-members")));
  const control = setup({ accounts: [legacy] });
  const [ok] = plain(await control.run("collectData")([legacy]));
  assert.equal(ok.status, "ok");
  assert.equal(control.env.keychain.has("SPLIB_VERIFIED_MEMBERS_V1"), true);
});

test("review regression: malformed entities or uncoded parser exceptions never claim evaluated principal/response checks", async () => {
  const legacy = { label: A.label, id: A.id, pw: A.pw };
  for (const entity of ["&#x110000;", "&#99999999;"]) {
    const t = setup({ accounts: [legacy], opts: { override: (req, ctx) => {
      if (ctx.path === "/intro/menu/10101/program/30045/memberModifyPwCheck.do") return { status: 200, body: `<div class="barcodeInfo">${entity}<span>11110001</span></div><input type="hidden" id="userId" name="userId" value="alice">` };
      return null;
    } } });
    const r = plain(await t.run("runIdentityDiagnostic")(legacy));
    assert.equal(r.result, "FAIL_PROFILE_PARSE");
    assert.equal(r.profileResponseOk, false);
    assert.equal(r.principalMatches, false);
    assert.equal(r.bindingWritten, false);
    assert.equal(t.env.keychain.has("SPLIB_VERIFIED_MEMBERS_V1"), false);
  }
  const unknown = setup({ accounts: [legacy] });
  unknown.run("proveProfilePrincipal = async () => { throw new Error('synthetic unknown parser error'); }");
  const r = plain(await unknown.run("runIdentityDiagnostic")(legacy));
  assert.equal(r.result, "FAIL_PROFILE_PARSE");
  assert.equal(r.profileResponseOk, false);
  assert.equal(r.principalMatches, false);
});

test("review regression: optional name failure reports only proof stages already verified", async () => {
  const acc = { label: A.label, id: A.id, pw: A.pw, siteName: "다른 이름" };
  const t = setup({ accounts: [acc] });
  const r = plain(await t.run("runIdentityDiagnostic")(acc));
  assert.equal(r.result, "FAIL_NAME_MISMATCH");
  assert.equal(r.profileResponseOk, true);
  assert.equal(r.principalMatches, true);
  assert.equal(r.memberUnique, true);
  assert.equal(r.bindingWritten, false);
  assert.equal(r.accountsWritten, false);
  assert.equal(requestsFor(t, LOAN_PATH).length, 0);
});

test("review regression: explicit '-' clears manual memberId, including malformed legacy values, without changing credentials", async () => {
  for (const value of ["12", true, { invalid: 1 }, A.memberId]) {
    const original = [{ ...A, memberId: value, siteName: "김하나" }];
    const before = JSON.stringify(original);
    const s = accountsScript(original);
    const r = plain(s.run("mergeAccount")(original, { id: A.id, memberId: "-" }));
    assert.equal(r.ok, true);
    assert.equal(Object.hasOwn(r.accounts[0], "memberId"), false);
    assert.equal(r.accounts[0].pw, A.pw);
    assert.equal(r.accounts[0].label, A.label);
    assert.equal(r.accounts[0].siteName, "김하나");
    assert.equal(JSON.stringify(original), before);
  }
  const s = accountsScript([{ ...A, memberId: "12" }]);
  s.env.alertScript.push({ choice: 1 }, { choice: 0 }, { choice: 0, fields: [undefined, "", "-", ""] }, { choice: 0 }, { choice: -1 });
  await s.run("main")();
  const saved = s.saved();
  assert.equal(Object.hasOwn(saved[0], "memberId"), false);
  assert.equal(saved[0].pw, A.pw);
  const t = setup({ accounts: saved });
  assert.equal((await t.fetchAll())[0].status, "ok");
  assert.equal(t.env.keychain.has("SPLIB_VERIFIED_MEMBERS_V1"), true);
});

// 같은 SID를 순차 재사용하는 서버. 이 테스트의 계정/비밀번호/회원번호는 모두 합성 값이다.
function sequentialReuseSetup({ override, mem = members(), accounts = [AO, BO] } = {}) {
  return setup({ accounts, mem, opts: { override: async (req, ctx, lib) => {
    const changed = override ? await override(req, ctx, lib) : null;
    if (changed) return changed;
    if (ctx.path.endsWith("memberLoginProc.do")) {
      lib.sessions.set("SYNTHETIC_SHARED_SEQUENTIAL", new URLSearchParams(req.body).get("userId"));
      return { status: 302, location: "/intro/index.do", setSession: "SYNTHETIC_SHARED_SEQUENTIAL" };
    }
    return null;
  } } });
}

test("SID reuse: a failed final ID proof hides that account without re-hiding an earlier verified snapshot", async () => {
  let bProofs = 0;
  const t = sequentialReuseSetup({ override: (req, ctx) => {
    if (ctx.path === "/intro/menu/10101/program/30045/memberModifyPwCheck.do" && ctx.userId === B.id && ++bProofs === 2)
      return { status: 200, body: `<div class="barcodeInfo">PersonB<span>22220002</span></div><input type="hidden" id="userId" name="userId" value="wrong-id">` };
    return null;
  } });
  const r = await t.fetchAll();
  assert.equal(r[0].status, "ok");
  assert.deepEqual(titles(r[0]), ["A 책 1", "A 책 2"]);
  assert.equal(r[1].status, "error");
  assert.equal(r[1].items.length, 0);
  assert.match(r[1].error, /같은 세션/);
  assert.deepEqual(JSON.parse(t.env.keychain.get(VKEY)).records.map(x => x.loginId), [A.id]);
});

test("SID reuse: incomplete list retains only owned rows after both final identity proofs", async () => {
  const t = sequentialReuseSetup({ override: (req, ctx) => ctx.userId === B.id && ctx.path === LOAN_PATH && ctx.page === 2 ? { throw: "synthetic timeout" } : null });
  const r = await t.fetchAll();
  assert.equal(r[0].status, "ok");
  assert.deepEqual(titles(r[0]), ["A 책 1", "A 책 2"]);
  assert.equal(r[1].status, "partial");
  assert.deepEqual(titles(r[1]), ["B 책 1"]);
  assert.equal(r[1].loanComplete, false);
  assert.ok(r[1].warnings.length > 0);
  assert.deepEqual(JSON.parse(t.env.keychain.get(VKEY)).records.map(x => x.loginId), [A.id, B.id]);
});

test("SID reuse: missing or foreign-scope proof membership cannot be forged by result flags", () => {
  const t = setup();
  const entries = [A, B].map((a, i) => ({ result: { ...t.run("errorResult")(a, ""), status: "ok" }, session: "SYNTHETIC_SHARED", observedIds: [i ? B.memberId : A.memberId], verifiedQueryComplete: true, source: "server", principalMatches: true }));
  const strict = plain(t.run("quarantineCollisions")(entries));
  assert.ok(strict.every(x => x.status === "error"));
  const foreign = t.run("new Map()");
  entries.forEach((e, i) => foreign.set({ ...e }, [A, B][i].id));
  assert.ok(plain(t.run("quarantineCollisions")(entries, foreign)).every(x => x.status === "error"));
});

test("SID reuse: same member or a page from another member still blocks every shared-session result", async () => {
  const same = sequentialReuseSetup({ mem: members({ bob: { memberId: A.memberId } }) });
  const a = await same.fetchAll();
  assert.ok(a.every(x => x.status === "error" && x.items.length === 0));
  assert.equal(same.env.keychain.has(VKEY), false);
  const mixed = sequentialReuseSetup({ override: (req, ctx, lib) => ctx.userId === A.id && ctx.path === LOAN_PATH ? { status: 200, body: listHtml("loan", lib.members.bob, ctx.page) } : null });
  const b = await mixed.fetchAll();
  assert.equal(b[0].status,"error");assert.equal(b[0].items.length,0);
  assert.equal(b[1].status,"ok");assert.deepEqual(titles(b[1]),["B 책 1"]);
  assert.deepEqual(JSON.parse(mixed.env.keychain.get(VKEY)).records.map(x=>x.loginId),[B.id]);
});

test("SID reuse: complete pages with only a data-quality warning remain correctly attributed snapshots", async () => {
  const t = sequentialReuseSetup({ mem: members({ alice: { loans: [{ title: "A own unlinked row", due: "2099.12.31" }] } }) });
  const [a, b] = await t.fetchAll();
  assert.notEqual(a.status, "error");
  assert.deepEqual(titles(a), ["A own unlinked row"]);
  assert.equal(b.status, "ok");
  assert.deepEqual(titles(b), ["B 책 1"]);
});

test("session extraction compares full JSESSIONID only, never a shared non-session cookie or disagreeing sources", () => {
  const extract = setup().run("extractSessionId");
  assert.throws(() => extract({ headers: { "Set-Cookie": "ROUTE=shared; Path=/" }, cookies: [{ name: "ROUTE", value: "shared", domain: "splib.or.kr" }] }), /새 세션/);
  assert.throws(() => extract({ headers: { "Set-Cookie": "JSESSIONID=SYNTHETIC_HEADER; Path=/" }, cookies: [{ name: "JSESSIONID", value: "SYNTHETIC_OTHER", domain: "splib.or.kr" }] }), /여러 개/);
});

test("six-account model: four proven sequential SID reuses succeed while two independent failures stay failures", async () => {
  const labels = ["A", "B", "C", "D", "E", "F"];
  const accounts = labels.map(n => ({ label: n, id: `fixture${n}`, pw: `synthetic-${n}` }));
  const mem = Object.fromEntries(accounts.map((a, i) => [a.id, { pw: i === 4 ? "different-synthetic-password" : a.pw, name: `Person${a.label}`, memberId: `SYNTH${String(i + 1).padStart(4, "0")}`, plain: true, loans: books(a.label, 1), doo: [] }]));
  const t = setup({ accounts, mem, opts: { override: (req, ctx, lib) => {
    if (ctx.path.endsWith("memberLoginProc.do")) {
      const id = new URLSearchParams(req.body).get("userId");
      if (accounts.filter((_, i) => i !== 4).some(a => a.id === id)) {
        lib.sessions.set("SYNTHETIC_FOUR_SHARED", id);
        return { status: 302, location: "/intro/index.do", setSession: "SYNTHETIC_FOUR_SHARED" };
      }
    }
    if (ctx.userId === "fixtureF" && ctx.path === "/intro/menu/10101/program/30045/memberModifyPwCheck.do") return { status: 503, body: "synthetic unavailable" };
    return null;
  } } });
  const r = await t.fetchAll();
  for (let i = 0; i < 4; i++) {
    assert.equal(r[i].status, "ok");
    assert.deepEqual(titles(r[i]), [`${labels[i]} 책 1`]);
  }
  assert.ok(r.slice(4).every(x => x.status === "error" && x.items.length === 0));
  assert.ok(!/같은 세션/.test(r[4].error));
  assert.match(r[5].error, /회원정보/);
  const cache = JSON.parse(t.env.keychain.get(VKEY));
  assert.equal(cache.records.length, 4);
});

test("numeric page end: a verified p.paging control avoids requesting a nonexistent page", async () => {
  const t = setup({accounts:[A], opts:{override:(req,ctx,lib)=>{
    if (ctx.path !== LOAN_PATH && ctx.path !== DOO_PATH) return null;
    const kind = ctx.path===LOAN_PATH ? "loan" : "doo";
    return {status:200,body:listHtml(kind,lib.members.alice,1).replace('<div class="paging"></div>',`<p class="paging"><strong>1</strong><a onclick="fnList(1)">마지막</a></p>`)};
  }}});
  const [a] = await t.fetchAll();
  assert.equal(a.status,"ok");
  assert.deepEqual(titles(a),["A 책 1","A 책 2"]);
  assert.ok(t.env.log.requests.filter(r=>r.url.includes("StatusList.do")).every(r=>!r.url.includes("currentPageNo=2")));
  const parse=t.run("parsePagination");
  assert.equal(parse('<p class="paging"><a onclick="fnList(2)">2</a></p>'),null);
  assert.equal(parse('<template><p class="paging"><strong>1</strong></p></template>'),null);
  for (const action of ["goPage(2)", "fnList(2,10)", "nextBlock()"]) assert.equal(parse(`<p class="paging"><strong>1</strong><a onclick="${action}" href="#">2</a></p>`),null);
});

test("fair account budget: early account cannot starve a later login", async () => {
  const t=setup();
  t.run("clock.now = (()=>{let now=0; return ()=>{now+=25;return now}})()");
  const results=plain(await t.run("fetchAllAccounts")([A,B],3000));
  assert.equal(t.env.log.requests.filter(r=>r.method==="POST").length,2);
  assert.equal(results.length,2);
});

test("observed numeric paging: span.current on p.paging and javascript fnList links",()=>{
 const parse=setup().run("parsePagination");
 assert.deepEqual(plain(parse(`<p class="paging"><a href="javascript:fnList(1);">처음</a><span class="current">1</span><a href="javascript:fnList(2);">2</a><a href="javascript:fnList(23);">마지막</a></p>`)),{current:1,lastVisible:23});
 assert.deepEqual(plain(parse(`<p class="paging"><span class="current">1</span></p>`)),{current:1,lastVisible:1});
 assert.equal(parse(`<p class="paging"><span class="current">1</span><span class="current">2</span></p>`),null);
});

test("Python-compatible read-only item identifiers: checkbox and return-delay link; conflicts fail closed",()=>{
 const t=setup();const parse=t.run("rowCopyIdentifiers");const row=t.run("parseLoanRow");
 const check=`<input name="check" type="checkbox" value="REC_SYNTH^REG_SYNTH^MA^X^Y">`;
 const link=`<button onclick="javascript:fnReturnDelayProc('REC_SYNTH','REG_SYNTH','MA',''); return false;">반납연기</button>`;
 for (const html of [check,link,check+link]) {
  const out=parse(html);assert.equal(out.loan,"REC_SYNTH");assert.equal(out.copy,"REG_SYNTH");assert.equal(out.accepted,true);
  const loan=row(`<div class="title">Synthetic</div><strong>Synthetic library</strong><span>반납예정일 : 2099.12.31</span>`+html);
  assert.equal(loan.ids.loan,"REC_SYNTH");assert.equal(loan.ids.copy,"REG_SYNTH");
 }
 assert.equal(parse(check+link.replaceAll("REG_SYNTH","OTHER_SYNTH")).ambiguous,true);
 assert.equal(parse(`<input name="check" value="REC^REG^MA^X^Y" value="OTHER^REG^MA^X^Y">`).ambiguous,true);
 assert.equal(parse(`<template>${check}</template>`).accepted,false);
 assert.equal(parse(`<button onclick="fnReturnDelayProc('REC','REG','MA'); doOtherAction()">x</button>`).accepted,false);
 const conflict=row(`<input name="regNo" value="DIFFERENT">`+loanRow({title:"Synthetic"})+check);
 assert.equal(conflict.ids.copy,null);assert.equal(conflict.ambiguousIds,true);
});

test("collected lists with unresolved item links show one title item and no metadata-only warning",async()=>{
 const t=setup({accounts:[A],mem:members({alice:{loans:[{title:"Same synthetic title"}],doo:[{title:"Same synthetic title",status:"입수"}]}})});
 const [d]=await t.fetchAll();assert.equal(d.loanComplete,true);assert.equal(d.dooComplete,true);assert.equal(d.status,"partial");
 assert.equal(d.items.length,2);assert.ok(d.items.every(x=>x.qualityNotes.includes("대출·상호대차 연결 미확정")));
 const html=t.run("buildHtmlPage")([d]);assert.match(html,/목록 조회 완료/);assert.match(html,/목록 1건 · 기록 2건/);assert.doesNotMatch(html,/일부 계정·목록만 확인됨|연결 미확정|class="warn-box"/);
});

test("progress callback publishes only final-proven accounts before the next login, without early binding writes",async()=>{
 const t=setup({accounts:[{...A,memberId:undefined},{...B,memberId:undefined}]});const frames=[];
 const result=await t.run("fetchAllAccounts")([{...A,memberId:undefined},{...B,memberId:undefined}],60000,true,async snapshot=>{
  frames.push(plain(snapshot));
  if(snapshot.results.length===1){assert.equal(t.env.log.requests.filter(r=>r.method==="POST").length,1);assert.equal(t.env.keychain.has(VKEY),false);assert.deepEqual(titles(snapshot.results[0]),["A 책 1","A 책 2"]);}
 });
 assert.deepEqual(frames.map(f=>f.results.length),[0,1,2]);assert.equal(result.results.length,2);
 const placeholders=plain(t.run("progressResults")([A,B],frames[1]));assert.equal(placeholders[1].status,"pending");assert.equal(placeholders[1].items.length,0);
});

test("progressive WebView is presented before queries finish and final render permits dismissal",async()=>{
 const t=setup();await t.run("main")();
 assert.match(t.env.log.frames[0],/조회 중 · 0\/2/);assert.ok(!t.env.log.frames[0].includes("A 책 1"));
 assert.ok(t.env.log.frames.some(h=>h.includes("A 책 1")&&h.includes("대기")===false&&h.includes("조회 중")));
 assert.ok(t.env.log.html[0].includes("B 책 1"));
});

test("renderer yields native presentation before first DOM update and omits aria-busy", async()=>{
 const t=setup();await t.run("main")();
 assert.equal(t.env.log.timers[0],1500);
 assert.equal(t.env.log.frames.filter(h=>h.includes("조회 중 · 0/2")).length,1,"initial DOM is not needlessly replaced during presentation");
 assert.doesNotMatch(readFileSync(TRACKER,"utf8"),/setAttribute\("aria-busy"/);
});

test("a native DOM update that never settles returns failure within the bounded wait",async()=>{
 const t=setup();const before=Date.now();
 const ok=await t.run("updateProgressView")({evaluateJavaScript(){return new Promise(()=>{});}},t.run("progressResults")([A,B],{results:[],activeIndex:0}));
 assert.equal(ok,false);assert.ok(Date.now()-before<5000);
});

test("late progress cannot replace a final document after timeout fallback",async()=>{
 const t=setup();const finalHtml=t.run("buildHtmlPage")([]);
 assert.match(finalHtml,/window\.__songpaFinal=true/);
 let changed=false;const document={body:{set innerHTML(v){changed=true;},setAttribute(){}}};
 const view={evaluateJavaScript(code){return vm.runInNewContext(code,{document,window:{__songpaFinal:true,scrollY:0,scrollTo(){}}});}};
 const ok=await t.run("updateProgressView")(view,t.run("progressResults")([A],{results:[],activeIndex:0}));
 assert.equal(ok,false);assert.equal(changed,false);
});


// ================================================================ v1.2.5 표시 전용 "같은 책 추정" 묶음 (합성 값만)
const OWN_W = "송파위례도서관";
const OWN_G = "송파거마도서관";
const OWN_M = "송파글마루도서관";
function groupBuild(loanHtml, dooHtml) {
  const run = loadScript(TRACKER, createEnv().globals);
  const ls = loanHtml.map((h) => run("parseLoanRow")(h));
  const ds = dooHtml.map((h) => run("parseDooraeRow")(h));
  return plain(run("buildMemberBooks")(ls, ds, "u", { loanPages: 1, dooPages: 1 }));
}
const groupsOf = (r) => [...new Set(r.items.map((i) => i.displayGroup).filter(Boolean))];
const withOwnerLabel = (row, label) => row.replace('<div class="statusBox">', `${label}<div class="statusBox">`);

test("display group: one unmatched loan + one active ILL with same full title and confirmed owner; records/counts/statuses/warnings preserved", () => {
  const ill = dooRow({ title: "같은 책 1", status: "입수", providing: OWN_W, receiving: OWN_G });
  const g = groupBuild([loanRow({ title: "같은 책 1", lib: OWN_W })], [ill]);
  const u = groupBuild([loanRow({ title: "같은 책 1", lib: OWN_M })], [ill]);
  assert.equal(groupsOf(g).length, 1);
  assert.equal(groupsOf(u).length, 0);
  for (const r of [g, u]) {
    assert.equal(r.items.length, 2);
    assert.equal(r.loanCount, 1);
    assert.equal(r.pickupCount, 1);
    assert.equal(r.transitCount, 0);
    assert.deepEqual(r.items.map((i) => i.statusType).sort(), ["대출중", "픽업필요"]);
    assert.ok(r.items.every((i) => i.qualityNotes.includes("대출·상호대차 연결 미확정")));
  }
  assert.deepEqual(g.warnings, u.warnings, "grouping adds or removes no warning");
  assert.equal(g.uncertain, u.uncertain);
  assert.ok(g.items.every((i) => i.displayGroup === groupsOf(g)[0]));
  const loan = g.items.find((i) => i.statusType === "대출중");
  assert.equal(loan.lib, OWN_W, "return location is not moved by a guess");
  assert.equal(loan.isInter, false);
  // 엔티티·공백 정리만: 같은 제목으로 본다
  assert.equal(groupsOf(groupBuild([loanRow({ title: "톰 &amp; 제리", lib: OWN_W })], [dooRow({ title: "톰 & 제리", status: "발송", providing: OWN_W })])).length, 1);
});

test("display group: booksole row library is never owner evidence; only an explicit owning-library field enables grouping", () => {
  const ill = dooRow({ title: "책솔이 책", status: "발송", providing: OWN_W, receiving: OWN_G });
  const sole = (extra = "", lib = OWN_W) => withOwnerLabel(loanRow({ title: "책솔이 책", lib, booksole: true }), extra);
  assert.equal(groupsOf(groupBuild([sole()], [ill])).length, 0, "booksole rawLib equal to provider is not enough");
  assert.equal(groupsOf(groupBuild([sole("", OWN_G)], [ill])).length, 0, "receiving-library equality is not enough");
  assert.equal(groupsOf(groupBuild([sole(`<span>소장도서관 : ${OWN_W}</span>`)], [ill])).length, 1);
  assert.equal(groupsOf(groupBuild([sole(`<p><span class="tit">제공도서관 : </span>${OWN_W}</p>`, OWN_G)], [ill])).length, 1);
  for (const bad of [
    `<span>소장도서관 : ${OWN_M}</span>`,
    `<span>소장도서관 : </span>`,
    `<span>소장도서관 : ${OWN_W}</span><span>제공도서관 : ${OWN_M}</span>`,
    `<template><span>소장도서관 : ${OWN_W}</span></template>`,
    `<!-- <span>소장도서관 : ${OWN_W}</span> -->`
  ]) {
    const r = groupBuild([sole(bad)], [ill]);
    assert.equal(groupsOf(r).length, 0, bad);
    assert.equal(r.items.length, 2, bad);
  }
});

test("display group stays off: missing provider, duplicates, title variants, differing copies, inactive history, conflicting owner, unknown library", () => {
  const loan = (o = {}) => loanRow({ title: "제목", lib: OWN_W, ...o });
  const ill = (o = {}) => dooRow({ title: "제목", status: "입수", providing: OWN_W, receiving: OWN_G, ...o });
  const noProvider = `<div class="myArticle-list"><div class="title">제목</div><p><span class="tit">수령도서관 : </span>${OWN_W}</p><div class="statusBox">입수</div></div>`;
  assert.equal(groupsOf(groupBuild([loan()], [ill()])).length, 1, "control");
  const cases = {
    "ILL without providing library (receiving equals loan library)": [[loan()], [noProvider]],
    "two loans with the same title": [[loan(), loan({ due: "2099.11.30" })], [ill()]],
    "two active ILL with the same title": [[loan()], [ill(), ill({ status: "발송" })]],
    "different volume": [[loan({ title: "제목 1" })], [ill({ title: "제목 2" })]],
    "punctuation-only difference is not normalized away": [[loan({ title: "제목 (상)" })], [ill({ title: "제목 상" })]],
    "different copy IDs in the same owner": [[loan({ regNo: "COPY001" })], [ill({ regNo: "COPY002" })]],
    "inactive history": [[loan()], [ill({ status: "완료" })]],
    "explicit owner conflicts with non-booksole row library": [[withOwnerLabel(loan(), `<span>소장도서관 : ${OWN_M}</span>`)], [ill()]],
    "loan library unknown": [[loan({ lib: " " })], [ill()]]
  };
  for (const [name, [ls, ds]] of Object.entries(cases)) {
    const r = groupBuild(ls, ds);
    assert.equal(groupsOf(r).length, 0, name);
    assert.equal(r.items.length, r.loanCount + r.pickupCount + r.transitCount, name);
  }
});

test("display group: exact identifier joins keep priority and are never mixed into a guess", () => {
  const loan = loanRow({ title: "제목", lib: OWN_W, loanKey: "L1", regNo: "COPY001" });
  const joinedIll = dooRow({ title: "제목", status: "발송", illKey: "I1", regNo: "COPY001", providing: OWN_W, receiving: OWN_G });
  const j = groupBuild([loan], [joinedIll]);
  assert.equal(j.items.length, 1);
  assert.equal(j.items[0].lib, OWN_G);
  assert.equal(groupsOf(j).length, 0);
  const extra = groupBuild([loan], [joinedIll, dooRow({ title: "제목", status: "입수", providing: OWN_W, receiving: OWN_G })]);
  assert.equal(extra.items.length, 2);
  assert.equal(extra.pickupCount, 1);
  assert.equal(groupsOf(extra).length, 0, "joined loan is not re-paired with another ILL");
});

test("display group never crosses accounts", async () => {
  const t = setup({ mem: members({ alice: { loans: [{ title: "공유 제목", lib: OWN_W }] }, bob: { loans: [], doo: [{ title: "공유 제목", status: "입수", providing: OWN_W }] } }) });
  const [a, b] = await t.fetchAll();
  assert.equal(a.items.length, 1);
  assert.equal(b.items.length, 1);
  assert.equal(groupsOf(a).length + groupsOf(b).length, 0);
});

test("title display rendering: same-title loan + ILL is one row with compact per-record blocks; data order and raw metadata unchanged", async () => {
  const t = setup({
    accounts: [A],
    mem: members({ alice: {
      loans: [{ title: "묶음 책", lib: OWN_W, due: "2099.12.31" }, { title: "중간 책", lib: OWN_M, loanKey: "MID1", regNo: "MID001", due: "2099.06.01" }],
      doo: [{ title: "묶음 책", status: "입수", providing: OWN_W }]
    } })
  });
  const [d] = await t.fetchAll();
  assert.equal(d.items.length, 3);
  assert.equal(d.loanCount, 2);
  assert.equal(d.pickupCount, 1);
  assert.equal(groupsOf(d).length, 1, "old conservative metadata may remain internally (unused by rendering)");
  assert.deepEqual(d.items.map((i) => i.title), ["묶음 책", "중간 책", "묶음 책"], "data order is unchanged");
  const html = t.run("buildHtmlPage")([d]);
  const body = html.slice(html.indexOf("<tbody>"));
  assert.doesNotMatch(html, /같은 책 추정|group-head|data-display-group/);
  assert.equal(body.split('class="title-text">묶음 책<').length - 1, 1, "full title rendered once");
  assert.equal(body.split('class="title-text">').length - 1, 2, "two displayed items");
  assert.equal(body.split('class="rec-block"').length - 1, 1, "loan record rendered as the active block");
  assert.equal(body.split('class="rec-block rec-history"').length - 1, 1, "stale arrived ILL kept as neutral history block");
  assert.deepEqual([...body.matchAll(/class="col-num">(\d+)</g)].map((m) => m[1]), ["1", "2"]);
  assert.ok(body.indexOf("묶음 책") < body.indexOf("중간 책"));
  assert.doesNotMatch(body, /badge-pickup|tag-pickup|pickup-highlight|픽업필요/, "loan group shows no pickup action");
  assert.match(body, /<details class="rec-history-box"><summary>이전 상호대차 기록 1건<\/summary>/);
  assert.equal(d.pickupCount, 1, "raw pickup count preserved");
  assert.match(body, /badge-dday/);
  assert.equal(body.split("badge-loan").length - 1, 1, "대출중 badge only in the grouped loan block");
  assert.match(body, /반납 2099\.12\.31/);
  assert.doesNotMatch(html, /식별번호로는 미확인/);
  assert.match(html, /목록 2건 · 기록 3건/);
  assert.doesNotMatch(html, /총 \d+권/);
});

test("title display helper: only NFC/whitespace normalization; volume, subtitle and punctuation stay separate; same-kind and empty titles stay separate", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const loan = (title) => ({ title, statusType: "대출중", diffDays: 5 });
  const ill = (title, statusType = "픽업필요") => ({ title, statusType, diffDays: -999 });
  const count = (items) => plain(run("displayTitleGroups")(items)).length;
  assert.equal(count([loan("제목 1"), ill("제목 2")]), 2, "volume");
  assert.equal(count([loan("제목: 부제"), ill("제목")]), 2, "subtitle");
  assert.equal(count([loan("제목 (상)"), ill("제목 상")]), 2, "punctuation");
  assert.equal(count([loan("제목."), ill("제목")]), 2, "trailing punctuation");
  assert.equal(count([loan("톰  &  제리 "), ill(" 톰 & 제리")]), 1, "whitespace only");
  assert.equal(count([loan("\u1100\u1161 책"), ill("가 책")]), 1, "NFC");
  assert.equal(count([loan("같은 대출"), loan("같은 대출")]), 2, "same-status duplicates stay separate");
  assert.equal(count([ill("같은 신청"), ill("같은 신청", "이동중")]), 2, "ILL-only same title stays separate");
  assert.equal(count([loan(""), ill("")]), 2, "empty titles never grouped");
  const items = [ill("묶음"), loan("다른"), loan("묶음"), ill("묶음", "이동중")];
  const groups = plain(run("displayTitleGroups")(items));
  assert.deepEqual(groups.map((g) => g.records.length), [3, 1]);
  assert.equal(groups.flatMap((g) => g.records).length, items.length, "every record kept once");
  assert.equal(readFileSync(TRACKER, "utf8").includes("displayRowOrder"), false);
});

const withMeta = (row, html) => {
  assert.ok(row.includes('<div class="statusBox">'), "fixture has a statusBox insertion point");
  return withOwnerLabel(row, html);
};
const metaLabel = (label, value) => `<p><span class="tit">${label} : </span>${value}</p>`;

test("display group metadata: shared explicit 권차/판사항/ISBN must agree; conflict or ambiguity blocks only the guess", () => {
  const L = (m = "") => withMeta(loanRow({ title: "메타 책", lib: OWN_W }), m);
  const D = (m = "") => withMeta(dooRow({ title: "메타 책", status: "입수", providing: OWN_W, receiving: OWN_G }), m);
  const base = groupBuild([L()], [D()]);
  assert.equal(groupsOf(base).length, 1, "control without metadata");
  const check = (r, name) => {
    assert.equal(r.items.length, 2, name);
    assert.equal(r.loanCount, 1, name);
    assert.equal(r.pickupCount, 1, name);
    assert.equal(r.transitCount, 0, name);
    assert.deepEqual(r.items.map((i) => i.statusType).sort(), ["대출중", "픽업필요"], name);
    assert.deepEqual(r.warnings, base.warnings, name);
    assert.equal(r.uncertain, base.uncertain, name);
  };
  const grouped = {
    "equal 권차": [metaLabel("권차", "1"), metaLabel("권차", "1")],
    "equal edition across label variants": [metaLabel("판사항", "개정판"), metaLabel("판차", "개정판")],
    "equal ISBN with formatting": [metaLabel("ISBN", "979-0-000000-00-1"), metaLabel("ISBN", "9790000000001")],
    "metadata on one side only is not a conflict": [metaLabel("권차", "1"), ""],
    "inert template region is not read": [metaLabel("권차", "1"), `<template>${metaLabel("권차", "2")}</template>`]
  };
  for (const [name, [lm, dm]] of Object.entries(grouped)) {
    const r = groupBuild([L(lm)], [D(dm)]);
    assert.equal(groupsOf(r).length, 1, name);
    check(r, name);
  }
  const separate = {
    "volume 1 vs 2 (separate labels)": [metaLabel("권차", "1"), metaLabel("권차", "2")],
    "edition revised vs original (separate labels)": [metaLabel("판사항", "개정판"), metaLabel("판본", "초판")],
    "differing ISBN": [metaLabel("ISBN", "9790000000001"), metaLabel("ISBN", "9790000000002")],
    "conflicting volumes inside one row": [metaLabel("권차", "1") + metaLabel("권차", "2"), metaLabel("권차", "1")],
    "blank volume label is ambiguous": [metaLabel("권차", ""), metaLabel("권차", "1")],
    "malformed ISBN is ambiguous": [metaLabel("ISBN", "X-1"), metaLabel("ISBN", "9790000000001")]
  };
  for (const [name, [lm, dm]] of Object.entries(separate)) {
    const r = groupBuild([L(lm)], [D(dm)]);
    assert.equal(groupsOf(r).length, 0, name);
    check(r, name);
  }
});

test("display metadata is display-only: not in record fingerprint, ids or stable keys", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const row = (v) => run("parseLoanRow")(withMeta(loanRow({ title: "지문 책", lib: OWN_W, loanKey: "FP1" }), metaLabel("권차", v)));
  const a = row("1");
  const b = row("2");
  assert.equal(run("recordFingerprint")(a), run("recordFingerprint")(b));
  assert.equal(a.stableKey, b.stableKey);
  assert.deepEqual(plain(a.ids), plain(b.ids));
  assert.deepEqual(plain(a.displayMeta.fields), { volume: "1" });
});

test("display group: placeholder owning/providing library strings are unknown, never owner evidence", () => {
  const realIll = dooRow({ title: "자리 책", status: "입수", providing: OWN_W, receiving: OWN_G });
  for (const ph of ["미확인", "알 수 없음", "알수없음", "소장도서관 미확인", "소장도서관미확인", "-"]) {
    const both = groupBuild([loanRow({ title: "자리 책", lib: ph })], [dooRow({ title: "자리 책", status: "입수", providing: ph, receiving: OWN_G })]);
    assert.equal(groupsOf(both).length, 0, `same placeholder on loan and provider: ${ph}`);
    assert.equal(both.items.length, 2, ph);
    const sole = withMeta(loanRow({ title: "자리 책", lib: OWN_W, booksole: true }), `<span>소장도서관 : ${ph}</span>`);
    assert.equal(groupsOf(groupBuild([sole], [realIll])).length, 0, `booksole explicit placeholder: ${ph}`);
  }
});

test("v1.2.6 title-display-1: display totals say 건; progressive guards preserved", async () => {
  const run = loadScript(TRACKER, createEnv().globals);
  assert.equal(run("SCRIPT_VERSION"), "1.2.7");
  assert.equal(run("NATIVE_PROBE_BUILD"), "return-location-1");
  assert.equal(run("NATIVE_TRACE"), false);
  const t = setup();
  const html = t.run("buildHtmlPage")(await t.fetchAll());
  assert.match(html, /목록 3건 이용/);
  assert.doesNotMatch(html, /기록 \d+건/, "record note only when counts differ");
  assert.doesNotMatch(html, /총 \d+권/);
  const w = await renderWidget({});
  assert.match(w.text, /총 3건/);
  assert.doesNotMatch(w.text, /총 \d+권/);
  const src = readFileSync(TRACKER, "utf8");
  assert.match(src, /Timer\.schedule\(1500,false,resolve\)/);
  assert.match(src, /Timer\.schedule\(2500,false/);
  assert.match(src, /window\.__songpaFinal=\$\{s\.pending===0\}/);
});

// ================================================================ v1.2.6 같은 계정·같은 전체 제목 화면 묶음 (합성 값만)
const tbodyOf = (html) => html.slice(html.indexOf("<tbody>"));
const titleCells = (html, title) => tbodyOf(html).split(`class="title-text">${title}<`).length - 1;
const titleWidgetTexts = async (t, data) => (await t.run("createWidget")(data, null)).texts;

test("title display: same full title loan + ILL without owner evidence is one displayed item; raw records, statuses and due dates kept", async () => {
  const t = setup({ accounts: [A], mem: members({ alice: { loans: [{ title: "같은 제목 책", lib: OWN_M, due: "2099.10.15" }], doo: [{ title: "같은 제목 책", status: "입수", providing: OWN_W }] } }) });
  const [d] = await t.fetchAll();
  assert.equal(d.items.length, 2);
  assert.equal(d.loanCount, 1);
  assert.equal(d.pickupCount, 1);
  assert.deepEqual(d.items.map((i) => i.statusType).sort(), ["대출중", "픽업필요"]);
  assert.equal(d.status, "partial", "raw data-quality status is unchanged");
  assert.ok(d.warnings.some((w) => w.includes("제목이 같은 상호대차")), "raw warning kept internally");
  assert.deepEqual(d.displayWarnings, []);
  assert.deepEqual(d.collectionWarnings, []);
  const s = plain(t.run("summarizeResults")([d]));
  assert.equal(s.items, 2);
  assert.equal(s.displayItems, 1);
  const html = t.run("buildHtmlPage")([d]);
  const body = tbodyOf(html);
  assert.equal(titleCells(html, "같은 제목 책"), 1);
  assert.equal(body.split('data-record-count="2"').length - 1, 1);
  assert.doesNotMatch(body, /badge-pickup|tag-pickup|pickup-highlight|픽업필요/);
  assert.match(body, /badge-loan/);
  assert.match(body, /반납 2099\.10\.15/);
  assert.match(body, /도착 기록 \(현재 대출 중\)/);
  assert.match(body, new RegExp(`도착도서관: ${OWN_G} <span class="prov-text">\\(소장: ${OWN_W}\\)</span>`), "historical libraries retained");
  assert.match(body, new RegExp(`반납처: ${OWN_M}`));
  assert.doesNotMatch(html, /class="warn-box"/);
  assert.doesNotMatch(html, /연결 미확정|중복 여부 미확정|같은 책 추정|일부만 확인/);
  assert.match(html, /목록 1건 · 기록 2건 이용/);
  assert.match(html, /class="tab-count">1</);
  assert.match(html, /class="badge-total">1건 · 기록 2건</);
  const texts = await titleWidgetTexts(t, [d]);
  assert.equal(texts.filter((x) => x.includes("같은 제목 책")).length, 1);
  assert.ok(texts.some((x) => /^\[D-\d+\] $/.test(x)), "loan is the only status tag on the widget row");
  assert.ok(texts.every((x) => !x.includes("픽업필요")), "no pickup action for a title already on loan");
  assert.ok(texts.every((x) => !x.includes("⚠️") && !x.includes("식별번호")));
});

test("title display: different libraries and distinct IDs still group by full title; exact ID join stays first", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const r = groupBuild(
    [loanRow({ title: "식별 책", lib: OWN_M, loanKey: "L1", regNo: "COPY001" })],
    [dooRow({ title: "식별 책", status: "발송", illKey: "I9", regNo: "COPY777", providing: OWN_W, receiving: OWN_G })]
  );
  assert.equal(r.items.length, 2, "raw records unchanged");
  const groups = plain(run("displayTitleGroups")(r.items));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].records.map((x) => x.statusType).sort(), ["대출중", "이동중"]);
  const j = groupBuild(
    [loanRow({ title: "식별 책", lib: OWN_W, loanKey: "L1", regNo: "COPY001" })],
    [dooRow({ title: "식별 책", status: "발송", illKey: "I1", regNo: "COPY001", providing: OWN_W, receiving: OWN_G })]
  );
  assert.equal(j.items.length, 1, "exact join happens before the display layer");
  assert.equal(j.items[0].lib, OWN_G);
  assert.equal(plain(run("displayTitleGroups")(j.items)).length, 1);
});

test("title display: one loan + two active ILL with the same title render as one item with all three states", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const r = groupBuild([loanRow({ title: "셋 책", lib: OWN_M })], [
    dooRow({ title: "셋 책", status: "입수", providing: OWN_W, receiving: OWN_G }),
    dooRow({ title: "셋 책", status: "발송", providing: OWN_M, receiving: OWN_G })
  ]);
  assert.equal(r.items.length, 3);
  assert.equal(r.loanCount, 1);
  assert.equal(r.pickupCount, 1);
  assert.equal(r.transitCount, 1);
  const d = { ...r, name: "u", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: r.displayIssues };
  const html = run("buildHtmlPage")([d]);
  const body = tbodyOf(html);
  assert.equal(titleCells(html, "셋 책"), 1);
  assert.equal(body.split('data-record-count="3"').length - 1, 1);
  assert.equal(body.split("badge-status badge-pickup").length - 1, 0, "stale arrived ILL in a loan group is not a pickup action");
  assert.equal(body.split('class="rec-block rec-history"').length - 1, 1, "arrived ILL kept as neutral history");
  assert.ok(body.indexOf("badge-status badge-loan") < body.indexOf("badge-status badge-transit"), "loan block first");
  assert.ok(body.indexOf("badge-status badge-transit") < body.indexOf("rec-history-box"), "history after active records");
  assert.equal(body.split("badge-status badge-transit").length - 1, 1);
  assert.equal(body.split("badge-status badge-loan").length - 1, 1);
  assert.deepEqual([...body.matchAll(/class="col-num">(\d+)</g)].map((m) => m[1]), ["1"]);
  assert.match(html, /목록 1건 · 기록 3건/);
});

test("title display never crosses accounts", async () => {
  const t = setup({ mem: members({ alice: { loans: [{ title: "공유 제목", lib: OWN_W }] }, bob: { loans: [], doo: [{ title: "공유 제목", status: "입수", providing: OWN_W }] } }) });
  const data = await t.fetchAll();
  const html = t.run("buildHtmlPage")(data);
  assert.equal(titleCells(html, "공유 제목"), 2);
  assert.doesNotMatch(html, /data-record-count=/);
  const s = plain(t.run("summarizeResults")(data));
  assert.equal(s.displayItems, s.items);
});

test("genuine collection, identity and partial-page problems stay visible while ID-only notes are hidden", async () => {
  const t = setup({
    accounts: [A],
    mem: members({ alice: { loans: books("P", 12) } }),
    opts: { override: (req, ctx) => (ctx.path === LOAN_PATH && ctx.page === 2 ? { throw: "offline (synthetic)" } : null) }
  });
  const [d] = await t.fetchAll();
  assert.equal(d.status, "partial");
  assert.equal(d.loanComplete, false);
  assert.equal(d.collectionWarnings.length, 1);
  assert.match(d.collectionWarnings[0], /2페이지를 불러오지 못했습니다/);
  assert.deepEqual(d.displayWarnings.slice(0, 1), d.collectionWarnings);
  const html = t.run("buildHtmlPage")([d]);
  assert.match(html, /class="warn-box"/);
  assert.match(html, /2페이지를 불러오지 못했습니다/);
  assert.match(html, /일부 계정·목록만 확인됨/);
  const texts = await titleWidgetTexts(t, [d]);
  assert.ok(texts.some((x) => x.includes("일부만 확인")));
  const bad = setup({ accounts: [{ ...A, memberId: "99990009" }] });
  const [e] = await bad.fetchAll();
  assert.equal(e.status, "error");
  assert.match(bad.run("buildHtmlPage")([e]), /class="err-box"/);
});


test("release defaults leave native diagnostic files unwritten", async()=>{
 const t=setup();assert.equal(t.run("NATIVE_TRACE"),false);
 await t.run("main")();
 assert.equal(t.env.files.has("/local/Library/songpa-render-stage-safe.json"),false);
 assert.equal(t.env.files.has("/local/Library/songpa-native-safe-trace.json"),false);
});

test("explicit existing trace flag still writes only safe diagnostic fields", async()=>{
 const t=setup();const src=readFileSync(TRACKER,"utf8");
 assert.equal(src.split("const NATIVE_TRACE = false;").length-1,1);
 const candidate=src.replace("const NATIVE_TRACE = false;","const NATIVE_TRACE = true;").replace(/\nawait main\(\);\s*\nScript\.complete\(\);\s*$/,"\n");
 const ctx=vm.createContext({...t.env.globals});vm.runInContext(candidate,ctx);await vm.runInContext("main()",ctx);
 const stage=JSON.parse(t.env.files.get("/local/Library/songpa-render-stage-safe.json"));
 assert.deepEqual(Object.keys(stage).sort(),["atMs","build","stage"]);
 assert.equal(stage.stage,"FINAL_RENDER_DONE");
 const raw=t.env.files.get("/local/Library/songpa-native-safe-trace.json");assert.ok(raw);
 const trace=JSON.parse(raw);assert.deepEqual(Object.keys(trace).sort(),["accounts","build","progress"]);
 for(const a of trace.accounts){
  assert.deepEqual(Object.keys(a).sort(),["dooComplete","identifierEvidence","index","loanComplete","status","trace"]);
  assert.ok(Object.values(a.identifierEvidence).every(v=>typeof v==="boolean"));
 }
 const both=JSON.stringify(stage)+raw;
 for(const value of [A.id,A.pw,A.memberId,B.id,B.pw,B.memberId,"김하나","이두리","A 책 1","B 책 1",...t.lib.issued]){
  assert.equal(both.includes(value),false,"diagnostics must omit synthetic identity, credential, title and session values");
 }
});

// ================================================================ v1.2.6 title-display-2 화면 요약 대표 상태 (합성 값만)
test("display summary: mixed loan+pickup group plus unmatched pickup and transit counts each displayed item once (loan > pickup > transit)", async () => {
  const t = setup();
  const r = groupBuild([loanRow({ title: "혼합 책", lib: OWN_M })], [
    dooRow({ title: "혼합 책", status: "입수", providing: OWN_W, receiving: OWN_G }),
    dooRow({ title: "단독 픽업 책", status: "입수", providing: OWN_W, receiving: OWN_G }),
    dooRow({ title: "단독 이동 책", status: "발송", providing: OWN_M, receiving: OWN_G })
  ]);
  assert.equal(r.items.length, 4);
  assert.equal(r.loanCount, 1);
  assert.equal(r.pickupCount, 2);
  assert.equal(r.transitCount, 1);
  const d = { ...r, name: "u", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: [] };
  const itemsBefore = JSON.stringify(d.items);
  const warningsBefore = JSON.stringify(d.warnings);
  const s = plain(t.run("summarizeResults")([d]));
  assert.equal(s.items, 4);
  assert.equal(s.displayItems, 3);
  assert.equal(s.displayLoans, 1);
  assert.equal(s.displayPickups, 1);
  assert.equal(s.displayTransits, 1);
  assert.equal(s.displayLoans + s.displayPickups + s.displayTransits, s.displayItems);
  assert.equal(s.loans, 1, "raw loan counter kept");
  assert.equal(s.pickups, 2, "raw pickup counter kept");
  assert.equal(s.transits, 1, "raw transit counter kept");
  const html = t.run("buildHtmlPage")([d]);
  const head = html.slice(0, html.indexOf("<tbody>"));
  assert.match(head, /대출 1건 · 🔔 픽업 1건 · 🚚 이동 1건/);
  assert.match(head, /대출 1권/);
  assert.match(head, /픽업필요 1권/);
  assert.match(head, /이동중 1권/);
  assert.doesNotMatch(head, /픽업 2건|픽업필요 2권/);
  const body = tbodyOf(html);
  assert.equal(body.split('data-record-count="2"').length - 1, 1);
  assert.equal(body.split("badge-status badge-pickup").length - 1, 1, "only the standalone pickup is actionable");
  assert.equal(body.split('class="rec-block rec-history"').length - 1, 1, "mixed-group arrived ILL kept as neutral history");
  assert.equal(body.split("badge-status badge-transit").length - 1, 1);
  assert.equal(body.split("badge-status badge-loan").length - 1, 1);
  assert.doesNotMatch(html, /연결 미확정|중복 여부 미확정/);
  const texts = await titleWidgetTexts(t, [d]);
  assert.ok(texts.some((x) => x.includes("🔔 픽업 1 · 대출 1")), "widget header uses displayed counters");
  assert.ok(texts.every((x) => !x.includes("픽업 2")));
  assert.equal(texts.filter((x) => /^\[(D-\d+|오늘 반납|연체 \d+일)\] $/.test(x)).length, 1, "mixed group: loan tag only, no pickup action");
  assert.equal(texts.filter((x) => x === "[픽업필요] ").length, 1, "standalone pickup stays actionable");
  assert.equal(texts.filter((x) => x.includes("혼합 책")).length, 1);
  assert.equal(JSON.stringify(d.items), itemsBefore, "items not mutated");
  assert.equal(JSON.stringify(d.warnings), warningsBefore, "warnings not mutated");
  const same = groupBuild([], [
    dooRow({ title: "같은 종류 책", status: "입수", providing: OWN_W, receiving: OWN_G }),
    dooRow({ title: "같은 종류 책", status: "입수", providing: OWN_M, receiving: OWN_G })
  ]);
  assert.equal(plain(t.run("displayTitleGroups")(same.items)).length, same.items.length, "same-kind-only duplicates stay separate");
  const ss = plain(t.run("summarizeResults")([{ ...same, name: "v", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: [] }]));
  assert.equal(ss.displayPickups, same.items.length);
  assert.equal(ss.displayPickups, ss.displayItems);
});

test("display summary never crosses accounts: same title counted per account", async () => {
  const t = setup({ mem: members({
    alice: { loans: [{ title: "교차 제목", lib: OWN_M, due: "2099.10.15" }], doo: [{ title: "교차 제목", status: "입수", providing: OWN_W }] },
    bob: { loans: [], doo: [{ title: "교차 제목", status: "입수", providing: OWN_W }] }
  }) });
  const data = await t.fetchAll();
  const mixed = data.find((d) => (d.items || []).some((i) => i.statusType === "대출중"));
  const lone = data.find((d) => d !== mixed);
  assert.ok(mixed && lone);
  const sm = plain(t.run("summarizeResults")([mixed]));
  assert.deepEqual([sm.displayItems, sm.displayLoans, sm.displayPickups, sm.displayTransits], [1, 1, 0, 0]);
  assert.equal(sm.pickups, 1, "raw pickup kept for mixed account");
  const sl = plain(t.run("summarizeResults")([lone]));
  assert.deepEqual([sl.displayItems, sl.displayLoans, sl.displayPickups, sl.displayTransits], [1, 0, 1, 0]);
  const s = plain(t.run("summarizeResults")(data));
  assert.deepEqual([s.displayItems, s.displayLoans, s.displayPickups, s.displayTransits], [2, 1, 1, 0]);
  assert.equal(s.pickups, 2, "raw total unchanged");
  const html = t.run("buildHtmlPage")(data);
  assert.equal(titleCells(html, "교차 제목"), 2);
  assert.equal(tbodyOf(html).split('data-record-count="2"').length - 1, 1);
  assert.doesNotMatch(html, /연결 미확정|중복 여부 미확정/);
  const texts = await titleWidgetTexts(t, data);
  assert.equal(texts.filter((x) => x.includes("교차 제목")).length, 2);
});

// ================================================================ v1.2.6 title-display-3 대출 묶음의 지난 도착 상호대차 (합성 값만)
const TD3_PICKUP_ACTION = /badge-pickup|tag-pickup|pickup-highlight|픽업필요/;

test("title-display-3: loan + stale arrived ILL with the same full title: loan first, neutral collapsed history, no pickup action in HTML or widget; raw data unchanged", async () => {
  const t = setup();
  const r = groupBuild([loanRow({ title: "지난 도착 책", lib: OWN_M, due: "2099.10.15" })], [
    dooRow({ title: "지난 도착 책", status: "입수", providing: OWN_W, receiving: OWN_G })
  ]);
  assert.equal(r.items.length, 2);
  assert.equal(r.loanCount, 1);
  assert.equal(r.pickupCount, 1);
  const pickup = r.items.find((i) => i.statusType === "픽업필요");
  const loan = r.items.find((i) => i.statusType === "대출중");
  assert.ok(pickup && loan);
  const d = { ...r, items: [pickup, loan], name: "u", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: [] };
  const itemsBefore = JSON.stringify(d.items);
  const warningsBefore = JSON.stringify(d.warnings);
  const s = plain(t.run("summarizeResults")([d]));
  assert.deepEqual([s.items, s.displayItems, s.displayLoans, s.displayPickups, s.displayTransits], [2, 1, 1, 0, 0]);
  assert.deepEqual([s.loans, s.pickups, s.transits], [1, 1, 0], "raw counters kept");
  const html = t.run("buildHtmlPage")([d]);
  const body = tbodyOf(html);
  assert.equal(titleCells(html, "지난 도착 책"), 1);
  assert.equal(body.split('data-record-count="2"').length - 1, 1, "both raw records still belong to the displayed item");
  assert.doesNotMatch(body, TD3_PICKUP_ACTION);
  assert.doesNotMatch(html.slice(0, html.indexOf("<tbody>")), /픽업/, "no pickup counter in header or stats");
  assert.equal(body.split('class="rec-block"').length - 1, 1, "only the loan is an active block");
  assert.match(body, /<details class="rec-history-box"><summary>이전 상호대차 기록 1건<\/summary><div class="rec-block rec-history">/);
  assert.doesNotMatch(body, /<details[^>]*\bopen\b/, "history collapsed by default");
  assert.match(body, /도착 기록 \(현재 대출 중\)/);
  assert.match(body, new RegExp(`도착도서관: ${OWN_G} <span class="prov-text">\\(소장: ${OWN_W}\\)</span>`), "historical receiving/providing libraries retained");
  assert.ok(body.indexOf("badge-status badge-loan") < body.indexOf("rec-history-box"), "loan block first although the ILL record is first in items");
  assert.match(body, /반납 2099\.10\.15/);
  assert.match(body, new RegExp(`반납처: ${OWN_M}`));
  assert.doesNotMatch(body, /같은 책|동일/, "no physical copy identity claim");
  assert.doesNotMatch(html, /class="warn-box"/);
  assert.doesNotMatch(html, /연결 미확정|중복 여부 미확정|같은 책 추정|일부만 확인/);
  const texts = await titleWidgetTexts(t, [d]);
  assert.equal(texts.filter((x) => x.includes("지난 도착 책")).length, 1);
  assert.ok(texts.some((x) => /^\[D-\d+\] $/.test(x)), "loan tag only");
  assert.ok(texts.every((x) => !x.includes("픽업")), "no pickup tag or counter in the widget");
  assert.equal(JSON.stringify(d.items), itemsBefore, "items not mutated");
  assert.equal(JSON.stringify(d.warnings), warningsBefore, "warnings not mutated");
  assert.equal(d.items[0].statusType, "픽업필요", "raw pickup status preserved");
  assert.equal(d.items[1].dueDate, loan.dueDate, "raw due date preserved");
  assert.equal(d.pickupCount, 1);
});

test("title-display-3: standalone arrived ILL stays actionable; another account's loan never suppresses it", async () => {
  const t = setup({ mem: members({
    alice: { loans: [{ title: "교차 픽업 책", lib: OWN_M, due: "2099.10.15" }], doo: [{ title: "교차 픽업 책", status: "입수", providing: OWN_W }] },
    bob: { loans: [], doo: [{ title: "교차 픽업 책", status: "입수", providing: OWN_W }] }
  }) });
  const data = await t.fetchAll();
  const mixed = data.find((d) => (d.items || []).some((i) => i.statusType === "대출중"));
  const lone = data.find((d) => d !== mixed);
  assert.ok(mixed && lone);
  assert.equal(mixed.pickupCount, 1, "raw pickup kept for the loan account");
  assert.equal(lone.pickupCount, 1);
  const loneBody = tbodyOf(t.run("buildHtmlPage")([lone]));
  assert.equal(loneBody.split("badge-status badge-pickup").length - 1, 1);
  assert.match(loneBody, /tag-pickup/);
  assert.match(loneBody, /pickup-highlight/);
  assert.doesNotMatch(loneBody, /rec-history/);
  const all = tbodyOf(t.run("buildHtmlPage")(data));
  assert.equal(all.split("badge-status badge-pickup").length - 1, 1, "the other account's standalone pickup stays actionable");
  assert.equal(all.split('class="rec-block rec-history"').length - 1, 1);
  const texts = await titleWidgetTexts(t, data);
  assert.equal(texts.filter((x) => x === "[픽업필요] ").length, 1);
  assert.equal(texts.filter((x) => x.includes("교차 픽업 책")).length, 2);
  const loneTexts = await titleWidgetTexts(t, [lone]);
  assert.ok(loneTexts.some((x) => x === "[픽업필요] "));
});

test("title-display-3: differing full title and same-kind pickup duplicates are never suppressed", async () => {
  const t = setup();
  const r = groupBuild([loanRow({ title: "경계 책 1", lib: OWN_M })], [
    dooRow({ title: "경계 책 2", status: "입수", providing: OWN_W, receiving: OWN_G })
  ]);
  const d = { ...r, name: "u", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: [] };
  const body = tbodyOf(t.run("buildHtmlPage")([d]));
  assert.doesNotMatch(body, /data-record-count=|rec-history/);
  assert.equal(body.split("badge-status badge-pickup").length - 1, 1);
  assert.equal((await titleWidgetTexts(t, [d])).filter((x) => x === "[픽업필요] ").length, 1);
  const same = groupBuild([], [
    dooRow({ title: "같은 종류 픽업 책", status: "입수", providing: OWN_W, receiving: OWN_G }),
    dooRow({ title: "같은 종류 픽업 책", status: "입수", providing: OWN_M, receiving: OWN_G })
  ]);
  assert.equal(same.pickupCount, same.items.length);
  const sd = { ...same, name: "v", status: "partial", loanComplete: true, dooComplete: true, displayWarnings: [] };
  const sb = tbodyOf(t.run("buildHtmlPage")([sd]));
  assert.equal(sb.split("badge-status badge-pickup").length - 1, same.items.length);
  assert.doesNotMatch(sb, /rec-history/);
  assert.equal((await titleWidgetTexts(t, [sd])).filter((x) => x === "[픽업필요] ").length, same.items.length);
});

test("title-display-3 helper: displayGroupView puts loans first (nearest due first), keeps transit active, moves arrived ILL to history only with a loan; never mutates", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  const p = Object.freeze({ title: "도움 책", statusType: "픽업필요", diffDays: -999, shortLib: "가" });
  const tr = Object.freeze({ title: "도움 책", statusType: "이동중", diffDays: -999, shortLib: "나" });
  const l1 = Object.freeze({ title: "도움 책", statusType: "대출중", diffDays: 9, shortLib: "다" });
  const l2 = Object.freeze({ title: "도움 책", statusType: "대출중", diffDays: 2, shortLib: "라" });
  const group = Object.freeze({ title: "도움 책", records: Object.freeze([p, tr, l1, l2]) });
  const v = run("displayGroupView")(group);
  assert.equal(v.primary, l2);
  assert.deepEqual(Array.from(v.active, (x) => x.shortLib), ["라", "다", "나"]);
  assert.deepEqual(Array.from(v.history, (x) => x.shortLib), ["가"]);
  assert.deepEqual(Array.from(group.records, (x) => x.shortLib), ["가", "나", "다", "라"], "original order kept");
  const lone = run("displayGroupView")({ title: "단독", records: [p] });
  assert.equal(lone.primary, p);
  assert.deepEqual(Array.from(lone.active, (x) => x.statusType), ["픽업필요"]);
  assert.equal(lone.history.length, 0);
});

// ================================================================ v1.2.7 return-location-1 책솔이 표시 전용 반납처 (가상 도서관·제목만)
const RL_OWN = "가상소장관";
const RL_RECV = "가상스마트수령관";
const RL_TITLE = "가상 반납처 책";
const rlLoan = (o = {}) => loanRow({ title: RL_TITLE, lib: RL_OWN, booksole: true, due: "2099.10.15", ...o });
const rlIll = (o = {}) => dooRow({ title: RL_TITLE, status: "완료", providing: RL_OWN, receiving: RL_RECV, ...o });
const rlRawIll = (status, inner, title = RL_TITLE) => `<div class="myArticle-list"><div class="title">${title}</div>${inner}<div class="statusBox">${status}</div></div>`;
const rlLoanItems = (r) => r.items.filter((i) => i.statusType === "대출중");
const rlSummary = (html) => (html.match(/<div class="lib-summary">([\s\S]*?)<\/div>/) || [null, ""])[1];
const rlWidget = async (run, data) => (await run("createWidget")(data, null)).texts;
function rlBuild(loanHtml, dooHtml) {
  const run = loadScript(TRACKER, createEnv().globals);
  const ls = loanHtml.map((h) => run("parseLoanRow")(h));
  const ds = dooHtml.map((h) => run("parseDooraeRow")(h));
  const before = JSON.stringify([ls, ds]);
  const r = plain(run("buildMemberBooks")(ls, ds, "u", { loanPages: 1, dooPages: 1 }));
  assert.equal(JSON.stringify([ls, ds]), before, "raw parse records are not mutated");
  const d = { ...r, name: "u", status: r.uncertain ? "partial" : "ok", loanComplete: true, dooComplete: true, displayWarnings: r.displayIssues };
  return { run, r, d };
}

test("return-location: booksole loan + unique same-full-title receipt (입수 and 완료, no copy IDs) shows receiving as return and providing as owner; raw fields/counts unchanged", async () => {
  for (const status of ["입수", "완료"]) {
    const { run, r, d } = rlBuild([rlLoan()], [rlIll({ status })]);
    assert.equal(r.loanCount, 1, status);
    assert.equal(r.pickupCount, status === "입수" ? 1 : 0, `${status}: raw pickup counter unchanged`);
    assert.equal(r.transitCount, 0, status);
    assert.equal(r.items.length, status === "입수" ? 2 : 1, `${status}: completed ILL never becomes an item`);
    assert.deepEqual(r.libSummary, { [RL_OWN]: 1 }, `${status}: raw libSummary unchanged`);
    const [loan] = rlLoanItems(r);
    assert.equal(loan.lib, RL_OWN, status);
    assert.equal(loan.provLib, RL_OWN, status);
    assert.equal(loan.shortLib, RL_OWN, status);
    assert.equal(loan.isInter, true, status);
    assert.equal(loan.dueDate, "2099.10.15", status);
    assert.equal(loan.displayLocation, "resolved", status);
    assert.equal(loan.displayReturnLib, RL_RECV, status);
    assert.equal(loan.displayOwnerLib, RL_OWN, status);
    assert.notEqual(loan.displayReturnLib, loan.displayOwnerLib, status);
    const html = run("buildHtmlPage")([d]);
    const body = tbodyOf(html);
    assert.ok(body.includes(`📍반납처: <strong>${RL_RECV}</strong> <span class="prov-text">(소장: ${RL_OWN})</span>`), status);
    assert.ok(!body.includes(`반납처: <strong>${RL_OWN}</strong>`), `${status}: owning library is not shown as return`);
    assert.doesNotMatch(body, TD3_PICKUP_ACTION, `${status}: no pickup action`);
    assert.doesNotMatch(html, /class="warn-box"/, status);
    const summary = rlSummary(html);
    assert.ok(summary.includes("📍<strong>스마트</strong>: 1권"), `${status}: ${summary}`);
    assert.ok(!summary.includes(RL_OWN), status);
    const texts = await rlWidget(run, [d]);
    assert.ok(texts.some((x) => x.includes(`${RL_TITLE} (스마트)`)), status);
    assert.ok(texts.every((x) => !x.includes(`(${RL_OWN})`) && !x.includes("픽업")), status);
    const s = plain(run("summarizeResults")([d]));
    assert.deepEqual([s.displayItems, s.displayLoans, s.displayPickups, s.displayTransits], [1, 1, 0, 0], status);
  }
});

test("return-location: repeated identical pair, equal explicit copy ID, and raw library already equal to receiving still resolve", () => {
  const cases = {
    "same pair repeated": [[rlLoan()], [rlIll(), rlIll({ status: "입수" })], RL_RECV],
    "equal explicit copy IDs": [[rlLoan({ regNo: "COPYA01" })], [rlIll({ regNo: "COPYA01" })], RL_RECV],
    "raw library already the receiving library": [[rlLoan({ lib: RL_RECV })], [rlIll()], RL_RECV]
  };
  for (const [name, [ls, ds, ret]] of Object.entries(cases)) {
    const { r } = rlBuild(ls, ds);
    const [loan] = rlLoanItems(r);
    assert.equal(loan.displayLocation, "resolved", name);
    assert.equal(loan.displayReturnLib, ret, name);
    assert.equal(loan.displayOwnerLib, RL_OWN, name);
  }
});

test("return-location: missing/conflicting/ignored-status evidence shows neutral 반납처 미확인 with the raw library labelled, never owner-as-return", async () => {
  const cases = {
    "no receipt evidence": [[rlLoan()], [], RL_OWN],
    "missing receiving library": [[rlLoan()], [rlRawIll("완료", `<p><span class="tit">제공도서관 : </span>${RL_OWN}</p>`)], RL_OWN],
    "missing providing library": [[rlLoan()], [rlRawIll("완료", `<p><span class="tit">수령도서관 : </span>${RL_RECV}</p>`)], RL_OWN],
    "placeholder receiving library": [[rlLoan()], [rlIll({ receiving: "미확인" })], RL_OWN],
    "conflicting receiving/provider pairs": [[rlLoan()], [rlIll(), rlIll({ receiving: "가상다른수령관" })], RL_OWN],
    "conflicting raw loan library": [[rlLoan({ lib: "가상무관관" })], [rlIll()], "가상무관관"],
    "cancelled/returning/in-transit/request/unknown statuses only": [[rlLoan()], ["신청취소", "복귀중", "발송", "요청중", "보류"].map((status) => rlIll({ status })), RL_OWN]
  };
  for (const [name, [ls, ds, raw]] of Object.entries(cases)) {
    const { run, r, d } = rlBuild(ls, ds);
    assert.equal(r.loanCount, 1, name);
    const [loan] = rlLoanItems(r);
    assert.equal(loan.displayLocation, "unknown", name);
    assert.equal(loan.displayReturnLib, undefined, name);
    assert.equal(loan.displayOwnerLib, undefined, name);
    assert.equal(loan.lib, raw, `${name}: raw lib unchanged`);
    assert.equal(loan.provLib, raw, `${name}: raw provLib unchanged`);
    const html = run("buildHtmlPage")([d]);
    const body = tbodyOf(html);
    assert.ok(body.includes("반납처 미확인"), name);
    assert.ok(body.includes(`대출목록 도서관: ${raw}`), name);
    assert.ok(!body.includes("반납처: <strong>"), `${name}: no confirmed return`);
    assert.ok(!body.includes(`(소장: ${raw})`), `${name}: raw value not shown as owner`);
    assert.doesNotMatch(body, /badge-pickup|tag-pickup|pickup-highlight/, name);
    const summary = rlSummary(html);
    assert.ok(summary.includes("📍<strong>반납처 미확인</strong>: 1권"), `${name}: ${summary}`);
    assert.ok(!summary.includes(raw), name);
    const texts = await rlWidget(run, [d]);
    assert.ok(texts.some((x) => x.includes(`${RL_TITLE} (미확인`)), name);
    assert.ok(texts.every((x) => !x.includes(raw)), name);
  }
});

test("return-location: duplicate loans, explicit copy mismatch, title-volume/subtitle mismatch, ambiguous IDs and normal loans never borrow a historical location", () => {
  const dup = rlBuild([rlLoan(), rlLoan({ due: "2099.11.20" })], [rlIll()]);
  assert.equal(dup.r.loanCount, 2);
  for (const loan of rlLoanItems(dup.r)) {
    assert.equal(loan.displayLocation, "unknown");
    assert.equal(loan.displayReturnLib, undefined);
  }
  const ambiguousIll = rlRawIll("완료", `<input type="hidden" name="illKey" value="RLI1"><input type="hidden" name="illKey" value="RLI2">` +
    `<p><span class="tit">제공도서관 : </span>${RL_OWN}</p><p><span class="tit">수령도서관 : </span>${RL_RECV}</p>`);
  const cases = {
    "explicit copy mismatch": [[rlLoan({ regNo: "COPYA01" })], [rlIll({ regNo: "COPYB02" })]],
    "title volume mismatch": [[rlLoan({ title: "가상 권 책 1" })], [rlIll({ title: "가상 권 책 2" })]],
    "subtitle is not stripped": [[rlLoan({ title: "가상 책: 부제" })], [rlIll({ title: "가상 책" })]],
    "ambiguous ILL IDs": [[rlLoan()], [ambiguousIll]]
  };
  for (const [name, [ls, ds]] of Object.entries(cases)) {
    const [loan] = rlLoanItems(rlBuild(ls, ds).r);
    assert.equal(loan.displayLocation, "unknown", name);
    assert.equal(loan.displayReturnLib, undefined, name);
    assert.equal(loan.lib, RL_OWN, name);
  }
  const normal = rlBuild([loanRow({ title: RL_TITLE, lib: RL_OWN, due: "2099.10.15" })], [rlIll()]);
  const [n] = rlLoanItems(normal.r);
  assert.equal(n.isInter, false, "normal loan is not marked booksole");
  assert.equal(n.displayLocation, undefined);
  assert.equal(n.lib, RL_OWN);
  const html = normal.run("buildHtmlPage")([normal.d]);
  const body = tbodyOf(html);
  assert.ok(body.includes(`📍반납처: ${RL_OWN}</div>`));
  assert.ok(!body.includes("책솔이") && !body.includes("반납처 미확인") && !body.includes(RL_RECV));
  assert.ok(rlSummary(html).includes(`📍<strong>${RL_OWN}</strong>: 1권`));
});

test("return-location: exact-ID join stays authoritative and unchanged even with conflicting same-title receipt history", () => {
  const { run, r, d } = rlBuild(
    [loanRow({ title: RL_TITLE, lib: RL_OWN, loanKey: "RLJ1", regNo: "COPYJ01" })],
    [dooRow({ title: RL_TITLE, status: "발송", illKey: "RLJI1", regNo: "COPYJ01", providing: RL_OWN, receiving: "가상조인수령관" }), rlIll()]
  );
  assert.equal(r.items.length, 1);
  const [loan] = rlLoanItems(r);
  assert.equal(loan.lib, "가상조인수령관");
  assert.equal(loan.provLib, RL_OWN);
  assert.equal(loan.isInter, true);
  assert.equal(loan.displayLocation, undefined);
  const body = tbodyOf(run("buildHtmlPage")([d]));
  assert.ok(body.includes("반납처: <strong>가상조인수령관</strong>"));
  assert.ok(!body.includes(RL_RECV));
});

test("return-location: another account's receipt never influences a booksole loan; same-account full flow resolves", async () => {
  const other = setup({ mem: members({
    alice: { loans: [{ title: RL_TITLE, lib: RL_OWN, booksole: true, due: "2099.10.15" }], doo: [] },
    bob: { loans: [], doo: [{ title: RL_TITLE, status: "완료", providing: RL_OWN, receiving: RL_RECV }] }
  }) });
  const data = await other.fetchAll();
  const [a, b] = data;
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].displayLocation, "unknown");
  assert.equal(a.items[0].lib, RL_OWN);
  assert.equal(b.items.length, 0);
  assert.equal(b.pickupCount, 0);
  const html = other.run("buildHtmlPage")(data);
  assert.ok(html.includes("반납처 미확인"));
  assert.ok(!html.includes(RL_RECV));

  const same = setup({ accounts: [A], mem: members({ alice: {
    loans: [{ title: RL_TITLE, lib: RL_OWN, booksole: true, due: "2099.10.15" }],
    doo: [{ title: RL_TITLE, status: "완료", providing: RL_OWN, receiving: RL_RECV }]
  } }) });
  const [s] = await same.fetchAll();
  assert.equal(s.items.length, 1);
  assert.equal(s.loanCount, 1);
  assert.equal(s.pickupCount, 0);
  assert.equal(s.items[0].displayReturnLib, RL_RECV);
  assert.equal(s.items[0].lib, RL_OWN);
  assert.deepEqual(s.libSummary, { [RL_OWN]: 1 });
  const shtml = same.run("buildHtmlPage")([s]);
  assert.ok(tbodyOf(shtml).includes(`📍반납처: <strong>${RL_RECV}</strong>`));
  const texts = (await same.run("createWidget")([s], null)).texts;
  assert.ok(texts.some((x) => x.includes(`${RL_TITLE} (스마트)`)));
});

test("return-location-1 release constants: version strictly newer than published 1.2.6, trace off", () => {
  const run = loadScript(TRACKER, createEnv().globals);
  assert.equal(run("SCRIPT_VERSION"), "1.2.7");
  assert.equal(run("NATIVE_PROBE_BUILD"), "return-location-1");
  assert.equal(run("NATIVE_TRACE"), false);
  assert.equal(run("isNewerVersion")(run("SCRIPT_VERSION"), "1.2.6"), true);
  assert.equal(run("isNewerVersion")("1.2.6", run("SCRIPT_VERSION")), false);
});
