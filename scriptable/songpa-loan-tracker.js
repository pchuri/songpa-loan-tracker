// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: magic;
// 송파구립도서관 대출 현황 - iOS Scriptable 위젯 + 전체 카드 화면
// https://github.com/pchuri/songpa-loan-tracker (MIT License)
// 계정은 songpa-accounts.js로 iOS 키체인에 저장한다. 이 파일에는 계정 정보를 넣지 않는다.

const SCRIPT_VERSION = "1.2.0";
const UPDATE_URL = "https://raw.githubusercontent.com/pchuri/songpa-loan-tracker/main/scriptable/songpa-loan-tracker.js";
const KEYCHAIN_KEY = "SPLIB_ACCOUNTS";
// 자동 업데이트는 이 메인 스크립트만 바꾼다. 계정 설정 스크립트는 사용자가 직접 새 버전으로 교체해야 한다.
const ACCOUNTS_SOURCE_URL = "https://github.com/pchuri/songpa-loan-tracker/blob/main/scriptable/songpa-accounts.js";
const ACCOUNTS_MIGRATION_NOTE =
  `v1.2부터 계정마다 회원번호가 필요합니다. 자동 업데이트는 songpa-accounts.js를 바꾸지 않으므로 ${ACCOUNTS_SOURCE_URL} 의 새 버전으로 직접 교체한 뒤 '계정 수정'에서 회원번호를 입력해주세요.`;

// 버전 비교 (remote > local 이면 true)
function isNewerVersion(remote, local) {
  const r = (remote || "").split(".").map(Number);
  const l = (local || "").split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rNum = r[i] || 0;
    const lNum = l[i] || 0;
    if (rNum > lNum) return true;
    if (rNum < lNum) return false;
  }
  return false;
}

// 공개 저장소의 최신 버전 확인 및 업데이트
async function checkUpdateIfNeeded() {
  try {
    const req = new Request(`${UPDATE_URL}?t=${Date.now()}`);
    req.timeoutInterval = 3;
    const remoteCode = await req.loadString();

    const match = remoteCode.match(/const\s+SCRIPT_VERSION\s*=\s*["']([^"']+)["']/);
    if (!match) return { hasUpdate: false };

    const remoteVer = match[1];
    if (isNewerVersion(remoteVer, SCRIPT_VERSION)) {
      if (config.runsInWidget) {
        return { hasUpdate: true, remoteVer };
      }

      const alert = new Alert();
      alert.title = "🚀 업데이트 알림";
      alert.message = `송파도서관 대출현황 새 버전(v${remoteVer})이 있습니다.\n(현재: v${SCRIPT_VERSION})\n\n` +
        (!isNewerVersion("1.2.0", remoteVer) ?`${ACCOUNTS_MIGRATION_NOTE}\n\n` : "") +
        "지금 업데이트하시겠습니까?";
      alert.addAction("지금 업데이트");
      alert.addCancelAction("나중에");

      const choice = await alert.presentAlert();
      if (choice === 0) {
        const fm = FileManager.iCloud();
        const scriptName = Script.name();
        const scriptPath = fm.joinPath(fm.documentsDirectory(), `${scriptName}.js`);
        fm.writeString(scriptPath, remoteCode);

        const done = new Alert();
        done.title = "업데이트 완료";
        done.message = `v${remoteVer} 버전으로 업데이트되었습니다.\n스크립트를 다시 실행해주세요.\n\n${ACCOUNTS_MIGRATION_NOTE}`;
        done.addAction("확인");
        await done.presentAlert();
        return { updated: true };
      }
    }
  } catch (e) {
    // 오프라인이거나 저장소 접근 불가 시 조용히 통과
  }
  return { hasUpdate: false };
}

// 위젯 색: 기기 라이트/다크 설정에 따라 자동으로 바뀐다
function themed(light, dark) {
  return Color.dynamic(new Color(light), new Color(dark));
}

function getAccounts() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    try {
      const parsed = JSON.parse(Keychain.get(KEYCHAIN_KEY));
      if (Array.isArray(parsed)) return parsed.filter(a => a && typeof a === "object");
    } catch (e) {
      console.warn("Keychain 파싱 오류");
    }
  }
  return [];
}

const BASE_URL = "https://splib.or.kr";
const LOGIN_URL = `${BASE_URL}/intro/program/memberLoginProc.do`;
const INDEX_URL = `${BASE_URL}/intro/index.do`;
const LOAN_URL = `${BASE_URL}/intro/program/mypage/loanStatusList.do`;
const DOO_URL = `${BASE_URL}/intro/program/mypage/dooraeLillStatusList.do`;
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const PAGE_SIZE = 10; // 참고용. 목록 끝 판단에는 쓰지 않는다 (서버 페이지 크기가 다를 수 있음)
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const ROW_CLASS = "myArticle-list";

// 실행 한도. 위젯은 실행 시간이 짧으므로 따로 둔다. (테스트에서 값을 바꿔 쓴다)
const LIMITS = {
  maxPages: 30,            // 목록 하나당 최대 페이지 (10건 × 30 = 300건)
  requestTimeoutSec: 10,
  widgetBudgetMs: 25000,
  appBudgetMs: 60000,
  leaseTtlMs: 120000       // 조회 예산보다 길게
};
const clock = { now: () => Date.now() };

// 진행 중인 상호대차 상태 (완료·복귀중·신청취소는 지난 이력)
const ACTIVE_DOO_STATUSES = ["입수", "발송", "요청중", "신청중"];
const INACTIVE_DOO_STATUSES = ["완료", "복귀중", "신청취소"];

// 로그인 실패도 HTTP 200으로 돌려주므로 응답 문구로 실패를 가려낸다 (데스크탑 앱과 동일)
const LOGIN_FAILURE_PATTERNS = [
  "로그인 정보가 올바르지 않거나",
  "비밀번호가 일치하지 않습니다",
  "회원번호가 일치하지 않습니다",
  "존재하지 않는 회원",
  "로그인에 실패",
  "회원정보가 없습니다"
];

const MISSING_MEMBER_ID_MESSAGE =
  `회원번호 미설정: songpa-accounts.js를 새 버전(${ACCOUNTS_SOURCE_URL})으로 교체 후 '계정 수정'에서 직접 확인한 회원번호 입력`; // safeMessage 160자 안에 들어가게 짧게

// ------------------------------------------------------------
// 화면 구조 가정 (실제 사이트에서 확인하지 못한 부분은 README에 적어 두었다)
// ------------------------------------------------------------

// 회원 신원: barcodeInfo 영역의 "회원번호 : 값" 같은 문구, 또는 회원 전용 이름의 필드만 쓴다.
// userId(로그인 아이디 hidden 값), bookKey·regNo 같은 책 식별자는 회원 신원으로 쓰지 않는다.
const MEMBER_ID_FIELDS = ["memberno", "membernum", "membernumber", "memberbarcode", "memberbarcodeno", "userbarcode"];
const MEMBER_ID_DATA_ATTRS = ["data-member-no", "data-member-barcode", "data-user-barcode"];
const MEMBER_ID_LABEL_RE = /(?:회원\s*번호|회원\s*바코드|바코드\s*번호|바코드)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,40})/g;

// 기록 식별자: 종류(namespace)별로 따로 본다. 서로 다른 종류끼리는 절대 맞춰 보지 않는다.
const LOAN_ID_SPEC = { fields: ["loankey", "loanno", "loanseq", "loanid"], dataAttrs: ["data-loan-key", "data-loan-no", "data-loan-id"] };
const ILL_ID_SPEC = { fields: ["illkey", "illno", "illreqkey", "dooraekey", "dooraeseq", "requestkey"], dataAttrs: ["data-ill-key", "data-request-key"] };
const COPY_ID_SPEC = {
  fields: ["regno", "registno", "accessionno"],
  dataAttrs: ["data-reg-no"],
  label: /등록\s*번호\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,40})/g
};

// 로그인된 빈 목록 표시 (가정). 이 표시와 목록 페이지 자기 주소가 함께 있어야 "0건"으로 본다.
const EMPTY_LIST_CONTAINERS = ["myArticleWrap", "list"];
const EMPTY_LIST_MARKERS = [/class\s*=\s*["'][^"']*\bno-?data\b/i, /(?:자료|내역|도서)(?:가|이)\s*없습니다/];

const LISTS = {
  loan: { name: "대출 목록", url: LOAN_URL, selfMarker: "loanStatusList.do", parseRow: parseLoanRow },
  doo: { name: "상호대차 목록", url: DOO_URL, selfMarker: "dooraeLillStatusList.do", parseRow: parseDooraeRow }
};

function failure(kind, message) {
  // kind: "integrity"(신원·인증·세션 문제 → 계정 결과 전부 숨김) / "page"(일반 페이지 오류) / 그 밖
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function abbreviateLibrary(name) {
  if (!name) return "";
  let clean = name.replace("송파", "").replace("도서관", "").trim();
  if (name.includes("잠실나루") || name.includes("스마트")) return "스마트";
  if (name.includes("어린이도서관") || name.includes("엘스")) return "엘스";
  if (name.includes("영어도서관") || name.includes("영어")) return "영어";
  if (name.includes("위례")) return "위례";
  if (name.includes("글마루")) return "글마루";
  if (name.includes("거마")) return "거마";
  if (name.includes("소나무언덕2호")) return "소나무2호";
  if (name.includes("소나무언덕잠실본동")) return "소나무본동";
  if (name.includes("소나무언덕4호")) return "소나무4호";
  return clean || name;
}

function normalizeTitle(t) {
  return (t || "").replace(/[\s:·\.,\(\)\[\]]/g, "").trim();
}

// 도서관 이름 → 등록번호·대출번호의 범위 키 (약칭으로 줄이지 않는다: 서로 다른 도서관이 겹치지 않게)
function libScope(name) {
  return htmlToText(name).replace(/\s+/g, "").toLowerCase();
}

// 달력에 실제로 있는 날짜인지 (2.30 같은 값이 다음 달로 넘어가지 않게)
function isValidDate(yy, mm, dd) {
  const y = Number(yy);
  const m = Number(mm);
  const d = Number(dd);
  if (!(m >= 1 && m <= 12 && d >= 1)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// "라벨 : 값" 읽기. 값이 라벨과 같은 <span> 안에 있는 형태와 </span> 뒤에 있는 형태를 모두 받는다.
const LABEL_SEP = "(?:\\s|&nbsp;|&#160;|&#x[aA]0;)*";
function labeledValue(row, labelSource) {
  const re = new RegExp(`${labelSource}${LABEL_SEP}(?:<\\/span>${LABEL_SEP})?[:：]${LABEL_SEP}(?:<\\/span>${LABEL_SEP})?([^<]*)`);
  const m = String(row || "").match(re);
  return m ? htmlToText(m[1]) : "";
}

function groupBy(list, keyOf) {
  const map = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&amp;/g, "&");
}

// HTML 태그를 지우고 엔티티를 풀어 한 줄 텍스트로 만든다
function htmlToText(s) {
  return decodeEntities((s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// 화면(WebView)에 넣을 때는 다시 이스케이프한다
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripComments(html) {
  return String(html || "").replace(/<!--[\s\S]*?-->/g, "");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 회원번호 정규화: 공백·하이픈 제거, 대문자. 영문·숫자 4~32자가 아니면 null (songpa-accounts.js와 같은 규칙)
function normalizeMemberId(value) {
  const s = String(value == null ? "" : value).replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(s) ? s : null;
}

function nameKey(name) {
  return String(name || "").replace(/\s+/g, "").replace(/님$/, "");
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 태그 하나의 속성을 소문자 키로 읽는다
function tagAttributes(tag) {
  const attrs = {};
  const re = /([^\s=<>\/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = m[1].toLowerCase();
    if (hasOwn(attrs, key)) continue;
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[key] = decodeEntities(raw || "");
  }
  return attrs;
}

// name/id가 허용 목록에 있는 태그의 value, 또는 허용된 data-* 속성 값만 모은다
function semanticValues(html, fieldNames, dataAttrs) {
  const out = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const a = tagAttributes(m[0]);
    const named = ["name", "id"].some(k => hasOwn(a, k) && fieldNames.includes(a[k].toLowerCase()));
    if (named && hasOwn(a, "value") && a.value.trim() !== "") out.push(a.value);
    for (const d of dataAttrs) {
      if (hasOwn(a, d) && a[d].trim() !== "") out.push(a[d]);
    }
  }
  return out;
}

// class 토큰이 일치하는 블록(<div>, 지정하면 <li>도)의 안쪽 HTML을 같은 태그의 중첩을 맞춰서 꺼낸다
function findDivBlocks(html, className, tags = ["div"]) {
  const blocks = [];
  const hasClass = tag => (tagAttributes(tag)["class"] || "").split(/\s+/).includes(className);
  const startRe = new RegExp(`<(${tags.join("|")})\\b[^>]*>`, "gi");
  let total = 0;
  let closed = true;
  let m;
  while ((m = startRe.exec(html))) if (hasClass(m[0])) total++;
  startRe.lastIndex = 0;
  while ((m = startRe.exec(html))) {
    if (!hasClass(m[0])) continue;
    const innerStart = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    const tokenRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, "gi");
    tokenRe.lastIndex = innerStart;
    let depth = 1;
    let end = html.length;
    let t;
    while ((t = tokenRe.exec(html))) {
      depth += t[0][1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    if (depth !== 0) closed = false;
    blocks.push(html.slice(innerStart, end));
    startRe.lastIndex = Math.max(end, innerStart);
  }
  return { blocks, wellFormed: closed && blocks.length === total };
}

// 페이지에서 회원 신원(회원번호)을 보수적으로 읽는다.
// status: "ok"(하나로 확정) / "missing"(없음) / "ambiguous"(서로 다른 값 또는 형식 오류)
function parseIdentity(html) {
  const clean = stripComments(html);
  const raw = [];
  const siteNames = [];
  for (const block of findDivBlocks(clean, "barcodeInfo").blocks) {
    const lead = block.match(/^\s*([^<]+)/);
    if (lead) {
      const name = htmlToText(lead[1]).replace(/(?:회원\s*번호|회원\s*바코드|바코드)[\s\S]*$/, "").trim();
      if (name) siteNames.push(name);
    }
    const re = new RegExp(MEMBER_ID_LABEL_RE.source, "g");
    const text = htmlToText(block);
    let m;
    while ((m = re.exec(text))) raw.push(m[1]);
  }
  raw.push(...semanticValues(clean, MEMBER_ID_FIELDS, MEMBER_ID_DATA_ATTRS));

  const ids = new Set();
  let invalid = false;
  for (const r of raw) {
    const id = normalizeMemberId(r);
    if (id) ids.add(id);
    else invalid = true;
  }
  const candidates = [...ids];
  let status = "missing";
  if (invalid || ids.size > 1) status = "ambiguous";
  else if (ids.size === 1) status = "ok";
  return { status, memberId: status === "ok" ? candidates[0] : null, candidates, siteNames };
}

// 행 안에서 종류별 기록 식별자를 읽는다. 값이 여러 개거나 형식이 이상하면 "모름"으로 본다.
function typedId(row, text, spec) {
  const raw = semanticValues(row, spec.fields, spec.dataAttrs);
  if (spec.label) {
    const re = new RegExp(spec.label.source, "g");
    let m;
    while ((m = re.exec(text))) raw.push(m[1]);
  }
  const values = new Set();
  let invalid = false;
  for (const r of raw) {
    const v = String(r).trim();
    if (/^[A-Za-z0-9._-]{1,64}$/.test(v)) values.add(v);
    else invalid = true;
  }
  if (!invalid && values.size === 1) return { value: [...values][0], ambiguous: false };
  return { value: null, ambiguous: invalid || values.size > 1 };
}

// 대출 행 하나. 제목·반납일이 없으면 null(형식 오류)
function parseLoanRow(row) {
  const tm = row.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
  const dueMatch = row.match(/반납(?:예정)?일\s*:\s*(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  const statusMatch = row.match(/<div class="statusBox"[^>]*>([\s\S]*?)<\/div>/);
  // 속성이 붙은 <strong class="..."> 와 안쪽 태그(<span> 등)도 받는다. 첫 <strong>의 텍스트만 쓴다.
  // 제목·상태 칸 안의 <strong>은 도서관으로 보지 않는다 (제목의 굵은 글씨를 도서관 범위로 쓰지 않게).
  let libArea = row;
  for (const m of [tm, statusMatch]) if (m) libArea = libArea.replace(m[0], " ");
  const libMatch = libArea.match(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i);
  if (!tm || !dueMatch) return null;
  const title = htmlToText(tm[1]);
  if (!title) return null;

  const [, yy, mm, dd] = dueMatch;
  if (!isValidDate(yy, mm, dd)) return null; // 달력에 없는 날짜는 형식 오류

  const text = htmlToText(row);
  const loanId = typedId(row, text, LOAN_ID_SPEC);
  const copyId = typedId(row, text, COPY_ID_SPEC);
  const rawLib = libMatch ? htmlToText(libMatch[1]) : "";
  const isBooksole = statusMatch ? statusMatch[1].includes("책솔이") : false;
  const lib = libScope(rawLib);
  const ids = { loan: loanId.value, copy: copyId.value };
  // 등록번호는 도서관마다 따로 매기므로 소장 도서관 범위로만 비교한다.
  // 책솔이 대출 행의 도서관은 수령 도서관일 수 있어 소장 도서관으로 보지 않는다(범위 모름 → 등록번호 비교 안 함).
  // 대출번호도 전역 유일성이 확인되지 않았으므로 행의 도서관 범위로 묶는다.
  // 도서관을 읽지 못하면 범위를 모르므로 범위 대출번호를 만들지 않는다('?' 범위로 합치지 않음).
  const scoped = {
    loan: ids.loan && lib ? `${lib}#${ids.loan}` : null,
    copy: ids.copy && lib && !isBooksole ? `${lib}#${ids.copy}` : null
  };
  const stableKey = scoped.loan ? `loan:${scoped.loan}` : scoped.copy ? `copy:${scoped.copy}` : null;
  return {
    title,
    normTitle: normalizeTitle(title),
    rawLib,
    yy, mm, dd,
    dueDateStr: `${yy}.${pad2(mm)}.${pad2(dd)}`,
    isBooksole,
    ids,
    scoped,
    ambiguousIds: loanId.ambiguous || copyId.ambiguous,
    stableKey,
    key: stableKey || `text:${text.slice(0, 300)}`
  };
}

// 상태 칸: "요청중 신청취소", "요청중신청취소", "요청중 <a>신청취소</a>"처럼 취소 버튼 문구가 붙는다.
// 공백을 없앤 뒤 끝의 "신청취소" 버튼 문구만 뗀다. 정확히 "신청취소"는 그 자체가 상태(지난 이력)다.
// 그 밖의 문구(예: "입수취소")는 바꾸지 않으므로 모르는 상태로 남는다.
const DOO_CANCEL_ACTION = "신청취소";
function dooraeStatus(cellHtml) {
  let s = htmlToText(cellHtml).replace(/\s+/g, "");
  if (s !== DOO_CANCEL_ACTION && s.endsWith(DOO_CANCEL_ACTION)) s = s.slice(0, -DOO_CANCEL_ACTION.length);
  return s;
}

// 상호대차 행 하나. 상태가 없거나 진행 중인데 제목이 없으면 null(형식 오류)
function parseDooraeRow(row) {
  const titleMatch = row.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
  const statusMatch = row.match(/<div class="statusBox"[^>]*>([\s\S]*?)<\/div>/);
  if (!statusMatch) return null;
  const status = dooraeStatus(statusMatch[1]);
  const title = titleMatch ? htmlToText(titleMatch[1]) : "";
  if (!status) return null;
  // 제목 없는 행: 지난 이력(복귀중 등)으로 확실할 때만 건너뛴다. 진행 중·모르는 상태면 형식 오류(일부 확인)
  if (!title) return INACTIVE_DOO_STATUSES.includes(status) ? { skip: true, key: `skip:${htmlToText(row).slice(0, 300)}` } : null;

  const text = htmlToText(row);
  const illId = typedId(row, text, ILL_ID_SPEC);
  const copyId = typedId(row, text, COPY_ID_SPEC);
  const providing = labeledValue(row, "제공\\s*도서관");
  const receiving = labeledValue(row, "수령\\s*도서관");
  const prov = libScope(providing);
  const recv = libScope(receiving);
  const ids = { ill: illId.value, copy: copyId.value };
  // 등록번호는 명시된 제공(소장) 도서관 범위로만 쓴다. 수령 도서관으로 소장처를 추정하지 않는다.
  // 제공·수령 도서관을 모두 읽었을 때만 경로 범위 신청번호를 만든다 ('?' 경로로 합치지 않음)
  const scoped = {
    ill: ids.ill && prov && recv ? `${prov}>${recv}#${ids.ill}` : null,
    copy: ids.copy && prov ? `${prov}#${ids.copy}` : null
  };
  const stableKey = scoped.ill ? `ill:${scoped.ill}` : null;
  return {
    title,
    normTitle: normalizeTitle(title),
    providing,
    receiving,
    status,
    isActive: ACTIVE_DOO_STATUSES.includes(status),
    isKnownStatus: ACTIVE_DOO_STATUSES.includes(status) || INACTIVE_DOO_STATUSES.includes(status),
    ids,
    scoped,
    ambiguousIds: illId.ambiguous || copyId.ambiguous,
    stableKey,
    key: stableKey || `text:${text.slice(0, 300)}`
  };
}

// 목록 페이지 한 장을 행 기록으로 바꾼다. 확인된 빈 목록이 아니면 0건으로 보지 않는다.
function parseListPage(spec, html) {
  const clean = stripComments(html);
  const { blocks, wellFormed } = findDivBlocks(clean, ROW_CLASS, ["div", "li"]);
  if (!wellFormed) return { error: "목록 HTML 구조가 올바르지 않음" };
  if (blocks.length === 0) {
    // 빈 목록 표시는 인식한 목록 영역(myArticleWrap / div.list) 안에 있을 때만 인정한다 (옆 영역의 noData로 0건 확정 금지)
    const containers = EMPTY_LIST_CONTAINERS.flatMap(c => findDivBlocks(clean, c).blocks);
    if (clean.includes(spec.selfMarker) && containers.some(b => EMPTY_LIST_MARKERS.some(re => re.test(b)))) {
      return { empty: true, records: [], rowKeys: [], fingerprint: "<empty>" };
    }
    return { error: "목록 형식을 인식하지 못함 (빈 목록 표시도 찾지 못함)" };
  }
  const records = [];
  const rowKeys = []; // 건너뛴 지난 이력 행까지 포함한 페이지 서명용
  const prints = [];
  for (const row of blocks) {
    const r = spec.parseRow(row);
    if (!r) return { error: "형식을 알 수 없는 항목이 있음" };
    rowKeys.push(r.key);
    prints.push(recordFingerprint(r));
    if (!r.skip) records.push(r);
  }
  return { records, rowKeys, fingerprint: prints.join("\n") };
}

// 재확인용 행 지문: 파싱한 안정 필드(식별번호·제목·날짜·도서관·상태)만 쓴다. page 같은 합성 필드나 HTML은 넣지 않는다.
function recordFingerprint(r) {
  if (r.skip) return JSON.stringify(["skip", r.key]);
  return JSON.stringify([
    r.title, r.dueDateStr || "", r.rawLib || "", r.isBooksole ? 1 : 0,
    r.status || "", r.providing || "", r.receiving || "",
    r.ids || {}, r.ambiguousIds ? 1 : 0, r.stableKey || ""
  ]);
}

// ------------------------------------------------------------
// 요청 / 응답 검사
// ------------------------------------------------------------

function headerValues(headers, name) {
  const out = [];
  if (!headers) return out;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== name) continue;
    const v = headers[k];
    if (Array.isArray(v)) out.push(...v.map(String));
    else if (v != null) out.push(String(v));
  }
  return out;
}

// 쿼리·조각·;jsessionid 를 뺀 주소
function urlPath(u) {
  return String(u || "").split(/[?#]/)[0].replace(/;jsessionid=[^\/]*/i, "");
}

function resolveSiteUrl(u) {
  if (!u) return null;
  if (u.startsWith("/") && !u.startsWith("//")) return BASE_URL + u;
  return u;
}

function isSiteUrl(u) {
  return u === BASE_URL || String(u).startsWith(`${BASE_URL}/`);
}

function isLoginUrl(u) {
  return /login/i.test(urlPath(u));
}

function looksLikeLoginPage(html) {
  return /<input\b[^>]*type\s*=\s*["']?password/i.test(html) ||
    /<form\b[^>]*action\s*=\s*["'][^"']*login/i.test(html);
}

// 로그인 응답에서 새로 받은 JSESSIONID 하나만 꺼낸다. 없거나 여럿이거나 이상하면 실패.
const JSESSIONID_VALUE_RE = /^[A-Za-z0-9._-]{8,256}$/;
function extractSessionId(response) {
  const values = new Set();
  for (const raw of headerValues(response.headers, "set-cookie")) {
    const re = /(?:^|[,;]\s*)JSESSIONID=([^;,\s]*)/gi;
    let m;
    while ((m = re.exec(raw))) if (m[1]) values.add(m[1]);
  }
  for (const c of response.cookies || []) {
    if (!c || String(c.name).toUpperCase() !== "JSESSIONID" || !c.value) continue;
    if (c.domain && !/(^|\.)splib\.or\.kr$/i.test(String(c.domain).replace(/^\./, ""))) continue;
    values.add(String(c.value));
  }
  if (values.size === 0) throw failure("integrity", "로그인 응답에 새 세션 쿠키(JSESSIONID)가 없어 조회하지 않았습니다");
  if (values.size > 1) throw failure("integrity", "로그인 응답의 세션 쿠키가 여러 개라 어느 것인지 판단할 수 없습니다");
  const [value] = values;
  if (!JSESSIONID_VALUE_RE.test(value)) throw failure("integrity", "로그인 응답의 세션 쿠키 형식이 올바르지 않습니다");
  return value;
}

// 리다이렉트는 따라가지 않는다(onRedirect → null). 세션이 있으면 Cookie를 직접 고정한다.
// 요청 하나의 제한 시간: 남은 예산을 넘지 않게 줄인다 (최소 1초)
function timeoutFor(ctx) {
  if (!ctx || typeof ctx.deadline !== "number") return LIMITS.requestTimeoutSec;
  const leftSec = (ctx.deadline - clock.now()) / 1000;
  return Math.max(1, Math.min(LIMITS.requestTimeoutSec, leftSec));
}

function newRequest(url, session, timeoutSec) {
  const req = new Request(url);
  req.timeoutInterval = timeoutSec || LIMITS.requestTimeoutSec;
  req.headers = { "User-Agent": USER_AGENT };
  if (session) req.headers["Cookie"] = `JSESSIONID=${session}`;
  req.onRedirect = () => null;
  return req;
}

async function login(account, ctx) {
  const req = newRequest(LOGIN_URL, null, timeoutFor(ctx));
  req.method = "POST";
  req.headers["Content-Type"] = "application/x-www-form-urlencoded";
  req.body = `userId=${encodeURIComponent(account.id)}&password=${encodeURIComponent(account.pw)}`;

  let body;
  try {
    body = (await req.loadString()) || "";
  } catch (e) {
    throw failure("network", "로그인 요청 실패 (네트워크)");
  }
  const res = req.response;
  if (!res || typeof res.statusCode !== "number") throw failure("integrity", "로그인 응답 상태를 확인할 수 없습니다");
  if (LOGIN_FAILURE_PATTERNS.some(p => body.includes(p))) {
    throw failure("auth", "로그인 실패 (아이디·비밀번호를 확인해주세요)");
  }

  const status = res.statusCode;
  if (REDIRECT_STATUSES.includes(status)) {
    const location = resolveSiteUrl(headerValues(res.headers, "location")[0]);
    if (!location || !isSiteUrl(location)) throw failure("auth", "로그인 응답이 예상하지 못한 곳으로 이동하려 합니다");
    if (isLoginUrl(location)) throw failure("auth", "로그인 후 다시 로그인 화면으로 이동 (로그인 실패로 판단)");
  } else if (status === 200) {
    if (!res.url || urlPath(res.url) !== LOGIN_URL) throw failure("integrity", "로그인 응답 주소가 요청과 다릅니다");
    if (looksLikeLoginPage(body)) throw failure("auth", "로그인 화면이 다시 표시됨 (로그인 실패로 판단)");
  } else {
    throw failure("auth", `로그인 응답 오류 (HTTP ${status})`);
  }
  return extractSessionId(res);
}

async function getPage(url, session, timeoutSec) {
  const req = newRequest(url, session, timeoutSec);
  let body;
  try {
    body = (await req.loadString()) || "";
  } catch (e) {
    throw failure("page", "네트워크 오류");
  }
  return { body, res: req.response };
}

// 로그인된 상태로 요청한 화면이 맞는지 확인한다
// 응답이 JSESSIONID를 명시적으로 내려보내면(값 변경·삭제·형식 오류·여러 개) 고정한 세션과 같은 값일 때만 허용한다.
// 응답에 쿠키가 없는 것은 정상이다.
function checkSessionNotRotated(res, session) {
  const seen = [];
  for (const raw of headerValues(res.headers, "set-cookie")) {
    const re = /(?:^|[,;]\s*)JSESSIONID=([^;,\s]*)/gi;
    let m;
    while ((m = re.exec(raw))) seen.push(m[1]);
    // 같은 값이라도 삭제 속성이면 삭제다. 쿠키 하나의 범위: 다음 ", 이름=" 전까지 (Expires 날짜 안의 쉼표는 건너뜀)
    // Max-Age가 있으면 Expires보다 우선한다 (RFC 6265). Max-Age <= 0 또는 형식 오류는 삭제로 본다.
    const cookieRe = /(?:^|,)\s*JSESSIONID=([^;,]*)((?:;[^;]*?)*?)(?=,\s*[^\s=;,]+=|$)/gi;
    while ((m = cookieRe.exec(raw))) {
      const attrs = m[2];
      const maxAges = [];
      const maRe = /;\s*max-age\s*=\s*([^;]*)/gi;
      let ma;
      while ((ma = maRe.exec(attrs))) maxAges.push(ma[1].trim());
      if (maxAges.length > 0) {
        if (maxAges.some(v => !/^[+-]?\d+$/.test(v) || Number(v) <= 0)) seen.push("");
        continue; // 양수 Max-Age: Expires는 무시
      }
      const exp = /;\s*expires\s*=\s*([^;]+)/i.exec(attrs);
      const t = exp ? Date.parse(exp[1].trim()) : NaN;
      if (exp && (isNaN(t) || t <= clock.now())) seen.push("");
    }
  }
  for (const c of res.cookies || []) {
    if (!c || String(c.name).toUpperCase() !== "JSESSIONID") continue;
    if (c.domain && !/(^|\.)splib\.or\.kr$/i.test(String(c.domain).replace(/^\./, ""))) continue;
    seen.push(c.value == null ? "" : String(c.value));
    if (c.expiresDate != null && new Date(c.expiresDate).getTime() <= clock.now()) seen.push("");
  }
  if (seen.some(v => v !== session)) {
    throw failure("integrity", "응답에서 세션 쿠키(JSESSIONID)가 바뀌거나 삭제되어 이 세션의 결과를 믿을 수 없습니다");
  }
}

function checkAuthenticatedPage(page, expectedUrl, session) {
  const res = page.res;
  if (!res || typeof res.statusCode !== "number") throw failure("integrity", "응답 상태를 확인할 수 없습니다");
  if (!session) throw failure("integrity", "고정한 세션이 없어 응답을 확인할 수 없습니다");
  checkSessionNotRotated(res, session);
  const s = res.statusCode;
  if (REDIRECT_STATUSES.includes(s) || s === 401 || s === 403) {
    throw failure("integrity", "로그인이 풀렸거나 다른 화면으로 이동되었습니다");
  }
  if (s !== 200) throw failure("page", `HTTP ${s} 오류`);
  if (!res.url || urlPath(res.url) !== urlPath(expectedUrl)) throw failure("integrity", "응답 주소가 요청한 화면과 다릅니다");
  if (looksLikeLoginPage(page.body)) throw failure("integrity", "로그인 화면이 표시됨 (세션 만료 또는 인증 실패)");
}

// 화면에서 읽은 신원을 계정에 등록된 회원번호와 맞춰 본다. 관측된 회원번호는 observed에 모은다.
function verifyIdentity(parsed, account, observed, where, requireId) {
  for (const c of parsed.candidates) observed.add(c);
  if (parsed.status === "ambiguous") {
    throw failure("integrity", `${where}: 회원번호가 둘 이상이거나 형식이 달라 본인 확인을 할 수 없습니다`);
  }
  if (parsed.status === "missing" && requireId) {
    throw failure("integrity", `${where}: 화면에서 회원번호를 찾지 못했습니다 (지원하지 않는 화면 구조이거나 로그인되지 않음)`);
  }
  if (parsed.status === "ok" && parsed.memberId !== normalizeMemberId(account.memberId)) {
    throw failure("integrity", `${where}: 등록한 회원번호와 다른 회원의 정보가 조회되었습니다`);
  }
  if (account.siteName) {
    const want = nameKey(account.siteName);
    if (requireId && parsed.siteNames.length === 0) throw failure("integrity", `${where}: 회원 이름을 확인할 수 없습니다`);
    if (parsed.siteNames.some(n => nameKey(n) !== want)) {
      throw failure("integrity", `${where}: 등록한 회원 이름과 다른 이름이 표시되었습니다`);
    }
  }
  return parsed.status === "ok";
}

async function checkIndexIdentity(session, account, observed, where, ctx) {
  const page = await getPage(INDEX_URL, session, timeoutFor(ctx));
  checkAuthenticatedPage(page, INDEX_URL, session);
  verifyIdentity(parseIdentity(page.body), account, observed, where, true);
}

// 목록의 모든 페이지를 끝이 확실할 때까지 읽는다.
// 일반 오류는 그때까지 확인한 기록을 남기고 complete:false, 신원·인증 문제는 예외로 올려 보낸다.
async function fetchList(spec, session, account, observed, ctx) {
  const records = [];
  const seenPages = new Set();
  const seenKeys = new Set();
  const fingerprints = []; // 첫 조회의 페이지별 지문 (빈 끝 페이지 포함)
  let pages = 0;
  const stop = (warning) => ({ records, complete: false, warning, pages });

  // 페이지 한 장을 읽고 세션·주소·회원번호를 확인한다. 신원·인증 문제는 예외, 그 밖은 { fail }.
  const loadPage = async (n, label) => {
    if (clock.now() > ctx.deadline) return { fail: `시간 제한으로 ${label}${n}페이지부터 확인하지 못했습니다` };
    const url = n === 1 ? spec.url : `${spec.url}?currentPageNo=${n}`;
    let page;
    try {
      page = await getPage(url, session, timeoutFor(ctx));
      checkAuthenticatedPage(page, url, session);
    } catch (e) {
      if (e.kind === "integrity") throw e;
      return { fail: `${label}${n}페이지를 불러오지 못했습니다 (${e.message})` };
    }
    // 모든 목록 페이지(빈 페이지 포함)는 페이지 전체(머리·옆·아래 영역 포함)에서 회원번호가 정확히 하나여야 하고
    // 등록한 값과 같아야 한다. 허용 목록의 회원 필드만 읽으므로 책 식별자는 섞이지 않는다.
    // 앞뒤 메인 화면 확인만으로는 이 페이지의 데이터가 누구 것인지 증명할 수 없으므로, 없으면 계정 결과를 모두 버린다.
    verifyIdentity(parseIdentity(page.body), account, observed, `${spec.name} ${label}${n}페이지`, true);
    const parsed = parseListPage(spec, page.body);
    if (parsed.error) return { fail: `${label}${n}페이지 ${parsed.error}` };
    return { parsed };
  };

  for (let n = 1; n <= LIMITS.maxPages; n++) {
    const got = await loadPage(n, "");
    if (got.fail) return stop(`${spec.name}: ${got.fail}`);
    const parsed = got.parsed;
    pages = n;
    fingerprints.push(parsed.fingerprint);
    // 끝은 확인된(로그인·회원번호 검증된) 빈 페이지로만 판단한다. 한 페이지 건수로 끝을 추정하지 않는다.
    if (parsed.empty) {
      // 첫 페이지부터 빈 목록이면 한 번의 확인으로 0건 확정
      if (n === 1) return { records, complete: true, pages };
      // 조회 중 앞 페이지에서 항목이 빠지면(반납·삭제) 뒤 항목이 앞으로 밀려 중복 없이 빠질 수 있다.
      // 같은 페이지들(빈 끝 페이지 포함)을 한 번 더 읽어 첫 조회와 같은지 확인한다. 기록은 다시 더하지 않는다.
      // 두 번 같아도 서버 시점 일관성(스냅숏)을 보장하지는 않으며, 확인 가능한 변경만 줄여 준다.
      for (let v = 1; v <= n; v++) {
        const again = await loadPage(v, "재확인 ");
        if (again.fail) return stop(`${spec.name}: ${again.fail} (목록 전체를 확인하지 못해 일부만 표시)`);
        if (again.parsed.fingerprint !== fingerprints[v - 1]) {
          return stop(`${spec.name}: 조회 중 ${v}페이지 내용이 바뀌어 빠진 항목이 있을 수 있습니다 (일부만 표시)`);
        }
      }
      return { records, complete: true, pages };
    }

    const signature = parsed.rowKeys.join("\n");
    if (seenPages.has(signature)) return stop(`${spec.name}: ${n}페이지가 앞 페이지와 같아 목록 끝을 확인하지 못했습니다`);
    seenPages.add(signature);
    const allKnown = parsed.records.length > 0 && parsed.records.every(r => r.stableKey && seenKeys.has(r.stableKey));
    if (allKnown) return stop(`${spec.name}: ${n}페이지에 새 항목이 없어 목록 끝을 확인하지 못했습니다`);

    for (const r of parsed.records) {
      r.page = n;
      records.push(r);
      if (r.stableKey) seenKeys.add(r.stableKey);
    }
  }
  return stop(`${spec.name}: 최대 ${LIMITS.maxPages}페이지까지만 확인했습니다`);
}

// 대출·상호대차 기록을 화면용 목록으로 합친다. 제목만으로는 절대 합치거나 숨기지 않는다.
// warnings: 참고 안내(결과는 확정). issues: 데이터 품질 문제 → uncertain=true(계정 결과를 "일부만 확인"으로)
function buildMemberBooks(loanRecords, dooRecords, userName, info) {
  const warnings = [];
  const issues = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. 대출 중복 제거: 도서관 범위 대출번호가 같고 내용(제목·반납일·등록번호)도 같은 기록만 한 번으로 센다.
  //    등록번호만 같은 기록은 합치지 않는다.
  const loans = [];
  const byLoan = new Map();
  let exactDup = 0;
  let idConflict = 0;
  for (const r of loanRecords) {
    const prev = r.scoped.loan ? byLoan.get(r.scoped.loan) : null;
    if (prev) {
      if (prev.normTitle === r.normTitle && prev.dueDateStr === r.dueDateStr && prev.ids.copy === r.ids.copy) {
        exactDup++;
        continue;
      }
      idConflict++;
    } else if (r.scoped.loan) {
      byLoan.set(r.scoped.loan, r);
    }
    loans.push(r);
  }

  // 상호대차 중복 제거: 같은 경로의 신청번호이고 내용(제목·상태·등록번호)도 같을 때만
  const doos = [];
  const byIll = new Map();
  for (const r of dooRecords) {
    const prev = r.scoped.ill ? byIll.get(r.scoped.ill) : null;
    if (prev) {
      if (prev.normTitle === r.normTitle && prev.status === r.status && prev.ids.copy === r.ids.copy) {
        exactDup++;
        continue;
      }
      idConflict++;
    } else if (r.scoped.ill) {
      byIll.set(r.scoped.ill, r);
    }
    doos.push(r);
  }
  // 완전히 같은 기록이 두 번 보였다는 것은 조회 중 목록이 밀렸다는 증거다 → 빠진 항목이 있을 수 있어 "일부만 확인"
  if (exactDup > 0) {
    issues.push(`같은 식별번호가 두 번 나온 기록 ${exactDup}건을 한 번만 표시했습니다 (조회 중 목록이 바뀌어 빠진 항목이 있을 수 있음)`);
  }
  const noLibLoans = loans.filter(r => !libScope(r.rawLib)).length;
  if (noLibLoans > 0) {
    issues.push(`도서관을 확인하지 못한 대출 ${noLibLoans}건은 대출번호·등록번호로 중복을 확인하지 않고 모두 표시했습니다`);
  }
  const unscopedIll = doos.filter(r => r.ids.ill && !r.scoped.ill).length;
  if (unscopedIll > 0) {
    issues.push(`제공·수령 도서관을 확인하지 못한 상호대차 ${unscopedIll}건은 신청번호로 중복을 확인하지 않고 모두 표시했습니다`);
  }
  if (idConflict > 0) {
    issues.push(`같은 대출·신청번호인데 내용이 다른 기록 ${idConflict}건을 합치지 않고 모두 표시했습니다`);
  }

  // 같은 도서관의 같은 등록번호에 대출이 여러 건(대출번호가 다르거나 없음)이면 합치지 않고 알린다
  const loansByCopy = groupBy(loans, r => r.scoped.copy);
  let copyConflict = 0;
  for (const list of loansByCopy.values()) if (list.length > 1) copyConflict += list.length;
  if (copyConflict > 0) {
    issues.push(`같은 도서관·등록번호의 대출 ${copyConflict}건이 서로 다른 기록이라 합치지 않고 모두 표시했습니다`);
  }

  // 2. 식별번호가 없어 중복인지 알 수 없는 기록은 모두 남기고 알린다 (대출·상호대차 모두)
  const idlessLoans = loans.filter(r => !r.scoped.loan && !r.scoped.copy);
  const countDupGroups = (list, keyOf) => [...groupBy(list, keyOf).values()].filter(g => g.length > 1).reduce((a, g) => a + g.length, 0);
  const loanAmbiguous = countDupGroups(idlessLoans, r => `${r.normTitle}|${r.dueDateStr}|${r.rawLib}`);
  if (loanAmbiguous > 0) {
    issues.push(`식별번호가 없어 같은 책인지 알 수 없는 대출 ${loanAmbiguous}건을 모두 표시했습니다 (중복일 수 있음)`);
  }
  if (idlessLoans.length > 0 && info && info.loanPages > 1) {
    issues.push("여러 페이지 대출 목록에 식별번호가 없는 항목이 있어 페이지 사이 중복 여부를 확인할 수 없습니다");
  }
  const idlessDoos = doos.filter(r => !r.scoped.ill);
  const dooAmbiguous = countDupGroups(idlessDoos, r => `${r.normTitle}|${r.status}|${r.providing}|${r.receiving}|${r.ids.copy || ""}`);
  if (dooAmbiguous > 0) {
    issues.push(`식별번호가 없어 같은 신청인지 알 수 없는 상호대차 ${dooAmbiguous}건을 모두 표시했습니다 (중복일 수 있음)`);
  }
  if (idlessDoos.length > 0 && info && info.dooPages > 1) {
    issues.push("여러 페이지 상호대차 목록에 식별번호가 없는 항목이 있어 페이지 사이 중복 여부를 확인할 수 없습니다");
  }
  const badIds = loanRecords.concat(dooRecords).filter(r => r.ambiguousIds).length;
  if (badIds > 0) issues.push(`식별번호가 여러 개이거나 형식이 이상한 기록 ${badIds}건은 식별번호 없이 처리했습니다`);

  // 3. 대출 ↔ 진행 중 상호대차 연결: 소장 도서관 범위 등록번호가 같고, 양쪽 모두 딱 한 건일 때만.
  //    지난 이력(완료·복귀중 등)으로 반납처를 옮기지 않는다.
  const activeByCopy = groupBy(doos.filter(d => d.isActive), d => d.scoped.copy);
  const joinOf = new Map();
  const joined = new Set();
  let joinConflict = 0;
  let joinMismatch = 0;
  for (const [k, ls] of loansByCopy) {
    const ds = activeByCopy.get(k);
    if (!ds) continue;
    if (ls.length === 1 && ds.length === 1) {
      // 범위 등록번호에 더해 제목도 같아야 연결한다 (제목만으로는 절대 연결하지 않음).
      // 수령도서관이 없는 진행 중 신청은 연결하지 않아 "수령처 미확인" 경고가 남게 한다.
      if (ls[0].normTitle !== ds[0].normTitle || !ds[0].receiving) {
        if (ls[0].normTitle !== ds[0].normTitle) joinMismatch++;
        continue;
      }
      joinOf.set(ls[0], ds[0]);
      joined.add(ds[0]);
    } else {
      joinConflict++;
    }
  }
  if (joinConflict > 0) {
    issues.push(`같은 등록번호의 대출·상호대차가 여러 건이라 서로 연결하지 않고 따로 표시했습니다 (${joinConflict}건)`);
  }
  if (joinMismatch > 0) {
    issues.push(`같은 등록번호인데 제목이 다른 대출·상호대차 ${joinMismatch}건은 연결하지 않고 따로 표시했습니다`);
  }

  const items = [];
  const libSummary = {};
  const loanTitleLacksCopy = new Map();
  let loanCount = 0;
  let pickupCount = 0;
  let transitCount = 0;

  for (const r of loans) {
    const activeDoo = joinOf.get(r) || null;
    loanTitleLacksCopy.set(r.normTitle, Boolean(loanTitleLacksCopy.get(r.normTitle)) || !r.scoped.copy);

    let returnLib = r.rawLib;
    let provLib = r.rawLib;
    if (activeDoo && activeDoo.receiving) {
      returnLib = activeDoo.receiving;
      provLib = activeDoo.providing || r.rawLib;
    }
    const dueDate = new Date(Number(r.yy), Number(r.mm) - 1, Number(r.dd));
    const diffDays = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const shortLib = abbreviateLibrary(returnLib);
    libSummary[shortLib] = (libSummary[shortLib] || 0) + 1;
    loanCount++;
    items.push({
      user: userName,
      title: r.title,
      lib: returnLib,
      provLib,
      shortLib,
      statusType: "대출중",
      diffDays,
      dueDate: r.dueDateStr,
      shortDate: `${pad2(r.mm)}.${pad2(r.dd)}`,
      isInter: r.isBooksole || Boolean(activeDoo)
    });
  }

  // 4. 대출과 연결되지 않은 진행 중 상호대차는 따로 표시 (제목이 같아도 숨기지 않음)
  let sameTitleUnlinked = 0;
  let unknownStatus = 0;
  let missingReceiving = 0;
  for (const d of doos) {
    if (!d.isActive) {
      if (!d.isKnownStatus) unknownStatus++;
      continue;
    }
    if (joined.has(d)) continue;
    if (loanTitleLacksCopy.has(d.normTitle) && (!d.scoped.copy || loanTitleLacksCopy.get(d.normTitle))) sameTitleUnlinked++;
    if (!d.receiving) missingReceiving++;

    const shortLib = d.receiving ? abbreviateLibrary(d.receiving) : "미확인";
    const pickup = d.status === "입수";
    if (pickup) pickupCount++;
    else transitCount++;
    items.push({
      user: userName,
      title: d.title,
      lib: d.receiving || "수령도서관 미확인",
      provLib: d.providing || "미확인",
      shortLib,
      statusType: pickup ? "픽업필요" : "이동중",
      diffDays: pickup ? -999 : 999, // 픽업필요는 맨 위, 이동중은 맨 아래
      dueDate: "-",
      shortDate: "-",
      isInter: true
    });
  }
  if (sameTitleUnlinked > 0) {
    issues.push(`대출 중인 책과 제목이 같은 상호대차 ${sameTitleUnlinked}건은 같은 책인지 확인할 식별번호가 없어 따로 표시했습니다`);
  }
  if (missingReceiving > 0) {
    issues.push(`수령도서관을 확인하지 못한 진행 중 상호대차 ${missingReceiving}건이 있습니다 (수령처 미확인)`);
  }
  if (unknownStatus > 0) issues.push(`알 수 없는 상호대차 상태 ${unknownStatus}건은 표시하지 않았습니다`);

  // 정렬: 픽업필요(-999) -> 대출중(반납 임박순) -> 이동중(999)
  items.sort((a, b) => a.diffDays - b.diffDays);
  return { items, libSummary, loanCount, pickupCount, transitCount, warnings: issues.concat(warnings), uncertain: issues.length > 0 };
}

function accountLabel(account) {
  return (account && String(account.label || "").trim()) || "(이름 없는 계정)";
}

function errorResult(account, message) {
  return {
    name: accountLabel(account),
    status: "error",
    error: message,
    warnings: [],
    items: [],
    libSummary: {},
    loanCount: 0,
    pickupCount: 0,
    transitCount: 0,
    loanComplete: false,
    dooComplete: false
  };
}

// 화면에 보일 오류 문구: 태그 제거, 비밀값·쿠키 가림, 길이 제한
function safeMessage(message, secrets) {
  let s = htmlToText(String(message || "알 수 없는 오류"));
  s = s.replace(/JSESSIONID=[^\s;,]*/gi, "JSESSIONID=***");
  for (const secret of secrets) {
    if (secret && String(secret).length >= 3) s = s.split(String(secret)).join("***");
  }
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

// 계정 하나 조회. 반환: { result(화면용), observedIds(관측 회원번호), session(교차 확인용, 화면에 쓰지 않음) }
async function fetchAccount(account, ctx) {
  const observed = new Set();
  let session = null;
  try {
    if (!normalizeMemberId(account.memberId)) throw failure("setup", MISSING_MEMBER_ID_MESSAGE);
    if (clock.now() > ctx.deadline) throw failure("page", "시간 제한으로 이 계정은 조회하지 못했습니다");

    session = await login(account, ctx);
    try {
      await checkIndexIdentity(session, account, observed, "로그인 직후 확인", ctx);
    } catch (e) {
      throw e.kind === "integrity" ? e : failure("page", `로그인 직후 확인 실패 (${e.message})`);
    }

    const loan = await fetchList(LISTS.loan, session, account, observed, ctx);
    const doo = await fetchList(LISTS.doo, session, account, observed, ctx);

    // 목록 화면에 신원이 없을 수도 있으므로 끝난 뒤 다시 확인한다. 실패하면 이번 결과를 모두 버린다.
    try {
      await checkIndexIdentity(session, account, observed, "조회 후 재확인", ctx);
    } catch (e) {
      throw failure("integrity", e.kind === "integrity" ? e.message : `조회 후 재확인 실패 (${e.message})`);
    }

    const listWarnings = [loan.warning, doo.warning].filter(Boolean);
    const hasData = loan.complete || doo.complete || loan.records.length + doo.records.length > 0;
    if (!hasData) {
      return { result: errorResult(account, safeMessage(listWarnings.join(" / "), [account.pw, account.memberId, session])), observedIds: [...observed], session };
    }
    const { uncertain, ...books } = buildMemberBooks(loan.records, doo.records, accountLabel(account), { loanPages: loan.pages, dooPages: doo.pages });
    return {
      result: {
        ...errorResult(account, ""),
        ...books,
        // 데이터 품질 문제(모르는 상태, 풀리지 않은 중복·연결, 빠진 필수 정보)도 "일부만 확인"이다
        status: loan.complete && doo.complete && !uncertain ? "ok" : "partial",
        warnings: listWarnings.map(w => safeMessage(w, [account.pw, account.memberId, session])).concat(books.warnings),
        loanComplete: loan.complete,
        dooComplete: doo.complete
      },
      observedIds: [...observed],
      session
    };
  } catch (e) {
    const message = safeMessage(e && e.message, [account.pw, account.memberId, account.id, session]);
    return { result: errorResult(account, message), observedIds: [...observed], session };
  }
}

function quarantined(result, reason) {
  return {
    ...result,
    status: "error",
    error: result.error ? `${result.error} / ${reason}` : reason,
    warnings: [],
    items: [],
    libSummary: {},
    loanCount: 0,
    pickupCount: 0,
    transitCount: 0
  };
}

// 같은 회원번호가 관측되거나 같은 세션이 재사용된 계정은 앞뒤 순서와 관계없이 모두 숨긴다
function quarantineCollisions(entries) {
  const reasons = entries.map(() => []);
  const collide = (keysOf, message) => {
    const map = new Map();
    entries.forEach((e, i) => {
      for (const k of keysOf(e)) {
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(i);
      }
    });
    for (const idxs of map.values()) {
      if (idxs.size < 2) continue;
      for (const i of idxs) {
        const others = [...idxs].filter(j => j !== i).map(j => entries[j].result.name).join(", ");
        reasons[i].push(message(others));
      }
    }
  };
  collide(e => e.observedIds || [], o => `다른 계정(${o})의 조회에서도 같은 회원번호가 확인되어 결과를 모두 숨겼습니다`);
  collide(e => (e.session ? [e.session] : []), o => `다른 계정(${o})과 같은 세션이 재사용되어 결과를 모두 숨겼습니다`);
  return entries.map((e, i) => (reasons[i].length > 0 ? quarantined(e.result, reasons[i].join(" / ")) : e.result));
}

// 모든 계정을 순서대로 조회하고 계정 사이 충돌을 검사한다
async function fetchAllAccounts(accounts, budgetMs) {
  const ctx = { deadline: clock.now() + budgetMs };
  const counts = new Map();
  for (const a of accounts) {
    const m = normalizeMemberId(a.memberId);
    if (m) counts.set(m, (counts.get(m) || 0) + 1);
  }
  const entries = [];
  for (const a of accounts) {
    const m = normalizeMemberId(a.memberId);
    if (m && counts.get(m) > 1) {
      entries.push({ result: errorResult(a, "설정 오류: 같은 회원번호가 다른 계정에도 등록되어 있습니다 (songpa-accounts에서 확인)"), observedIds: [], session: null });
      continue;
    }
    entries.push(await fetchAccount(a, ctx));
  }
  return quarantineCollisions(entries);
}

// ------------------------------------------------------------
// 실행 겹침 방지 (권고용 잠금). 원자적이지 않으므로 정확성은 쿠키 고정 + 신원 확인에 의존한다.
// ------------------------------------------------------------
const LEASE_FILE = "songpa-loan-tracker.lease.json";

function acquireLease() {
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.libraryDirectory(), LEASE_FILE);
    const now = clock.now();
    if (fm.fileExists(path)) {
      let cur = null;
      try {
        cur = JSON.parse(fm.readString(path));
      } catch (e) {
        cur = null; // 깨진 파일은 만료된 것으로 본다
      }
      const live = cur && typeof cur.expiresAt === "number" && cur.expiresAt > now && cur.expiresAt <= now + LIMITS.leaseTtlMs * 2;
      if (live) return { status: "busy" };
    }
    const owner = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    fm.writeString(path, JSON.stringify({ owner, expiresAt: now + LIMITS.leaseTtlMs }));
    const check = JSON.parse(fm.readString(path));
    if (!check || check.owner !== owner) return { status: "busy" };
    return { status: "held", owner, path, fm };
  } catch (e) {
    return { status: "unavailable" };
  }
}

function releaseLease(lease) {
  if (!lease || lease.status !== "held") return;
  try {
    if (!lease.fm.fileExists(lease.path)) return;
    const cur = JSON.parse(lease.fm.readString(lease.path));
    if (cur && cur.owner === lease.owner) lease.fm.remove(lease.path);
  } catch (e) {
    // 해제 실패는 TTL이 지나면 자연히 풀린다
  }
}

// 표시를 아직 우리가 갖고 있는지. 잠금 파일을 쓸 수 없었던 경우(unavailable)는 관측할 수 없으므로 true.
function leaseStillHeld(lease) {
  if (!lease || lease.status !== "held") return true;
  try {
    if (!lease.fm.fileExists(lease.path)) return false;
    const cur = JSON.parse(lease.fm.readString(lease.path));
    return Boolean(cur && cur.owner === lease.owner);
  } catch (e) {
    return false;
  }
}

async function collectData(accounts) {
  const lease = acquireLease();
  if (lease.status === "busy") {
    return accounts.map(a => errorResult(a, "다른 실행이 조회 중이라 이번에는 건너뛰었습니다. 잠시 후 다시 실행해주세요."));
  }
  try {
    const data = await fetchAllAccounts(accounts, config.runsInWidget ? LIMITS.widgetBudgetMs : LIMITS.appBudgetMs);
    // 조회하는 동안 다른 실행이 표시를 가져갔으면(관측 가능한 경우) 이번 결과를 쓰지 않는다
    if (!leaseStillHeld(lease)) {
      return accounts.map(a => errorResult(a, "조회 중 다른 실행이 실행 표시(잠금)를 가져가 이번 결과를 버렸습니다. 잠시 후 다시 실행해주세요."));
    }
    return data;
  } finally {
    releaseLease(lease);
  }
}

// 전체 상태 요약: 모두 실패 / 일부만 확인 / 모두 확인(0건 포함)
function summarizeResults(data) {
  const s = { total: data.length, ok: 0, partial: 0, error: 0, items: 0, loans: 0, pickups: 0, transits: 0 };
  for (const d of data) {
    if (d.status === "ok") s.ok++;
    else if (d.status === "partial") s.partial++;
    else {
      s.error++;
      continue;
    }
    s.items += (d.items || []).length;
    s.loans += d.loanCount || 0;
    s.pickups += d.pickupCount || 0;
    s.transits += d.transitCount || 0;
  }
  s.allFailed = s.total > 0 && s.error === s.total;
  s.hasProblem = s.error + s.partial > 0;
  s.confirmedZero = s.total > 0 && s.ok === s.total && s.items === 0;
  return s;
}

// ==========================================
// 1. 홈 화면 위젯 뷰
// ==========================================
async function createWidget(data, updateInfo) {
  const widget = new ListWidget();
  widget.backgroundColor = themed("#FFFFFF", "#1C1C1E");
  const red = themed("#D70015", "#FF453A");
  const orange = themed("#C93400", "#FF9F0A");
  const gray = themed("#6C6C70", "#8E8E93");

  const s = summarizeResults(data);
  const allItems = [];
  for (const d of data) {
    if (d.status !== "error" && d.items) allItems.push(...d.items);
  }
  allItems.sort((a, b) => a.diffDays - b.diffDays);

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText("📚 송파도서관");
  title.font = Font.boldSystemFont(13);
  title.textColor = themed("#000000", "#FFFFFF");
  header.addSpacer();

  let badgeStr = `총 ${s.items}권`;
  let badgeColor = gray;
  if (s.allFailed) {
    badgeStr = "⚠️ 조회 실패";
    badgeColor = red;
  } else if (s.hasProblem) {
    badgeStr = `⚠️ 일부만 확인 · ${s.items}권`;
    badgeColor = orange;
  } else if (s.pickups > 0) {
    badgeStr = `🔔 픽업 ${s.pickups} · 대출 ${s.loans}`;
    badgeColor = themed("#9A6700", "#FFD60A");
  } else if (s.transits > 0) {
    badgeStr = `🚚 이동 ${s.transits} · 대출 ${s.loans}`;
  } else if (s.items === 0) {
    badgeStr = "✓ 조회 완료";
  }
  const countBadge = header.addText(badgeStr);
  countBadge.font = Font.systemFont(11);
  countBadge.textColor = badgeColor;

  widget.addSpacer(6);

  const maxLines = 4;
  let used = 0;

  // 실패·일부 확인 계정을 먼저 보여준다 (계정 이름 전체)
  // 확정된 결과라도 안내(경고)가 있으면 한 줄 보여 준다
  const problems = data.filter(d => d.status !== "ok" || (d.warnings && d.warnings.length > 0)).map(d => ({
    text: d.status === "error"
      ? `⚠️ ${d.name}: ${d.error || "조회 실패"}`
      : d.status === "partial"
        ? `⚠️ ${d.name}: 일부만 확인 - ${(d.warnings && d.warnings[0]) || "목록 일부를 불러오지 못함"}`
        : `ℹ️ ${d.name}: ${d.warnings[0]}`,
    color: d.status === "error" ? red : d.status === "partial" ? orange : gray
  }));
  const slots = allItems.length === 0 ? maxLines : Math.min(problems.length, 2);
  if (problems.length > slots) {
    const hidden = problems.length - (slots - 1);
    problems.splice(slots - 1, problems.length, { text: `⚠️ 그 외 ${hidden}개 계정 확인 필요 (터치해서 보기)`, color: red });
  }
  for (const p of problems) {
    const line = widget.addText(p.text);
    line.font = Font.systemFont(11);
    line.textColor = p.color;
    line.lineLimit = 1;
    widget.addSpacer(3);
    used++;
  }

  if (s.confirmedZero) {
    const line = widget.addText("현재 이용 중인 도서가 없습니다 (모든 계정 조회 완료)");
    line.font = Font.systemFont(11);
    line.textColor = gray;
    line.lineLimit = 1;
    widget.addSpacer(3);
    used++;
  }

  for (let i = 0; i < allItems.length && used < maxLines; i++, used++) {
    const item = allItems[i];
    const row = widget.addStack();
    row.centerAlignContent();

    let tagText = "";
    let tagColor = themed("#248A3D", "#30D158");

    if (item.statusType === "픽업필요") {
      tagText = "[픽업필요]";
      tagColor = themed("#9A6700", "#FFD60A");
    } else if (item.statusType === "이동중") {
      tagText = "[이동중]";
      tagColor = themed("#0071A4", "#64D2FF");
    } else {
      if (item.diffDays < 0) {
        tagText = `[연체 ${Math.abs(item.diffDays)}일]`;
        tagColor = red;
      } else if (item.diffDays === 0) {
        tagText = "[오늘 반납]";
        tagColor = red;
      } else if (item.diffDays <= 3) {
        tagText = `[D-${item.diffDays}]`;
        tagColor = orange;
      } else {
        tagText = `[D-${item.diffDays}]`;
        tagColor = themed("#248A3D", "#30D158");
      }
    }

    const badge = row.addText(`${tagText} `);
    badge.font = Font.boldSystemFont(11);
    badge.textColor = tagColor;

    const label = row.addText(`${item.user}: ${item.title} (${item.shortLib})`);
    label.font = Font.systemFont(11);
    label.textColor = themed("#000000", "#FFFFFF");
    label.lineLimit = 1;

    widget.addSpacer(3);
  }

  widget.addSpacer(4);
  const hasUpdate = Boolean(updateInfo && updateInfo.hasUpdate);
  const footerText = hasUpdate
    ? `🆙 새 버전(v${updateInfo.remoteVer}) 출시 · 터치하여 업데이트`
    : `터치하면 계정별 도서 상세를 봅니다`;
  const footer = widget.addText(footerText);
  footer.font = Font.systemFont(9);
  footer.textColor = hasUpdate ? orange : gray;

  return widget;
}

// ==========================================
// 2. HTML 카드 뷰 (통합 테이블 목록)
// ==========================================
function buildHtmlPage(data) {
  const s = summarizeResults(data);
  const countsText = `대출 ${s.loans}권${s.pickups > 0 ? ` · 🔔 픽업 ${s.pickups}권` : ""}${s.transits > 0 ? ` · 🚚 이동 ${s.transits}권` : ""}`;
  let subtitleHtml;
  if (s.allFailed) {
    subtitleHtml = `<span class="subtitle-alert">⚠️ ${data.length}개 계정 모두 조회 실패 · 도서 수를 알 수 없습니다</span>`;
  } else if (s.hasProblem) {
    subtitleHtml = `<span class="subtitle-alert">⚠️ 일부 계정·목록만 확인됨</span> · 확인된 ${s.items}권 (${countsText})`;
  } else if (s.items === 0) {
    subtitleHtml = `${data.length}개 계정 · 현재 이용 중인 도서 없음 (조회 완료)`;
  } else {
    subtitleHtml = `${data.length}개 계정 · 총 ${s.items}권 이용 (${countsText})`;
  }

  const tabsHtml = data.map((d, idx) => {
    const label = escapeHtml(d.name);
    const isError = d.status === "error";
    const items = isError ? [] : (d.items || []);
    const count = isError ? "!" : `${items.length}${d.status === "partial" ? "+" : ""}`;
    const interCount = items.filter(b => b.isInter).length;
    return `<a href="#card-${idx}" class="tab-pill">${label} <span class="tab-count">${count}</span>${isError ? "" : `<span class="tab-inter">(${interCount})</span>`}</a>`;
  }).join("");

  const cardsHtml = data.map((d, idx) => {
    const isError = d.status === "error";
    const isPartial = d.status === "partial";
    const items = isError ? [] : (d.items || []);

    // 반납/수령할 도서관 기준 요약 라인
    const summaryEntries = Object.entries(d.libSummary || {});
    const summaryHtml = summaryEntries.length > 0
      ? summaryEntries.map(([lib, cnt]) => `<span>📍<strong>${escapeHtml(lib)}</strong>: ${Number(cnt)}권</span>`).join("&nbsp;&nbsp;·&nbsp;&nbsp;")
      : (isPartial ? "확인된 대출 도서관 없음 (일부 목록 미확인)" : "대출 중인 도서관 없음");

    const errHtml = isError ? `<div class="err-box">⚠️ 조회 오류: ${escapeHtml(d.error || "알 수 없는 오류")}</div>` : "";
    const warnings = isError ? [] : (d.warnings || []);
    const warnHtml = warnings.length > 0
      ? `<div class="warn-box">${isPartial ? "<div><strong>일부만 확인된 결과입니다.</strong></div>" : ""}${warnings.map(w => `<div>⚠️ ${escapeHtml(w)}</div>`).join("")}</div>`
      : "";

    let rowsHtml = "";
    if (items.length === 0) {
      const emptyText = isError
        ? "도서 정보를 불러오지 못했습니다."
        : isPartial ? "확인된 도서가 없습니다 (목록 일부를 불러오지 못했거나 확인이 필요한 기록이 있어 0권이 아닐 수 있음)." : "현재 이용 중인 도서가 없습니다.";
      rowsHtml = `<tr><td colspan="4" class="empty-cell">${emptyText}</td></tr>`;
    } else {
      rowsHtml = items.map((b, bIdx) => {
        let libDisplay = "";
        let subLocText = "";
        let statusHtml = "";

        if (b.statusType === "픽업필요") {
          libDisplay = `<div class="lib-main pickup-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령처</div>`;
          subLocText = `<div class="loc-detail"><span class="tag-pickup">픽업필요</span> 📍도착도서관: <strong>${escapeHtml(b.lib)}</strong> <span class="prov-text">(소장: ${escapeHtml(b.provLib)})</span></div>`;
          statusHtml = `<span class="badge-status badge-pickup">픽업필요</span>`;
        } else if (b.statusType === "이동중") {
          libDisplay = `<div class="lib-main transit-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령예정</div>`;
          subLocText = `<div class="loc-detail"><span class="tag-transit">이동중</span> 📍배송 경로: ${escapeHtml(b.provLib)} ➔ <strong>${escapeHtml(b.lib)}</strong></div>`;
          statusHtml = `<span class="badge-status badge-transit">이동중</span>`;
        } else {
          // 대출중
          let dueClass = "due-normal";
          let badge = `D-${b.diffDays}`;
          if (b.diffDays < 0) {
            dueClass = "due-urgent";
            badge = `연체 ${Math.abs(b.diffDays)}일`;
          } else if (b.diffDays === 0) {
            dueClass = "due-urgent";
            badge = "오늘 반납";
          } else if (b.diffDays <= 3) {
            dueClass = "due-soon";
            badge = `D-${b.diffDays}`;
          }

          if (b.isInter) {
            libDisplay = `<div class="lib-main inter-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령/반납</div>`;
            subLocText = `<div class="loc-detail"><span class="tag-booksole">책솔이</span> 📍반납처: <strong>${escapeHtml(b.lib)}</strong> <span class="prov-text">(소장: ${escapeHtml(b.provLib)})</span></div>`;
          } else {
            libDisplay = `<div class="lib-main">${escapeHtml(b.shortLib)}</div><div class="lib-sub">대출도서관</div>`;
            subLocText = `<div class="loc-detail">📍반납처: ${escapeHtml(b.lib)}</div>`;
          }

          statusHtml = `${escapeHtml(b.shortDate)}<br><span class="badge-dday ${dueClass}">${escapeHtml(badge)}</span>`;
        }

        return `
          <tr>
            <td class="col-num">${bIdx + 1}</td>
            <td class="col-lib">${libDisplay}</td>
            <td class="col-title">
              <div class="title-text">${escapeHtml(b.title)}</div>
              ${subLocText}
            </td>
            <td class="col-due">
              ${statusHtml}
            </td>
          </tr>
        `;
      }).join("");
    }

    const statsHtml = isError
      ? `<span style="color:var(--red);">조회 실패 · 도서 정보 없음</span>`
      : `<span>대출 ${d.loanCount || 0}권${d.loanComplete === false ? " (일부 미확인)" : ""}</span>
            ${d.pickupCount > 0 ? `<span style="color:var(--yellow); font-weight:800;">· 🔔 픽업필요 ${d.pickupCount}권</span>` : ""}
            ${d.transitCount > 0 ? `<span style="color:var(--sky);">· 🚚 이동중 ${d.transitCount}권</span>` : ""}
            ${d.dooComplete === false ? `<span style="color:var(--orange);">· 상호대차 일부 미확인</span>` : ""}`;

    return `
      <div class="card" id="card-${idx}">
        <div class="card-header">
          <div class="user-row">
            <span class="user-name">👤 ${escapeHtml(d.name)}</span>
            <span class="badge-total">${isError ? "조회 실패" : `${items.length}권${isPartial ? "+" : ""}`}</span>
          </div>
          <div class="stats-row">
            ${statsHtml}
          </div>
        </div>

        ${errHtml}
        ${warnHtml}

        ${isError ? "" : `<div class="lib-summary">
          ${summaryHtml}
        </div>`}

        <table class="book-table">
          <thead>
            <tr>
              <th style="width: 20px;">#</th>
              <th style="width: 52px;">도서관</th>
              <th>도서명</th>
              <th style="width: 65px; text-align: right;">상태 / 반납</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }).join("");

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>송파도서관 대출 현황</title>
<style>
  /* 기기 설정(라이트/다크, 자동 전환 포함)을 따라간다. 다크는 기존 색 그대로, 라이트는 흰 바탕에서 읽히게 진하게. */
  :root {
    color-scheme: light dark;
    --bg-color: #F2F2F7; --card-bg: #FFFFFF; --card-border: #E5E5EA;
    --text-primary: #000000; --text-secondary: #6C6C70; --text-title: #1C1C1E;
    --text-loc: #6C6C70; --text-faint: #8E8E93; --text-summary: #3A3A3C;
    --chip: #E5E5EA; --chip-count: rgba(0,0,0,0.08); --overlay: rgba(242,242,247,0.85);
    --badge-bg: rgba(0,0,0,0.06); --line: rgba(0,0,0,0.08); --line-soft: rgba(0,0,0,0.05);
    --summary-bg: rgba(0,0,0,0.04); --shadow: rgba(0,0,0,0.08);
    --green: #248A3D; --blue: #0066CC; --red: #D70015; --orange: #C93400; --yellow: #9A6700; --sky: #0071A4;
    --tint-yellow: rgba(255,204,0,0.2); --tint-yellow-border: rgba(154,103,0,0.4);
    --tint-blue: rgba(0,113,164,0.12); --tint-blue-border: rgba(0,113,164,0.35);
    --tint-green: rgba(36,138,61,0.12);
    --tint-red: rgba(215,0,21,0.08); --tint-red-border: rgba(215,0,21,0.3);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-color: #000000; --card-bg: #1C1C1E; --card-border: #2C2C2E;
      --text-primary: #FFFFFF; --text-secondary: #8E8E93; --text-title: #F2F2F7;
      --text-loc: #98989D; --text-faint: #636366; --text-summary: #D1D1D6;
      --chip: #2C2C2E; --chip-count: rgba(255,255,255,0.2); --overlay: rgba(0,0,0,0.85);
      --badge-bg: rgba(255,255,255,0.12); --line: rgba(255,255,255,0.08); --line-soft: rgba(255,255,255,0.06);
      --summary-bg: rgba(255,255,255,0.05); --shadow: rgba(0,0,0,0.4);
      --green: #30D158; --blue: #0A84FF; --red: #FF453A; --orange: #FF9F0A; --yellow: #FFD60A; --sky: #64D2FF;
      --tint-yellow: rgba(255,214,10,0.18); --tint-yellow-border: rgba(255,214,10,0.4);
      --tint-blue: rgba(10,132,255,0.18); --tint-blue-border: rgba(10,132,255,0.4);
      --tint-green: rgba(48,209,88,0.15);
      --tint-red: rgba(255,69,58,0.15); --tint-red-border: rgba(255,69,58,0.35);
    }
  }
  * { box-sizing: border-box; }
  body {
    background-color: var(--bg-color);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    margin: 0;
    /* 노치·상태바 아래로 내용이 가려지지 않도록 안전 영역만큼 여백 */
    --safe-top: max(env(safe-area-inset-top, 0px), 44px);
    padding: calc(var(--safe-top) + 12px) 14px calc(env(safe-area-inset-bottom, 0px) + 80px) 14px;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: "";
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--safe-top);
    background: var(--bg-color);
    z-index: 200;
  }
  .app-header {
    text-align: center;
    margin-bottom: 16px;
    padding-top: 4px;
  }
  .app-title {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.4px;
    margin-bottom: 4px;
  }
  .app-subtitle {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .subtitle-alert {
    color: var(--red);
    font-weight: 700;
  }
  .tabs-container {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 6px 0 14px 0;
    position: sticky;
    top: var(--safe-top);
    background: var(--overlay);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    z-index: 100;
    scrollbar-width: none;
  }
  .tabs-container::-webkit-scrollbar { display: none; }
  .tab-pill {
    background: var(--chip);
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: 16px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tab-count {
    background: var(--chip-count);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 11px;
  }
  .tab-inter {
    color: var(--red);
    font-size: 12px;
    font-weight: 800;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 18px;
    padding: 18px 16px;
    margin-bottom: 18px;
    box-shadow: 0 4px 16px var(--shadow);
    scroll-margin-top: 50px;
  }
  .card-header {
    margin-bottom: 12px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 10px;
  }
  .user-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .user-name {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .badge-total {
    background: var(--badge-bg);
    color: var(--text-primary);
    padding: 3px 9px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
  }
  .stats-row {
    display: flex;
    gap: 10px;
    font-size: 13px;
    font-weight: 700;
    margin-top: 6px;
  }
  .stat-inter { color: var(--green); }
  .stat-pickup { color: var(--yellow); }
  .stat-transit { color: var(--sky); }
  .err-box {
    background: var(--tint-red);
    border: 1px solid var(--tint-red-border);
    color: var(--red);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    margin-bottom: 10px;
    font-weight: 600;
  }
  .warn-box {
    background: var(--tint-yellow);
    border: 1px solid var(--tint-yellow-border);
    color: var(--text-primary);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .lib-summary {
    background: var(--summary-bg);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--text-summary);
    line-height: 1.5;
    margin-bottom: 12px;
  }
  .lib-summary strong {
    color: var(--text-primary);
  }
  .pickup-highlight { color: var(--yellow) !important; }
  .transit-highlight { color: var(--sky) !important; }
  .tag-pickup {
    display: inline-block;
    background: var(--tint-yellow);
    color: var(--yellow);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    margin-right: 4px;
  }
  .tag-transit {
    display: inline-block;
    background: var(--tint-blue);
    color: var(--sky);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    margin-right: 4px;
  }
  .badge-status {
    display: inline-block;
    padding: 3px 6px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 800;
    white-space: nowrap;
  }
  .badge-pickup {
    background: var(--tint-yellow);
    color: var(--yellow);
    border: 1px solid var(--tint-yellow-border);
  }
  .badge-transit {
    background: var(--tint-blue);
    color: var(--sky);
    border: 1px solid var(--tint-blue-border);
  }
  .book-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .book-table th {
    text-align: left;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .book-table td {
    padding: 11px 4px;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: top;
  }
  .book-table tr:last-child td {
    border-bottom: none;
  }
  .col-num {
    color: var(--text-secondary);
    font-size: 11px;
    text-align: center;
    padding-top: 13px !important;
  }
  .col-lib {
    padding-top: 10px !important;
    white-space: nowrap;
  }
  .lib-main {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .inter-highlight {
    color: var(--green) !important;
  }
  .lib-sub {
    font-size: 10px;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .col-title {
    padding-right: 6px !important;
  }
  .title-text {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--text-title);
  }
  .loc-detail {
    font-size: 11px;
    color: var(--text-loc);
    margin-top: 4px;
  }
  .loc-detail strong {
    color: var(--green);
  }
  .prov-text {
    color: var(--text-faint);
  }
  .tag-booksole {
    display: inline-block;
    background: var(--tint-green);
    color: var(--green);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    margin-right: 2px;
  }
  .col-due {
    text-align: right;
    font-size: 12px;
    white-space: nowrap;
    padding-top: 12px !important;
  }
  .badge-dday {
    font-size: 11px;
    font-weight: 700;
  }
  .due-urgent { color: var(--red); }
  .due-soon { color: var(--orange); }
  .due-normal { color: var(--green); }
  .empty-cell {
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
    padding: 20px 0 !important;
  }
</style>
</head>
<body>
  <div class="app-header">
    <div class="app-title">📚 송파도서관 대출 현황</div>
    <div class="app-subtitle">${subtitleHtml}</div>
  </div>

  <div class="tabs-container">
    ${tabsHtml}
  </div>

  <div class="cards-deck">
    ${cardsHtml}
  </div>
</body>
</html>
  `;
}

async function main() {
  // 최신 버전 확인 및 업데이트 안내
  const updateInfo = await checkUpdateIfNeeded();
  if (updateInfo && updateInfo.updated) {
    return;
  }

  const accounts = getAccounts();
  if (!accounts || accounts.length === 0) {
    if (config.runsInWidget) {
      const widget = new ListWidget();
      widget.backgroundColor = themed("#FFFFFF", "#1C1C1E");
      const title = widget.addText("⚠️ 계정 설정 필요");
      title.font = Font.boldSystemFont(13);
      title.textColor = themed("#C93400", "#FF9F0A");
      widget.addSpacer(4);
      const sub = widget.addText("Scriptable 앱에서 계정설정 스크립트(songpa-accounts)를 실행해 계정을 먼저 저장해주세요.");
      sub.font = Font.systemFont(11);
      sub.textColor = themed("#000000", "#FFFFFF");
      Script.setWidget(widget);
    } else {
      const alert = new Alert();
      alert.title = "⚠️ 계정 설정 필요";
      alert.message = "키체인에 저장된 도서관 계정 정보가 없습니다.\n\n먼저 계정설정 스크립트(songpa-accounts)를 1회 실행하여 도서관 계정을 등록해주세요.";
      alert.addAction("확인");
      await alert.presentAlert();
    }
    return;
  }

  // 계정은 순서대로 조회한다. 잠금은 화면을 띄우기 전에 풀린다.
  const data = await collectData(accounts);

  if (config.runsInWidget) {
    const widget = await createWidget(data, updateInfo);
    widget.url = URLScheme.forRunningScript();
    Script.setWidget(widget);
  } else {
    const html = buildHtmlPage(data);
    const wv = new WebView();
    await wv.loadHTML(html);
    await wv.present(true);
  }
}

await main();
Script.complete();
