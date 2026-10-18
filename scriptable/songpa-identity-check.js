// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: magic;
// 송파구립도서관 대출 현황 - iOS Scriptable 위젯 + 전체 카드 화면
// https://github.com/pchuri/songpa-loan-tracker (MIT License)
// 계정은 songpa-accounts.js로 iOS 키체인에 저장한다. 이 파일에는 계정 정보를 넣지 않는다.

const SCRIPT_VERSION = "1.2.9";
const NATIVE_TRACE = false;
const NATIVE_PROBE_BUILD = "single-render-1";
const UPDATE_URL = "https://raw.githubusercontent.com/pchuri/songpa-loan-tracker/main/scriptable/songpa-loan-tracker.js";
const KEYCHAIN_KEY = "SPLIB_ACCOUNTS";
// 자동 업데이트는 이 메인 스크립트만 바꾼다. 계정 설정 스크립트는 사용자가 직접 새 버전으로 교체해야 한다.
const ACCOUNTS_SOURCE_URL = "https://github.com/pchuri/songpa-loan-tracker/blob/main/scriptable/songpa-accounts.js";
// 회원번호는 선택 항목이다. 아이디·비밀번호만 있는 계정은 첫 조회에서 서버가 확인한 로그인 아이디가 저장한 아이디와 정확히 같을 때만
// 같은 응답의 회원번호를 별도 키체인 항목(SPLIB_VERIFIED_MEMBERS_V1)에 처음 한 번 저장한다. 계정 목록(SPLIB_ACCOUNTS)은 자동으로 바꾸지 않는다.
const ACCOUNTS_MIGRATION_NOTE =
  `회원번호는 선택 항목입니다. 아이디·비밀번호만 있는 계정도 조회할 때마다 서버가 확인한 로그인 아이디가 저장한 아이디와 정확히 같아야 결과를 보여 줍니다. ` +
  `자동 업데이트는 songpa-accounts.js를 바꾸지 않으므로, 회원번호를 직접 입력·수정하려면 ${ACCOUNTS_SOURCE_URL} 의 새 버전으로 직접 교체해주세요.`;

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
    // 정상 응답(200)의 완전한 스크립트(끝의 진입점까지 받음)만 업데이트로 본다. 오류 페이지·잘린 내려받기로 설치본을 덮어쓰지 않는다.
    const status = req.response ? req.response.statusCode : null;
    if (status !== 200 || !/\nawait main\(\);\s*\nScript\.complete\(\);\s*$/.test(remoteCode)) return { hasUpdate: false };

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
  appBudgetMs: 210000,
  leaseTtlMs: 270000       // 조회 예산보다 길게
};
const clock = { now: () => Date.now() };

// 진행 중인 상호대차 상태 (완료·복귀중·신청취소는 지난 이력)
const ACTIVE_DOO_STATUSES = ["입수", "발송", "요청중", "신청중", "신청"];
const INACTIVE_DOO_STATUSES = ["완료", "복귀중", "신청취소", "발송거절", "요청거절"];

// 로그인 실패도 HTTP 200으로 돌려주므로 응답 문구로 실패를 가려낸다 (데스크탑 앱과 동일)
const LOGIN_FAILURE_PATTERNS = [
  "로그인 정보가 올바르지 않거나",
  "비밀번호가 일치하지 않습니다",
  "회원번호가 일치하지 않습니다",
  "존재하지 않는 회원",
  "로그인에 실패",
  "회원정보가 없습니다"
];

// 저장된 회원번호 값이 있는데 형식이 틀리면 자동으로 다른 값(확인 기록 등)으로 대신하지 않고 오류로 본다
const INVALID_MEMBER_ID_MESSAGE = "설정 오류: 저장된 회원번호 형식이 올바르지 않아 조회하지 않았습니다 (songpa-accounts '계정 수정'에서 확인)";

// ------------------------------------------------------------
// 로그인 아이디(서버 주체) 확인 화면과 확인된 회원번호 기록
// ------------------------------------------------------------
// 회원정보 수정 전 비밀번호 확인 화면. 같은 세션으로 GET만 하고(쿼리·본문에 아이디 없음) 비밀번호 칸은 읽거나 제출하지 않는다.
const PROFILE_PROOF_URL = "https://splib.or.kr/intro/menu/10101/program/30045/memberModifyPwCheck.do";
// 자동으로 확인된 회원번호 기록 (계정 목록과 별도). 아이디·회원번호만 담고 비밀번호·세션은 담지 않는다.
const VERIFIED_MEMBERS_KEY = "SPLIB_VERIFIED_MEMBERS_V1";
const VERIFIED_MEMBERS_VERSION = 1;
// 기록 쓰기 전용 배타 잠금 (FileManager.copy: 대상이 이미 있으면 실패). 조회 실행 표시(lease)와는 별개.
const BINDING_LOCK_FILE = "songpa-verified-members.lock";
const BINDING_CLAIM_PREFIX = "songpa-verified-members.claim-";

// ------------------------------------------------------------
// 화면 구조 가정 (실제 사이트에서 확인하지 못한 부분은 README에 적어 두었다)
// ------------------------------------------------------------

// 회원 신원: barcodeInfo 영역의 "회원번호 : 값" 같은 문구, 관측된 라벨 없는 barcodeInfo(앞쪽 표시 이름 글자 + span 하나, parseIdentity 참고),
// 또는 회원 전용 이름의 필드만 쓴다.
// userId(로그인 아이디 hidden 값), bookKey·regNo 같은 책 식별자는 회원 신원(회원번호)으로 쓰지 않는다.
// userId는 회원정보 확인 화면의 서버 주체 증명(parseProfilePrincipal)에서만, 저장한 아이디와 정확히 같은지 비교하는 데 쓴다.
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

// 같은 라벨의 값을 모두 읽는다 (표시 전용 소장처 근거 확인용. 여러 값이 다르면 쓰지 않는다)
function labeledValues(row, labelSource) {
  const re = new RegExp(`${labelSource}${LABEL_SEP}(?:<\\/span>${LABEL_SEP})?[:：]${LABEL_SEP}(?:<\\/span>${LABEL_SEP})?([^<]*)`, "g");
  return [...String(row || "").matchAll(re)].map(m => htmlToText(m[1]));
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

// 신원을 읽을 때 빼는 영역: 주석·script·style·template (화면에 보이는 신원이 아님).
// 닫히지 않았거나 짝이 맞지 않는 영역이 남으면 형식 오류로 본다.
// hidden: 뺀 script·style·template 안쪽 HTML. 신원을 고르는 데는 절대 쓰지 않고 충돌 검사에만 쓴다 (주석은 검사하지 않음).
function identityScope(html) {
  const hiddenParts = [];
  const clean = stripComments(html).replace(/<(script|style|template)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, tag, inner) => {
    hiddenParts.push(inner);
    return " ";
  });
  return { clean, hidden: hiddenParts, malformed: /<!--|<\/?(?:script|style|template)\b/i.test(clean) };
}

// 숨은 영역의 회원 증거 검사. 숨은 값은 신원으로 고르지 않는다. 반환 true = 충돌·형식 오류(거부)
// - 숨은 영역에 barcodeInfo 블록이 있으면: 화면 신원이 있을 때는 값이 같아도 거부, 구조가 이상하면 항상 거부
// - 숨은 회원 전용 필드: 형식 오류면 거부, 화면 신원과 다르면 거부
// - 숨은 영역 안에 또 script·style·template 여는/닫는 태그가 있으면(중첩·이상한 모양) 거부
function hiddenIdentityConflict(hiddenParts, visibleIds) {
  for (const part of hiddenParts) {
    if (/<\/?(?:script|style|template)\b/i.test(part)) return true;
    const { blocks, wellFormed } = findDivBlocks(part, "barcodeInfo");
    if (!wellFormed) return true;
    if (blocks.length > 0 && visibleIds.size > 0) return true;
    for (const v of semanticValues(part, MEMBER_ID_FIELDS, MEMBER_ID_DATA_ATTRS)) {
      const id = normalizeMemberId(v);
      if (!id) return true;
      if (visibleIds.size > 0 && !visibleIds.has(id)) return true;
    }
  }
  return false;
}

// 실제 사이트에서 관측한 라벨 없는 형태: <div class="barcodeInfo">표시 이름<span>회원번호</span></div>
// (앞의 표시 이름 글자는 없을 수도 있다). barcodeInfo 블록 안에서만, 앞쪽은 요소 없는 글자(표시 이름)뿐,
// 직접 자식 요소는 span 하나, 뒤쪽은 공백뿐일 때만 인정한다. 앞쪽 글자는 이름 비교(siteNames)에만 쓰고 회원번호·신원으로 쓰지 않는다.
// 반환: null(블록에 span 없음 → 이 형태 아님) / { ok:true, value } / { ok:false }(span이 있는데 모양이 다름 → 추측하지 않음)
// conflict:true = 앞쪽 글자에 회원번호·바코드 라벨이 있음 (라벨 값과 span 값 중 어느 것인지 추측하지 않음)
const PLAIN_MEMBER_SPAN_RE = /^([^<]*)<span\b[^>]*>([^<]*)<\/span\s*>\s*$/i;
const MEMBER_LABEL_WORD_RE = /회원\s*번호|회원\s*바코드|바코드/;
function plainSpanMember(block) {
  if (!/<span\b/i.test(block)) return null;
  const m = block.match(PLAIN_MEMBER_SPAN_RE);
  if (!m) return { ok: false };
  const text = htmlToText(m[2]);
  const id = /^[A-Za-z0-9][A-Za-z0-9-]{3,40}$/.test(text) ? normalizeMemberId(text) : null;
  if (!id) return { ok: false };
  if (MEMBER_LABEL_WORD_RE.test(htmlToText(m[1]))) return { ok: false, conflict: true };
  return { ok: true, value: id };
}

// 페이지에서 회원 신원(회원번호)을 보수적으로 읽는다.
// status: "ok"(하나로 확정) / "missing"(없음) / "ambiguous"(서로 다른 값 또는 형식 오류)
function parseIdentity(html) {
  const { clean, hidden, malformed } = identityScope(html);
  const raw = [];
  const siteNames = [];
  let invalid = malformed;
  const { blocks, wellFormed } = findDivBlocks(clean, "barcodeInfo");
  if (!wellFormed) invalid = true; // 닫히지 않았거나 중첩된 barcodeInfo
  let plainBlocks = 0;
  for (const block of blocks) {
    const lead = block.match(/^\s*([^<]+)/);
    if (lead) {
      const name = htmlToText(lead[1]).replace(/(?:회원\s*번호|회원\s*바코드|바코드)[\s\S]*$/, "").trim();
      if (name) siteNames.push(name);
    }
    const re = new RegExp(MEMBER_ID_LABEL_RE.source, "g");
    const text = htmlToText(block);
    let labelled = false;
    let m;
    while ((m = re.exec(text))) {
      raw.push(m[1]);
      labelled = true;
    }
    const plainSpan = plainSpanMember(block);
    if (labelled) {
      // 라벨 형태는 기존 방식 그대로. 단, 같은 블록에 라벨 없는 회원번호 span이 함께 있으면 서로 다른 증거이므로 거부한다.
      if (plainSpan && (plainSpan.ok || plainSpan.conflict)) invalid = true;
      continue;
    }
    if (!plainSpan) continue;
    plainBlocks++;
    if (plainSpan.ok) raw.push(plainSpan.value);
    else invalid = true;
  }
  // 라벨 없는 형태는 페이지에 barcodeInfo 블록이 정확히 하나일 때만 인정한다
  if (plainBlocks > 0 && blocks.length !== 1) invalid = true;
  // 페이지 전체의 회원 전용 필드와 합쳐서 본다 (서로 다르면 ambiguous)
  raw.push(...semanticValues(clean, MEMBER_ID_FIELDS, MEMBER_ID_DATA_ATTRS));

  const ids = new Set();
  for (const r of raw) {
    const id = normalizeMemberId(r);
    if (id) ids.add(id);
    else invalid = true;
  }
  // 숨은 영역(script·style·template)은 신원을 고르지 않지만, 화면 신원과 충돌하면 거부한다
  if (hiddenIdentityConflict(hidden, ids)) invalid = true;
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

// Python _copy_ids와 같은 두 형식만 읽는다. onclick은 텍스트로만 해석하며 실행하지 않는다.
// recKey는 대출 식별자, regNo는 도서 식별자다. 상호대차 신청번호로 재사용하지 않는다.
function rowCopyIdentifiers(row) {
  const triples = [];
  let checkbox = false, delayLink = false, invalid = false;
  const add = parts => {
    if (parts.length < 3 || !parts.slice(0,3).every(v=>/^[A-Za-z0-9._-]{1,64}$/.test(v))) { invalid=true; return; }
    triples.push(parts.slice(0,3));
  };
  const scope = identityScope(row);
  if (scope.malformed) invalid=true;
  for (const tag of scope.clean.match(/<(?:input|a|button)\b[^>]*>/gi) || []) {
    const loose = tagAttributes(tag);
    const check = /^<input\b/i.test(tag) && loose.name === "check";
    const link = /fnReturnDelayProc\s*\(/.test(String(loose.onclick || ""));
    if (!check && !link) continue;
    checkbox ||= check; delayLink ||= link;
    const parsed = strictTag(tag);
    if (!parsed || parsed.duplicate) { invalid=true; continue; }
    const attrs = Object.fromEntries(Object.entries(parsed.attrs).map(([k,v])=>[k,v==null?null:decodeEntities(v)]));
    if (check) {
      const parts = String(attrs.value || "").split("^");
      if (parts.length !== 5) invalid=true;
      else add(parts.map(v=>v.trim()));
    }
    if (link) {
      const call = String(attrs.onclick || "").match(/^\s*(?:javascript:\s*)?fnReturnDelayProc\s*\(([^()]*)\)\s*;?\s*(?:return\s+false;?)?\s*$/i);
      if (!call) { invalid=true; continue; }
      const args = call[1].split(",").map(v=>v.trim());
      const values = args.map(v=>{ const m=v.match(/^(?:'([A-Za-z0-9._-]*)'|"([A-Za-z0-9._-]*)"|([A-Za-z0-9._-]+))$/); return m ? (m[1]??m[2]??m[3]) : null; });
      if (values.some(v=>v===null)) invalid=true;
      else add(values);
    }
  }
  const unique = [...new Map(triples.map(t=>[JSON.stringify(t),t])).values()];
  const accepted = !invalid && unique.length===1;
  return { loan:accepted?unique[0][0]:null, copy:accepted?unique[0][1]:null,
    ambiguous:invalid||unique.length>1, checkbox, delayLink, accepted };
}

function combineRowIdentifier(named, legacy, field) {
  const other=legacy[field];
  if (named.ambiguous || legacy.ambiguous || (named.value && other && named.value!==other)) return {value:null,ambiguous:true};
  return {value:named.value || other || null,ambiguous:false};
}

// 표시 전용 등록번호 출처: COPY_ID_SPEC의 명시 근거(regNo 등 필드·data-reg-no·"등록번호" 라벨)가 하나로 확정되고
// 최종 등록번호와 같을 때만 true. 옛 형식(rowCopyIdentifiers: 체크박스·반납연기 링크)에서만 나온 값은 false.
// 옛 형식 값이 틀렸다는 뜻이 아니다(상호대차 쪽 이름공간이 확인되지 않았을 뿐). ids·scoped·stableKey·key·지문·연결에는 쓰지 않는다.
function explicitCopyEvidence(named, combined) {
  return Boolean(named && !named.ambiguous && named.value && combined && !combined.ambiguous && combined.value === named.value);
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
  const legacy = rowCopyIdentifiers(row);
  const loanId = combineRowIdentifier(typedId(row, text, LOAN_ID_SPEC), legacy, "loan");
  const namedCopy = typedId(row, text, COPY_ID_SPEC);
  const copyId = combineRowIdentifier(namedCopy, legacy, "copy");
  const rawLib = libMatch ? htmlToText(libMatch[1]) : "";
  const isBooksole = statusMatch ? statusMatch[1].includes("책솔이") : false;
  // 표시 전용 소장처 근거: 행에 명시된 "소장도서관"/"제공도서관" 라벨 값만 쓴다 (책솔이 행의 첫 <strong>은 수령처일 수 있음).
  // 제목·상태 칸과 주석·script·style·template 안은 보지 않는다. 값이 비었거나 서로 다르거나 구조가 이상하면 모름.
  // 식별번호·중복·연결 판단에는 쓰지 않는다.
  const ownerArea = identityScope(libArea);
  const ownerValues = ownerArea.malformed ? null : labeledValues(ownerArea.clean, "(?:소장|제공)\\s*도서관");
  const ownerScopes = new Set((ownerValues || []).map(libScope));
  const ownerLibAmbiguous = ownerValues === null || ownerScopes.has("") || ownerScopes.size > 1;
  const ownerLib = !ownerLibAmbiguous && ownerValues.length > 0 ? ownerValues[0] : "";
  const lib = libScope(rawLib);
  // 표시 전용 서지 정보 (제목·상태 칸 제외). 식별·중복·지문에는 쓰지 않는다
  const displayMeta = displayMetaOf(libArea);
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
    ownerLib,
    ownerLibAmbiguous,
    displayMeta,
    yy, mm, dd,
    dueDateStr: `${yy}.${pad2(mm)}.${pad2(dd)}`,
    isBooksole,
    ids,
    scoped,
    legacyIdShape: {checkbox:legacy.checkbox,delayLink:legacy.delayLink,accepted:legacy.accepted,ambiguous:legacy.ambiguous},
    displayCopyExplicit: explicitCopyEvidence(namedCopy, copyId), // 표시 전용 출처 (식별·중복·연결에는 쓰지 않음)
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
  const legacy = rowCopyIdentifiers(row);
  const illId = typedId(row, text, ILL_ID_SPEC);
  const namedCopy = typedId(row, text, COPY_ID_SPEC);
  const copyId = combineRowIdentifier(namedCopy, legacy, "copy");
  const providing = labeledValue(row, "제공\\s*도서관");
  const receiving = labeledValue(row, "수령\\s*도서관");
  const prov = libScope(providing);
  const recv = libScope(receiving);
  // 표시 전용 서지 정보 (제목·상태 칸 제외). 식별·중복·지문에는 쓰지 않는다
  let metaArea = row;
  for (const m of [titleMatch, statusMatch]) if (m) metaArea = metaArea.replace(m[0], " ");
  const displayMeta = displayMetaOf(metaArea);
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
    displayMeta,
    isKnownStatus: ACTIVE_DOO_STATUSES.includes(status) || INACTIVE_DOO_STATUSES.includes(status),
    ids,
    scoped,
    legacyIdShape: {checkbox:legacy.checkbox,delayLink:legacy.delayLink,accepted:legacy.accepted,ambiguous:legacy.ambiguous},
    displayCopyExplicit: explicitCopyEvidence(namedCopy, copyId), // 표시 전용 출처 (식별·중복·연결에는 쓰지 않음)
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

// 로그인된 메인 화면(INDEX_URL)에서 관측한 전자책 SSO 연결 폼. 이 스크립트는 이 폼을 제출하지 않는다.
// 주소에 "login"이 있어 일반 로그인 화면 검사에 걸리므로, 메인 화면에서만 이 폼 하나를 정확히 확인한 뒤 빼고 검사한다.
const INDEX_SSO_FORM = Object.freeze({
  name: "ebookForm",
  method: "post",
  action: "https://ebook.splib.or.kr/login_sso.asp",
  inputs: Object.freeze(["id", "name"])
});

function isSsoLikeForm(attrs) {
  return String(attrs.name || "").toLowerCase() === INDEX_SSO_FORM.name.toLowerCase() ||
    /login_sso|ebook\.splib/i.test(String(attrs.action || ""));
}

// 여는 태그와 안쪽이 관측된 모양과 정확히 같은지: 이름·method·주소(쿼리·조각 없음) 일치,
// 안쪽은 hidden input id·name 두 개(각 한 번, 값 있음)뿐. 비밀번호·버튼·다른 입력·글자가 있으면 아님.
function isExactIndexSsoForm(openTag, inner) {
  const a = tagAttributes(openTag);
  if (a.name !== INDEX_SSO_FORM.name) return false;
  if (String(a.method || "").toLowerCase() !== INDEX_SSO_FORM.method) return false;
  if (a.action !== INDEX_SSO_FORM.action) return false;
  const inputs = [];
  const rest = inner.replace(/<input\b[^>]*>/gi, (tag) => {
    inputs.push(tagAttributes(tag));
    return " ";
  });
  if (rest.trim() !== "" || inputs.length !== INDEX_SSO_FORM.inputs.length) return false;
  const names = new Set();
  for (const i of inputs) {
    if (String(i.type || "").toLowerCase() !== "hidden") return false;
    if (!INDEX_SSO_FORM.inputs.includes(i.name) || names.has(i.name)) return false;
    if (!hasOwn(i, "value") || i.value.trim() === "") return false;
    if (hasOwn(i, "formaction")) return false;
    names.add(i.name);
  }
  return names.size === INDEX_SSO_FORM.inputs.length;
}

// SSO처럼 보이는 폼이 정확히 하나이고 모양이 완전히 맞을 때만 그 폼을 뺀 HTML을 돌려준다. 아니면 원본 그대로.
// 값(id·name)은 모양 확인에만 쓰고 저장·표시·비교하지 않는다.
function withoutIndexSsoForm(html) {
  const s = String(html || "");
  const forms = [];
  const re = /<form\b[^>]*>/gi;
  let m;
  while ((m = re.exec(s))) forms.push({ index: m.index, tag: m[0] });
  const sso = forms.filter(f => isSsoLikeForm(tagAttributes(f.tag)));
  if (sso.length !== 1) return s;
  const f = sso[0];
  const innerStart = f.index + f.tag.length;
  const closeRe = /<\/form\s*>/gi;
  closeRe.lastIndex = innerStart;
  const c = closeRe.exec(s);
  if (!c) return s;
  const inner = s.slice(innerStart, c.index);
  if (/<form\b/i.test(inner) || !isExactIndexSsoForm(f.tag, inner)) return s;
  return `${s.slice(0, f.index)} ${s.slice(c.index + c[0].length)}`;
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

// 로그인 요청에는 JSESSIONID가 없는 무해한 익명 Cookie를 명시한다.
// Cookie를 비워 두면 공유 쿠키 저장소가 이전 계정의 JSESSIONID를 붙일 수 있고, 빈 값은 저장소 병합을 막지 못할 수 있다.
// (macOS 합성 시험에서 비어 있지 않은 명시 Cookie는 그대로 전송되고 저장소와 합쳐지지 않음을 확인. 실제 iPhone·실서버는 미확인)
const ANONYMOUS_LOGIN_COOKIE = "cookie=1";

async function login(account, ctx) {
  const req = newRequest(LOGIN_URL, null, timeoutFor(ctx));
  req.headers["Cookie"] = ANONYMOUS_LOGIN_COOKIE;
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
  // 메인 화면(INDEX_URL)에서만 관측된 전자책 SSO 폼 하나를 예외로 빼고, 나머지는 일반 로그인 화면 검사를 그대로 한다
  const body = expectedUrl === INDEX_URL ? withoutIndexSsoForm(page.body) : page.body;
  if (looksLikeLoginPage(body)) throw failure("integrity", "로그인 화면이 표시됨 (세션 만료 또는 인증 실패)");
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

// ------------------------------------------------------------
// 서버 주체(로그인 아이디) 증명: 회원정보 확인 화면 전용 읽기
// ------------------------------------------------------------
// 진단용 분류 코드가 붙은 신원 실패. 메시지에는 아이디·회원번호·쿠키 값을 넣지 않는다.
function proofFailure(code, message) {
  const e = failure("integrity", message);
  e.code = code;
  return e;
}

// 태그 하나를 엄격하게 읽는다. 속성 문법이 이상하면 null. 속성 이름은 소문자, 값은 엔티티를 풀지 않은 원문.
const STRICT_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>$/;
const STRICT_ATTR_RE = /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function strictTag(tag) {
  const m = STRICT_TAG_RE.exec(tag);
  if (!m) return null;
  const attrs = {};
  let duplicate = false;
  const re = new RegExp(STRICT_ATTR_RE.source, "g");
  let a;
  while ((a = re.exec(m[2]))) {
    const key = a[1].toLowerCase();
    if (hasOwn(attrs, key)) duplicate = true;
    attrs[key] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : null;
  }
  return { name: m[1].toLowerCase(), attrs, duplicate };
}

// 로그인 아이디처럼 보이는 필드(id/name 속성). 형식이 이상한 태그도 놓치지 않게 원문으로도 찾는다.
const PRINCIPAL_FIELD_NAMES = ["userid", "user_id", "loginid", "login_id"];
const PRINCIPAL_RAW_RE = /(?:^|[\s"'])(?:id|name)\s*=\s*["']?\s*(?:user_?id|login_?id)\s*(?:["'\s>\/]|$)/i;
function isPrincipalEvidence(tag) {
  const a = tagAttributes(tag);
  if (["id", "name"].some(k => hasOwn(a, k) && PRINCIPAL_FIELD_NAMES.includes(a[k].toLowerCase()))) return true;
  return PRINCIPAL_RAW_RE.test(tag);
}

// 화면에 실제로 그려지지 않는 영역 (주석·script·style·template·textarea 등). 이 안의 아이디는 주체로 고르지 않는다.
const PROFILE_INERT_TAGS = "script|style|template|textarea|noscript|xmp|iframe|object|title";

// 회원정보 확인 화면에서 로그인 아이디 주체를 읽어 기대한 아이디와 비교한다. 값 자체는 돌려주지 않는다.
// status: "ok"(정확히 일치) / "mismatch"(다른 아이디) / "missing"(없음) / "ambiguous"(여럿·형식 오류·숨은 영역 충돌)
// 인정하는 모양: 실제로 그려지는 영역의 <input> 하나, type=hidden, id="userId" 그리고 name="userId"(정확히), 속성 중복 없음,
// disabled·form 속성 없음, 비어 있지 않은 value. 값은 엔티티만 풀고 앞뒤 공백·대소문자를 고치지 않고 그대로 비교한다.
// 비밀번호 칸은 읽지 않는다. 폼 안에 있는지는 관측하지 않았으므로 보지 않는다.
function parseProfilePrincipal(html, expectedId) {
  const s = String(html || "");
  if (typeof expectedId !== "string" || expectedId === "") return { status: "ambiguous" };
  const inert = [];
  let clean = s.replace(/<!--([\s\S]*?)-->/g, (_, inner) => {
    inert.push(inner);
    return " ";
  });
  clean = clean.replace(new RegExp(`<(${PROFILE_INERT_TAGS})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, "gi"), (_, tag, inner) => {
    inert.push(inner);
    return " ";
  });
  if (new RegExp(`<!--|<\\/?(?:${PROFILE_INERT_TAGS})\\b`, "i").test(clean)) return { status: "ambiguous" };

  // 숨은 영역의 아이디 증거: 기대한 아이디와 정확히 같은 반사값만 허용하고, 다르거나 형식이 이상하면 거부
  for (const part of inert) {
    for (const tag of part.match(/<[a-zA-Z][^>]*>?/g) || []) {
      if (!isPrincipalEvidence(tag)) continue;
      const p = strictTag(tag);
      if (!p || p.duplicate || p.attrs.value == null || decodeEntities(p.attrs.value) !== expectedId) return { status: "ambiguous" };
    }
  }

  const found = (clean.match(/<[a-zA-Z][^>]*>?/g) || []).filter(isPrincipalEvidence);
  if (found.length === 0) return { status: "missing" };
  if (found.length > 1) return { status: "ambiguous" };
  const p = strictTag(found[0]);
  if (!p || p.duplicate || p.name !== "input") return { status: "ambiguous" };
  const a = p.attrs;
  const dec = (k) => (a[k] == null ? null : decodeEntities(a[k]));
  if (String(dec("type") || "").toLowerCase() !== "hidden") return { status: "ambiguous" };
  if (dec("id") !== "userId" || dec("name") !== "userId") return { status: "ambiguous" };
  if (hasOwn(a, "disabled") || hasOwn(a, "form")) return { status: "ambiguous" };
  const value = dec("value");
  if (value == null || value === "") return { status: "ambiguous" };
  return { status: value === expectedId ? "ok" : "mismatch" };
}

// 회원정보 확인 화면 응답 자체의 검사: 상태 200, 주소 정확히 일치(쿼리·조각·경로 매개변수·다른 출처 불가),
// 세션 쿠키 변경·삭제 없음, 일반 로그인 폼(action에 login)이 없음. 이 화면의 정상 비밀번호 칸은 이 화면에서만 허용한다.
function checkProfileProofResponse(page, session, where) {
  const res = page.res;
  if (!res || typeof res.statusCode !== "number") throw proofFailure("PROFILE_RESPONSE", `${where}: 회원정보 확인 화면의 응답 상태를 확인할 수 없습니다`);
  if (!session) throw proofFailure("PROFILE_RESPONSE", `${where}: 고정한 세션이 없어 확인할 수 없습니다`);
  try {
    checkSessionNotRotated(res, session);
  } catch (e) {
    throw proofFailure("SESSION_CHANGED", `${where}: 응답에서 세션 쿠키(JSESSIONID)가 바뀌거나 삭제되어 본인 확인을 할 수 없습니다`);
  }
  if (res.statusCode !== 200) throw proofFailure("PROFILE_RESPONSE", `${where}: 회원정보 확인 화면이 정상 응답이 아닙니다 (로그인이 풀렸거나 다른 화면으로 이동)`);
  if (res.url !== PROFILE_PROOF_URL) throw proofFailure("PROFILE_RESPONSE", `${where}: 회원정보 확인 화면의 응답 주소가 요청과 다릅니다`);
  if (/<form\b[^>]*\baction\s*=\s*["']?[^"'\s>]*login/i.test(String(page.body || ""))) {
    throw proofFailure("PROFILE_RESPONSE", `${where}: 로그인 화면이 표시됨 (세션 만료 또는 인증 실패)`);
  }
}

// 같은 세션으로 회원정보 확인 화면을 읽고, 서버가 보여 준 로그인 아이디가 이 계정의 아이디와 정확히 같은지,
// 같은 응답의 회원번호가 하나로 확정되는지 확인한다. 반환: 확인된 회원번호(정규화).
// 실패한 증명에서도 관측된 회원번호는 observed에 모아 계정 간 충돌 검사에만 쓴다(저장하지 않음).
async function proveProfilePrincipal(session, snap, observed, where, ctx) {
  let page;
  try {
    page = await getPage(PROFILE_PROOF_URL, session, timeoutFor(ctx));
  } catch (e) {
    throw proofFailure("PROFILE_NETWORK", `${where}: 회원정보 확인 화면을 불러오지 못했습니다`);
  }
  let identity;
  try {
    identity = parseIdentity(page.body);
  } catch (e) {
    throw proofFailure("PROFILE_PARSE", `${where}: 회원정보 확인 화면을 해석할 수 없습니다`);
  }
  for (const c of identity.candidates) observed.add(c);
  checkProfileProofResponse(page, session, where);
  let principal;
  try {
    principal = parseProfilePrincipal(page.body, snap.id);
  } catch (e) {
    throw proofFailure("PROFILE_PARSE", `${where}: 로그인 아이디 표시를 해석할 수 없습니다`);
  }
  if (principal.status === "missing") throw proofFailure("PRINCIPAL_MISSING", `${where}: 회원정보 확인 화면에서 로그인 아이디를 확인할 수 없습니다`);
  if (principal.status === "mismatch") throw proofFailure("PRINCIPAL_MISMATCH", `${where}: 로그인한 아이디와 다른 회원의 정보가 조회되었습니다`);
  if (principal.status !== "ok") throw proofFailure("PRINCIPAL_AMBIGUOUS", `${where}: 로그인 아이디 표시가 둘 이상이거나 형식이 달라 본인 확인을 할 수 없습니다`);
  if (identity.status === "missing") throw proofFailure("MEMBER_MISSING", `${where}: 화면에서 회원번호를 찾지 못했습니다`);
  if (identity.status !== "ok") throw proofFailure("MEMBER_AMBIGUOUS", `${where}: 회원번호가 둘 이상이거나 형식이 달라 본인 확인을 할 수 없습니다`);
  // 회원 이름(선택 항목) 대조는 기존 규칙 그대로
  try {
    verifyIdentity(identity, { memberId: identity.memberId, siteName: snap.siteName }, observed, where, true);
  } catch (e) {
    if (e && e.kind === "integrity") throw proofFailure("NAME_MISMATCH", `${where}: 회원 이름을 확인할 수 없거나 등록한 이름과 다릅니다`);
    throw e;
  }
  return identity.memberId;
}

// 임시 실기기 관측: 정해진 코드만 표시하고 응답/식별자/오류 원문은 저장하지 않는다.
function parsePagination(html) {
  const clean = identityScope(html);
  if (clean.malformed) return null;
  const found = findDivBlocks(clean.clean, "paging", ["div", "p", "ul", "ol", "nav"]);
  if (!found.wellFormed || found.blocks.length !== 1) return null;
  const block = found.blocks[0];
  const current = [...block.matchAll(/<strong\b[^>]*>\s*(\d+)\s*<\/strong\s*>/gi)].map(m=>Number(m[1]));
  for (const m of block.matchAll(/<span\b([^>]*)>\s*(\d+)\s*<\/span\s*>/gi)) {
    if ((tagAttributes(`<span ${m[1]}>`).class || "").split(/\s+/).includes("current")) current.push(Number(m[2]));
  }
  if (current.length !== 1 || current[0] < 1) return null;
  const nums = [current[0]];
  const controls = [...block.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)];
  for (const control of controls) {
    const attrs = tagAttributes(control[0].slice(0,control[0].indexOf(">")+1));
    const onclick = String(attrs.onclick || "").trim();
    const href = String(attrs.href || "").trim();
    const call = onclick.match(/^fnList\(\s*['"]?(\d+)['"]?\s*\)\s*;?\s*(?:return false;?)?$/);
    const js = href.match(/^javascript:\s*fnList\(\s*['"]?(\d+)['"]?\s*\)\s*;?$/i);
    const query = href.match(/^\?currentPageNo=(\d+)$/);
    const value = call || js || query;
    if (!value || (onclick && !call) || (href && !js && !query && !/^#[A-Za-z_-]*$/.test(href))) return null;
    nums.push(Number(value[1]));
  }
  if (block.replace(/<(a|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").match(/\b(?:onclick|href)\s*=/i)) return null;
  if (current[0] > 1 && !nums.includes(current[0] - 1)) return null;
  if (nums.some(n=>!Number.isSafeInteger(n)||n<1||n>100000)) return null;
  return { current: current[0], lastVisible: Math.max(...nums) };
}

function listProbeCode(warning) {
  if (!warning) return "OK";
  if (warning.includes("시간 제한")) return "BUDGET";
  if (warning.includes("네트워크")) return "NETWORK";
  if (warning.includes("앞 페이지와 같아")) return "REPEATED_PAGE";
  if (warning.includes("새 항목이 없어")) return "NO_NEW_ROWS";
  if (warning.includes("내용이 바뀌어")) return "CHANGED_PAGE";
  if (warning.includes("불러오지 못")) return "LOAD";
  if (warning.includes("최대")) return "PAGE_LIMIT";
  return "PARSE";
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
    if (clock.now() >= ctx.deadline) return { fail: `시간 제한으로 ${label}${n}페이지부터 확인하지 못했습니다` };
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
    return { parsed, pagination: parsePagination(page.body) };
  };

  for (let n = 1; n <= LIMITS.maxPages; n++) {
    const got = await loadPage(n, "");
    if (got.fail) return stop(`${spec.name}: ${got.fail}`);
    const parsed = got.parsed;
    pages = n;
    fingerprints.push(parsed.fingerprint);
    if (!parsed.empty) {
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
    // 검증된 빈 페이지 또는 모든 페이지 이동을 읽을 수 있는 명시적 마지막 쪽을 사용한다. 재확인에서도 끝 표시가 같아야 한다.
    const declaredEnd = got.pagination && got.pagination.current === n && got.pagination.lastVisible === n;
    if (parsed.empty || declaredEnd) {
      // 첫 페이지부터 빈 목록이면 한 번의 확인으로 0건 확정
      if (n === 1 && parsed.empty) return { records, complete: true, pages };
      // 조회 중 앞 페이지에서 항목이 빠지면(반납·삭제) 뒤 항목이 앞으로 밀려 중복 없이 빠질 수 있다.
      // 같은 페이지들(빈 끝 페이지 포함)을 한 번 더 읽어 첫 조회와 같은지 확인한다. 기록은 다시 더하지 않는다.
      // 두 번 같아도 서버 시점 일관성(스냅숏)을 보장하지는 않으며, 확인 가능한 변경만 줄여 준다.
      for (let v = 1; v <= n; v++) {
        const again = await loadPage(v, "재확인 ");
        if (again.fail) return stop(`${spec.name}: ${again.fail} (목록 전체를 확인하지 못해 일부만 표시)`);
        if (again.parsed.fingerprint !== fingerprints[v - 1] || (declaredEnd && (!again.pagination || again.pagination.current !== v || (v === n && again.pagination.lastVisible !== n)))) {
          return stop(`${spec.name}: 조회 중 ${v}페이지 내용이 바뀌어 빠진 항목이 있을 수 있습니다 (일부만 표시)`);
        }
      }
      return { records, complete: true, pages };
    }


  }
  return stop(`${spec.name}: 최대 ${LIMITS.maxPages}페이지까지만 확인했습니다`);
}

// ------------------------------------------------------------
// 표시 전용 "같은 책 추정" 묶음. 기록·개수·상태·경고를 바꾸지 않고 저장하지 않는다.
// ------------------------------------------------------------
// 전체 제목 키: 엔티티 해석(htmlToText 결과)과 공백 정리만 한다. 권차·부제·문장부호는 지우지 않는다.
function displayTitleKey(title) {
  return String(title || "").normalize("NFC").replace(/\s+/g, " ").trim();
}

// 대출의 확인된 소장 도서관 범위. 책솔이 대출은 명시된 소장/제공 도서관 라벨만 인정한다.
// 일반 대출은 기존 scoped.copy와 같이 행 도서관을 소장처로 보되, 명시 라벨과 다르면 모름.
// provLib·isInter 같은 표시용 대체값은 근거로 쓰지 않는다.
function loanOwnerScope(r) {
  if (!r || r.ownerLibAmbiguous) return null;
  if (r.ownerLib && isPlaceholderLib(r.ownerLib)) return null; // 명시 라벨이 자리 표시 문구면 모름
  const explicit = libScope(r.ownerLib || "");
  if (r.isBooksole) return explicit || null;
  if (isPlaceholderLib(r.rawLib)) return null;
  const row = libScope(r.rawLib);
  if (!row) return null;
  if (explicit && explicit !== row) return null;
  return row;
}

// 표시 전용 서지 정보(권차·판사항·ISBN): 행에 명시된 라벨만 읽는다. 묶음을 "막는" 데만 쓰고,
// 식별번호·중복·연결·개수·경고·지문(recordFingerprint)·저장에는 쓰지 않는다.
// 라벨 앞이 한글·영숫자이면 라벨로 보지 않는다 (예: "출판사항"의 "판사항"). 같은 라벨 값이 여럿이고 다르거나,
// 값이 비었거나, ISBN 형식이 이상하거나, 영역 구조가 이상하면 ambiguous(묶지 않음).
const DISPLAY_META_LABELS = Object.freeze({
  volume: "(?:^|[^가-힣A-Za-z0-9])(?:권\\s*차)",
  edition: "(?:^|[^가-힣A-Za-z0-9])(?:판\\s*(?:차|사항|본))",
  isbn: "(?:^|[^가-힣A-Za-z0-9])(?:[Ii][Ss][Bb][Nn](?:\\s*-?\\s*1[03])?)"
});

function displayMetaValue(field, raw) {
  const t = String(raw || "").normalize("NFC").replace(/\s+/g, "");
  if (field !== "isbn") return t;
  const d = t.replace(/[-‐]/g, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(d) ? d : "";
}

// area: 제목·상태 칸을 뺀 행 HTML. 주석·script·style·template 안은 읽지 않는다.
function displayMetaOf(area) {
  const scope = identityScope(area);
  if (scope.malformed) return { ambiguous: true, fields: {} };
  const fields = {};
  let ambiguous = false;
  for (const [field, label] of Object.entries(DISPLAY_META_LABELS)) {
    const values = labeledValues(scope.clean, label).map(v => displayMetaValue(field, v));
    if (values.length === 0) continue;
    const set = new Set(values);
    if (set.has("") || set.size > 1) {
      ambiguous = true;
      continue;
    }
    fields[field] = values[0];
  }
  return { ambiguous, fields };
}

// 양쪽 모두 명시된 항목만 비교한다. 한쪽에만 있으면 충돌로 보지 않는다. 어느 쪽이든 모호하면 묶지 않는다.
function displayMetaCompatible(a, b) {
  if (!a || !b || a.ambiguous || b.ambiguous) return false;
  for (const f of Object.keys(DISPLAY_META_LABELS)) {
    if (hasOwn(a.fields, f) && hasOwn(b.fields, f) && a.fields[f] !== b.fields[f]) return false;
  }
  return true;
}

// 도서관 자리 표시 문구(미확인·알 수 없음 등)는 소장처 근거가 아니다. 모양이 정확히 맞을 때만 (유사 도서관 추정 없음)
const PLACEHOLDER_LIB_RE = /^(?:[-–—?·.]+|(?:소장처|소장|제공|대출|수령)?(?:도서관)?(?:미확인|알수없음|확인불가|미상|정보없음|없음|모름|unknown|n\/a|null|undefined))$/i;
function isPlaceholderLib(s) {
  const t = String(s == null ? "" : s).normalize("NFC").replace(/[\s()\[\]（）]/g, "");
  return t === "" || PLACEHOLDER_LIB_RE.test(t);
}

// 연결되지 않은 대출 1건 + 진행 중 상호대차 1건만 짝짓는다 (같은 전체 제목 후보가 각각 정확히 1건일 때).
// 상호대차 소장처는 명시된 제공도서관만 쓴다 (수령도서관 일치는 근거가 아님).
function probableDisplayPairs(unjoinedLoans, unjoinedActiveDoos) {
  const loansByTitle = groupBy(unjoinedLoans, r => displayTitleKey(r.title));
  const doosByTitle = groupBy(unjoinedActiveDoos, d => displayTitleKey(d.title));
  const pairs = [];
  for (const [key, ls] of loansByTitle) {
    const ds = doosByTitle.get(key);
    if (!ds || ls.length !== 1 || ds.length !== 1) continue;
    const loan = ls[0];
    const doo = ds[0];
    if (loan.ambiguousIds || doo.ambiguousIds) continue;
    if (loan.ids && doo.ids && loan.ids.copy && doo.ids.copy && loan.ids.copy !== doo.ids.copy) continue;
    const owner = loanOwnerScope(loan);
    const provider = isPlaceholderLib(doo.providing) ? "" : libScope(doo.providing);
    if (!owner || !provider || owner !== provider) continue;
    // 권차·판사항·ISBN이 양쪽에 명시되어 다르거나, 어느 쪽이든 모호하면 묶지 않는다
    if (!displayMetaCompatible(loan.displayMeta, doo.displayMeta)) continue;
    pairs.push([loan, doo]);
  }
  return pairs;
}

// 표시 전용 책솔이 반납처 (v1.2.7 return-location-1). 같은 계정·같은 전체 제목(displayTitleKey)의 수령 기록(입수·완료)에서
// 수령/제공 도서관 쌍이 하나로 확정될 때만 쓴다. 원래 기록·lib·provLib·shortLib·libSummary·개수·경고·연결은 바꾸지 않는다.
// 소장 도서관으로 반납처를 추정하지 않는다. 같은 실물 책이라는 판단이 아니며 등록번호 연결(joinOf)을 대신하지 않는다.
const RECEIPT_DOO_STATUSES = ["입수", "완료"];
function resolveBooksoleLocation(loan, sameTitleLoans, receipts) {
  if (sameTitleLoans.length !== 1 || receipts.length === 0) return null;
  if (loan.ambiguousIds || loan.ownerLibAmbiguous) return null;
  const raw = isPlaceholderLib(loan.rawLib) ? "" : libScope(loan.rawLib);
  if (!raw) return null;
  const pairs = new Set();
  for (const d of receipts) {
    if (d.ambiguousIds || isPlaceholderLib(d.receiving) || isPlaceholderLib(d.providing)) return null;
    const recv = libScope(d.receiving);
    const prov = libScope(d.providing);
    if (!recv || !prov) return null;
    if (loan.ids && d.ids && loan.ids.copy && d.ids.copy && loan.ids.copy !== d.ids.copy) return null;
    if (!displayMetaCompatible(loan.displayMeta, d.displayMeta)) return null;
    pairs.add(`${recv}>${prov}`);
  }
  if (pairs.size !== 1) return null;
  const first = receipts[0];
  const recv = libScope(first.receiving);
  const prov = libScope(first.providing);
  if (raw !== prov && raw !== recv) return null;
  if (loan.ownerLib) {
    const owner = isPlaceholderLib(loan.ownerLib) ? "" : libScope(loan.ownerLib);
    if (!owner || owner !== prov) return null;
  }
  return { receiving: first.receiving, providing: first.providing };
}

// 연결되지 않은 책솔이 대출 → { receiving, providing } 또는 null(반납처 미확인). 일반·연결된 대출은 넣지 않는다.
function booksoleDisplayLocations(loans, doos, joinOf, joined) {
  const out = new Map();
  const loansByTitle = groupBy(loans, r => displayTitleKey(r.title));
  const receiptsByTitle = groupBy(doos.filter(d => RECEIPT_DOO_STATUSES.includes(d.status) && !joined.has(d)), d => displayTitleKey(d.title));
  for (const r of loans) {
    if (!r.isBooksole || joinOf.has(r)) continue;
    const key = displayTitleKey(r.title);
    out.set(r, resolveBooksoleLocation(r, loansByTitle.get(key) || [], receiptsByTitle.get(key) || []));
  }
  return out;
}

// 대출·상호대차 기록을 화면용 목록으로 합친다. 제목만으로는 절대 합치거나 숨기지 않는다.
// warnings: 참고 안내(결과는 확정). issues: 데이터 품질 문제 → uncertain=true(계정 결과를 "일부만 확인"으로)
function buildMemberBooks(loanRecords, dooRecords, userName, info) {
  const warnings = [];
  const issues = [];
  // 화면 제외 출처: 식별번호 없음·식별번호 없는 페이지 사이 중복 의심·같은 제목 대출/상호대차 연결 미확정 안내만.
  // 원래 warnings·uncertain·status에는 그대로 남는다 (화면 노란 안내에만 쓰지 않음).
  const quiet = new Set();
  const quietIssue = message => { issues.push(message); quiet.add(message); };
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
    quietIssue(`식별번호가 없어 같은 책인지 알 수 없는 대출 ${loanAmbiguous}건을 모두 표시했습니다 (중복일 수 있음)`);
  }
  if (idlessLoans.length > 0 && info && info.loanPages > 1) {
    quietIssue("여러 페이지 대출 목록에 식별번호가 없는 항목이 있어 페이지 사이 중복 여부를 확인할 수 없습니다");
  }
  const idlessDoos = doos.filter(r => r.isActive && !r.scoped.ill);
  const dooAmbiguous = countDupGroups(idlessDoos, r => `${r.normTitle}|${r.status}|${r.providing}|${r.receiving}|${r.ids.copy || ""}`);
  if (dooAmbiguous > 0) {
    quietIssue(`식별번호가 없어 같은 신청인지 알 수 없는 상호대차 ${dooAmbiguous}건을 모두 표시했습니다 (중복일 수 있음)`);
  }
  if (idlessDoos.length > 0 && info && info.dooPages > 1) {
    quietIssue("여러 페이지 상호대차 목록에 식별번호가 없는 항목이 있어 페이지 사이 중복 여부를 확인할 수 없습니다");
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
  const itemOf = new Map(); // 표시 묶음용 기록 → 화면 항목 (내부 전용)
  let loanCount = 0;
  let pickupCount = 0;
  let transitCount = 0;

  const displayLocations = booksoleDisplayLocations(loans, doos, joinOf, joined); // 표시 전용 (원래 값은 그대로)
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
      qualityNotes: [
        ...(!r.scoped.loan && !r.scoped.copy && (loanAmbiguous>0 || (info && info.loanPages>1)) ? ["중복 여부 미확정"] : []),
        ...(doos.some(d=>d.isActive&&!joined.has(d)&&d.normTitle===r.normTitle&&(!d.scoped.copy||!r.scoped.copy)) ? ["대출·상호대차 연결 미확정"] : [])
      ],
      title: r.title,
      lib: returnLib,
      provLib,
      shortLib,
      statusType: "대출중",
      diffDays,
      dueDate: r.dueDateStr,
      shortDate: `${pad2(r.mm)}.${pad2(r.dd)}`,
      isInter: r.isBooksole || Boolean(activeDoo),
      displayCopyScope: r.scoped.copy || null, // 표시 전용: 같은 도서관 범위 등록번호 (화면 묶음 제외 판단에만)
      displayCopyExplicit: Boolean(r.displayCopyExplicit && r.scoped.copy && !isPlaceholderLib(r.rawLib)) // 표시 전용: 명시 등록번호 + 실제 도서관 범위
    });
    if (displayLocations.has(r)) {
      const loc = displayLocations.get(r);
      const it = items[items.length - 1];
      if (loc) Object.assign(it, { displayLocation: "resolved", displayReturnLib: loc.receiving, displayOwnerLib: loc.providing, displayShortLib: abbreviateLibrary(loc.receiving) });
      else Object.assign(it, { displayLocation: "unknown", displayRawLib: r.rawLib });
    }
    itemOf.set(r, items[items.length - 1]);
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
      qualityNotes: [
        ...(!d.scoped.ill && (dooAmbiguous>0 || (info && info.dooPages>1)) ? ["중복 여부 미확정"] : []),
        ...(loanTitleLacksCopy.has(d.normTitle)&&(!d.scoped.copy||loanTitleLacksCopy.get(d.normTitle)) ? ["대출·상호대차 연결 미확정"] : []),
        ...(!d.receiving ? ["수령처 미확인"] : [])
      ],
      title: d.title,
      lib: d.receiving || "수령도서관 미확인",
      provLib: d.providing || "미확인",
      shortLib,
      statusType: pickup ? "픽업필요" : "이동중",
      diffDays: pickup ? -999 : 999, // 픽업필요는 맨 위, 이동중은 맨 아래
      dueDate: "-",
      shortDate: "-",
      isInter: true,
      displayCopyScope: d.scoped.copy || null, // 표시 전용: 제공(소장) 도서관 범위 등록번호
      displayCopyExplicit: Boolean(d.displayCopyExplicit && d.scoped.copy && !isPlaceholderLib(d.providing)) // 표시 전용: 명시 등록번호 + 실제 제공 도서관
    });
    itemOf.set(d, items[items.length - 1]);
  }
  if (sameTitleUnlinked > 0) {
    quietIssue(`대출 중인 책과 제목이 같은 상호대차 ${sameTitleUnlinked}건은 같은 책인지 확인할 식별번호가 없어 따로 표시했습니다`);
  }
  if (missingReceiving > 0) {
    issues.push(`수령도서관을 확인하지 못한 진행 중 상호대차 ${missingReceiving}건이 있습니다 (수령처 미확인)`);
  }
  if (unknownStatus > 0) issues.push(`알 수 없는 상호대차 상태 ${unknownStatus}건은 표시하지 않았습니다`);

  // 5. 표시 전용 "같은 책 추정": 확정 연결(joinOf/joined)은 후보에서 빼고, 항목에 묶음 표시만 붙인다.
  //    개수·상태·경고·uncertain은 바꾸지 않는다.
  //    v1.2.6부터 화면은 이 값을 쓰지 않는다 (displayTitleGroups가 같은 계정의 전체 제목으로 따로 묶음). 내부 호환용으로만 남긴다.
  probableDisplayPairs(loans.filter(r => !joinOf.has(r)), doos.filter(d => d.isActive && !joined.has(d))).forEach((pair, i) => {
    const group = `g${i + 1}`;
    for (const rec of pair) {
      const item = itemOf.get(rec);
      if (item) item.displayGroup = group;
    }
  });

  // 정렬: 픽업필요(-999) -> 대출중(반납 임박순) -> 이동중(999)
  items.sort((a, b) => a.diffDays - b.diffDays);
  const identifierEvidence = {};
  for (const [label,records] of [["loan",loanRecords],["doo",dooRecords]]) {
    identifierEvidence[label+"CheckShape"] = records.some(r=>r.legacyIdShape?.checkbox);
    identifierEvidence[label+"DelayShape"] = records.some(r=>r.legacyIdShape?.delayLink);
    identifierEvidence[label+"LegacyAccepted"] = records.some(r=>r.legacyIdShape?.accepted);
    identifierEvidence[label+"LegacyAmbiguous"] = records.some(r=>r.legacyIdShape?.ambiguous);
    identifierEvidence[label+"CopyAvailable"] = records.some(r=>!!r.ids?.copy);
  }
  return { items, libSummary, loanCount, pickupCount, transitCount, identifierEvidence, coverageUncertain: exactDup>0 || unknownStatus>0, warnings: issues.concat(warnings), displayIssues: issues.filter(w => !quiet.has(w)).concat(warnings), uncertain: issues.length > 0 };
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

// ------------------------------------------------------------
// 계정 값 고정(snapshot)과 기대 회원번호
// ------------------------------------------------------------
// 저장된 회원번호 값의 상태: 없음(undefined/null) / 올바름 / 형식 오류(있는데 틀림 → 오류, 다른 값으로 대신하지 않음)
function memberIdState(value) {
  if (value === undefined || value === null) return { state: "absent", value: null };
  const m = typeof value === "string" || typeof value === "number" ? normalizeMemberId(value) : null;
  return m ? { state: "valid", value: m } : { state: "invalid", value: null };
}

// 실행 한 번 동안 쓸 계정 값을 한 번만 읽어 고정한다. 호출한 쪽의 계정 객체는 바꾸지 않는다.
function snapshotAccount(account) {
  const src = account && typeof account === "object" ? account : {};
  const id = src.id;
  const pw = src.pw;
  const member = memberIdState(src.memberId);
  const label = src.label;
  const siteName = src.siteName;
  let problem = null;
  if (typeof id !== "string" || id === "") problem = "설정 오류: 아이디가 비어 있거나 형식이 올바르지 않습니다 (songpa-accounts에서 확인)";
  else if (typeof pw !== "string" || pw === "") problem = "설정 오류: 비밀번호가 비어 있습니다 (songpa-accounts에서 확인)";
  else if (member.state === "invalid") problem = INVALID_MEMBER_ID_MESSAGE;
  return Object.freeze({
    ok: !problem,
    problem,
    label,
    id: typeof id === "string" ? id : "",
    pw: typeof pw === "string" ? pw : "",
    manualMemberId: member.value,
    memberState: member.state,
    siteName: typeof siteName === "string" && siteName.trim() !== "" ? siteName : undefined
  });
}

// 계정 하나의 기대 회원번호: 직접 입력한 값 → 확인 기록 → 없음(첫 확인). 둘 다 있는데 다르면 조회하지 않는다.
// 확인 기록이 있어도 매번 서버 주체 증명을 다시 한다(수동 회원번호를 건너뛰는 지름길이 아님).
function expectedMemberFor(snap, store) {
  if (!snap.ok) return { error: snap.problem, memberId: null, source: null };
  const cached = store.status === "ok" ? store.records.get(snap.id) : undefined;
  if (snap.memberState === "valid") {
    if (cached !== undefined && cached !== snap.manualMemberId) {
      return { error: "설정 오류: 직접 입력한 회원번호와 이전에 확인된 회원번호 기록이 달라 조회하지 않았습니다", memberId: null, source: null };
    }
    return { error: null, memberId: snap.manualMemberId, source: "manual" };
  }
  if (store.status === "invalid") {
    return { error: "확인된 회원번호 기록을 읽을 수 없어 조회하지 않았습니다 (기록이 손상되었거나 형식이 다름)", memberId: null, source: null };
  }
  if (cached !== undefined) return { error: null, memberId: cached, source: "cache" };
  return { error: null, memberId: null, source: null };
}

// 계정 하나 조회. 반환: { result(화면용), observedIds(관측 회원번호), session(교차 확인용, 화면에 쓰지 않음),
//   binding(첫 확인 후보: 모든 확인을 통과한 경우에만. 저장은 fetchAllAccounts가 충돌 검사 뒤에 한다) }
async function fetchAccount(snap, ctx, expected) {
  const observed = new Set();
  let session = null;
  const traceStart = clock.now();
  const trace = [];
  const mark = (stage, flags = "") => trace.push(`${stage}:${Math.max(0, clock.now() - traceStart)}${flags ? ":" + flags : ""}`);
  let stage = "SETUP";
  mark(stage);
  const want = expected || { error: null, memberId: null, source: null };
  try {
    if (!snap.ok) throw failure("setup", snap.problem);
    if (want.error) throw failure("setup", want.error);
    if (clock.now() >= ctx.deadline) throw failure("page", "시간 제한으로 이 계정은 조회하지 못했습니다");

    stage = "LOGIN";
    session = await login(snap, ctx);
    mark(stage);
    // 1. 서버 주체 증명: 같은 세션의 회원정보 확인 화면에서 로그인 아이디가 정확히 같고 회원번호가 하나여야 한다
    stage = "PROFILE_START";
    const proven = await proveProfilePrincipal(session, snap, observed, "로그인 직후 회원정보 확인", ctx);
    mark(stage);
    if (want.memberId && proven !== want.memberId) {
      throw failure("integrity", want.source === "manual"
        ? "로그인 직후 회원정보 확인: 등록한 회원번호와 다른 회원의 정보가 조회되었습니다"
        : "로그인 직후 회원정보 확인: 이전에 확인된 회원번호와 다른 회원의 정보가 조회되었습니다");
    }
    // 이후 모든 화면은 이 고정된 회원번호로 확인한다 (계정 원본은 바꾸지 않음)
    const effective = Object.freeze({ label: snap.label, id: snap.id, siteName: snap.siteName, memberId: proven });

    try {
      stage = "HOME_START";
      await checkIndexIdentity(session, effective, observed, "로그인 직후 확인", ctx);
      mark(stage);
    } catch (e) {
      throw e.kind === "integrity" ? e : failure("page", `로그인 직후 확인 실패 (${e.message})`);
    }

    stage = "LOAN";
    const listCtx = { deadline: Math.max(clock.now(), ctx.deadline - Math.min(8000, Math.max(0, ctx.deadline - clock.now()) / 3)) };
    const loanCtx = { deadline: clock.now() + Math.max(0, listCtx.deadline - clock.now()) / 2 };
    const loan = await fetchList(LISTS.loan, session, effective, observed, loanCtx);
    mark(stage, `complete=${loan.complete},pages=${loan.pages},reason=${listProbeCode(loan.warning)}`);
    stage = "DOO";
    const doo = await fetchList(LISTS.doo, session, effective, observed, listCtx);
    mark(stage, `complete=${doo.complete},pages=${doo.pages},reason=${listProbeCode(doo.warning)}`);

    // 목록 화면에 신원이 없을 수도 있으므로 끝난 뒤 다시 확인한다. 실패하면 이번 결과를 모두 버린다.
    try {
      stage = "HOME_END";
      await checkIndexIdentity(session, effective, observed, "조회 후 재확인", ctx);
      mark(stage);
    } catch (e) {
      throw failure("integrity", e.kind === "integrity" ? e.message : `조회 후 재확인 실패 (${e.message})`);
    }
    // 마지막 주체 증명: 같은 세션에서 같은 로그인 아이디·같은 회원번호여야 한다
    let finalMember;
    try {
      stage = "PROFILE_END";
      finalMember = await proveProfilePrincipal(session, snap, observed, "조회 후 회원정보 재확인", ctx);
      mark(stage);
    } catch (e) {
      throw failure("integrity", e.message);
    }
    if (finalMember !== proven) throw failure("integrity", "조회 후 회원정보 재확인: 처음 확인한 회원과 다른 회원의 정보가 조회되었습니다");

    const listWarnings = [loan.warning, doo.warning].filter(Boolean);
    const hasData = loan.complete || doo.complete || loan.records.length + doo.records.length > 0;
    if (!hasData) {
      return { result: {...errorResult(snap, safeMessage(listWarnings.join(" / "), [snap.pw, proven, session])), nativeTrace: trace.join(" ")}, observedIds: [...observed], session, binding: null };
    }
    const { uncertain, displayIssues, ...books } = buildMemberBooks(loan.records, doo.records, accountLabel(snap), { loanPages: loan.pages, dooPages: doo.pages });
    // 실제 목록 조회 경고(네트워크·일부 페이지·시간 제한 등). safeMessage로 가린 값만 담는다.
    const collectionWarnings = listWarnings.map(w => safeMessage(w, [snap.pw, proven, session]));
    return {
      result: {
        ...errorResult(snap, ""),
        nativeTrace: trace.join(" "),
        ...books,
        // 데이터 품질 문제(모르는 상태, 풀리지 않은 중복·연결, 빠진 필수 정보)도 "일부만 확인"이다
        status: loan.complete && doo.complete && !uncertain ? "ok" : "partial",
        warnings: collectionWarnings.concat(books.warnings),
        collectionWarnings,
        // 화면 노란 안내용: 조회 경고 + 실제 확인이 필요한 데이터 문제 (식별번호 없음·같은 제목 연결 미확정 안내 제외)
        displayWarnings: collectionWarnings.concat(displayIssues),
        loanComplete: loan.complete,
        dooComplete: doo.complete
      },
      observedIds: [...observed],
      session,
      // 이 경로는 초기/최종 서버 ID 증명과 모든 조회 페이지의 회원번호 대조를 이미 통과했다.
      // 목록 완전성과 소유권은 다르다. 최종 ID 증명까지 통과한 부분 결과도 자기 데이터다.
      verifiedQueryComplete: loan.complete && doo.complete,
      principalProven: true,
      // 직접 입력·기록된 회원번호가 없을 때만 첫 저장 후보. 비밀번호는 저장 직전 "계정이 그대로인지" 확인에만 쓰고 저장하지 않는다.
      binding: want.memberId ? null : { loginId: snap.id, memberId: proven, pw: snap.pw }
    };
  } catch (e) {
    const message = safeMessage(e && e.message, [snap.pw, snap.manualMemberId, want.memberId, snap.id, session]);
    mark("FAIL_" + stage, "kind=" + (["integrity", "page", "setup", "network"].includes(e && e.kind) ? e.kind : "OTHER"));
    return { result: {...errorResult(snap, message), nativeTrace: trace.join(" ")}, observedIds: [...observed], session, binding: null };
  }
}

function quarantined(result, reason) {
  return {
    ...result,
    status: "error",
    error: result.error ? `${result.error} / ${reason}` : reason,
    warnings: [],
    collectionWarnings: [],
    displayWarnings: [],
    items: [],
    libSummary: {},
    loanCount: 0,
    pickupCount: 0,
    transitCount: 0
  };
}

// 같은 회원번호는 모두 숨긴다. 같은 SID의 본인 확인 완료 스냅숏은 순차 조회 기록으로만 구분한다.
function quarantineCollisions(entries, verifiedSerialAccounts = null) {
  const reasons = entries.map(() => []);
  const collide = (keysOf, message, exemptEntries = null) => {
    const map = new Map();
    entries.forEach((e, i) => {
      for (const k of keysOf(e)) {
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(i);
      }
    });
    for (const idxs of map.values()) {
      if (idxs.size < 2) continue;
      const exempt = exemptEntries ? exemptEntries([...idxs].map(i => entries[i])) : null;
      for (const i of idxs) {
        if (exempt && exempt.has(entries[i])) continue;
        const others = [...idxs].filter(j => j !== i).map(j => entries[j].result.name).join(", ");
        reasons[i].push(message(others));
      }
    }
  };
  const provenEntries = group => !(verifiedSerialAccounts instanceof Map) ? [] : group.filter(e=>verifiedSerialAccounts.has(e)&&e.principalProven===true&&e.result.status!=="error"&&e.observedIds.length===1);
  // 실패한 다른 계정에서 관측한 번호는 이미 최종 본인검증을 마친 결과의 소유권을 바꾸지 않는다.
  // 두 성공 계정 자체의 회원번호가 충돌하면 기존처럼 모두 차단한다.
  collide(e => e.observedIds || [], o => `다른 계정(${o})의 조회에서도 같은 회원번호가 확인되어 결과를 모두 숨겼습니다`, group=>{
    const proven=provenEntries(group); return proven.length===1 ? new Set(proven) : null;
  });
  // fetchAllAccounts의 순차 await 루프만 이 Map을 만든다. 이름·HTML의 표시·호출자 플래그는 근거가 아니다.
  // 각각의 결과가 본인 증명을 끝낸 스냅숏이면, 다음 로그인이 같은 SID를 재사용해도 앞 결과의 소유자는 바뀌지 않는다.
  // 최종 본인검증에 실패한 계정은 숨긴다. 목록의 부분 결과는 경고와 함께 표시한다. 다른 계정의 후속 실패가 이미 확인한 스냅숏의 소유자를 바꾸지는 않는다.
  const verifiedSerialGroup = group => {
    if (!(verifiedSerialAccounts instanceof Map)) return null;
    const verified = group.filter(e => verifiedSerialAccounts.has(e) && e.principalProven === true &&
      e.result.status !== "error" && e.observedIds.length === 1);
    if (new Set(verified.map(e => verifiedSerialAccounts.get(e))).size !== verified.length ||
        new Set(verified.map(e => e.observedIds[0])).size !== verified.length) return null;
    return new Set(verified);
  };
  collide(e => (e.session ? [e.session] : []), o => `다른 계정(${o})과 같은 세션이 재사용되어 결과를 모두 숨겼습니다`, verifiedSerialGroup);
  return entries.map((e, i) => (reasons[i].length > 0 ? quarantined(e.result, reasons[i].join(" / ")) : e.result));
}

// 모든 계정을 순서대로 조회하고 계정 사이 충돌을 검사한다.
// 첫 확인 회원번호는 모든 계정의 마지막 확인과 계정 간 충돌 검사(같은 회원번호·같은 세션)가 끝난 뒤,
// 숨겨지지 않은 계정의 것만 한꺼번에 저장한다.
async function fetchAllAccounts(accounts, budgetMs, deferBindingCommit = false, onProgress = null) {
  const globalDeadline = clock.now() + budgetMs;
  const snaps = accounts.map(snapshotAccount);
  const store = readVerifiedStore();
  const expectations = snaps.map(s => expectedMemberFor(s, store));
  const counts = new Map();
  for (const x of expectations) {
    if (x.memberId) counts.set(x.memberId, (counts.get(x.memberId) || 0) + 1);
  }
  const entries = [];
  const verifiedSerialAccounts = new Map();
  const publish = async activeIndex => {
    if (typeof onProgress !== "function") return;
    try { await onProgress({results:quarantineCollisions(entries,verifiedSerialAccounts),activeIndex}); } catch (_) {}
  };
  await publish(0);
  for (let i = 0; i < snaps.length; i++) {
    const m = expectations[i].memberId;
    if (m && counts.get(m) > 1) {
      entries.push({ result: errorResult(snaps[i], "설정 오류: 같은 회원번호가 다른 계정에도 등록되어 있습니다 (songpa-accounts에서 확인)"), observedIds: [], session: null, binding: null });
      await publish(i+1);
      continue;
    }
    // 다음 계정 로그인은 앞 계정의 최종 증명이 끝난 뒤에만 시작한다. 병렬화하면 이 예외를 사용할 수 없다.
    const remaining = snaps.length - i;
    const now = clock.now();
    const ctx = { deadline: now + Math.max(0, globalDeadline - now) / remaining };
    const entry = await fetchAccount(snaps[i], ctx, expectations[i]);
    entries.push(entry);
    if (entry.principalProven === true && entry.result.status !== "error") verifiedSerialAccounts.set(entry, snaps[i].id);
    await publish(i+1);
  }
  entries.forEach((entry, index) => {
    const peers = entry.session ? entries.filter(other => other.session === entry.session).length : 0;
    entry.result.nativeTrace = `A${index + 1} ${entry.result.nativeTrace || ""} PRE=${entry.result.status} observed=${entry.observedIds.length} serial=${verifiedSerialAccounts.has(entry)} shared=${peers} previousSID=${index > 0 && Boolean(entry.session) && entry.session === entries[index-1].session}`;
  });
  const results = quarantineCollisions(entries, verifiedSerialAccounts);
  // collectData는 실행 표시 소유권을 확인한 뒤에만 초기 저장을 확정한다.
  if (deferBindingCommit === true) return { entries, results };
  return applyVerifiedBindings(entries, results);
}

// ------------------------------------------------------------
// 확인된 회원번호 기록 (SPLIB_VERIFIED_MEMBERS_V1)
// 형식: {"version":1,"records":[{"origin":"https://splib.or.kr","loginId":"...","memberId":"..."}]}
// 공식 출처 + 로그인 아이디 하나에 회원번호 하나. 비밀번호·세션은 담지 않는다. 계정 목록(SPLIB_ACCOUNTS)은 바꾸지 않는다.
// ------------------------------------------------------------
function parseVerifiedStore(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.keys(data).sort().join(",") !== "records,version") return null;
  if (data.version !== VERIFIED_MEMBERS_VERSION || !Array.isArray(data.records)) return null;
  const records = new Map();
  const members = new Set();
  for (const r of data.records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    if (Object.keys(r).sort().join(",") !== "loginId,memberId,origin") return null;
    if (r.origin !== BASE_URL) return null;
    if (typeof r.loginId !== "string" || r.loginId === "") return null;
    if (typeof r.memberId !== "string" || normalizeMemberId(r.memberId) !== r.memberId) return null;
    // 같은 아이디가 두 번이거나 같은 회원번호가 두 아이디에 있으면 기록 전체를 믿지 않는다
    if (records.has(r.loginId) || members.has(r.memberId)) return null;
    records.set(r.loginId, r.memberId);
    members.add(r.memberId);
  }
  return records;
}

function serializeVerifiedStore(records) {
  return JSON.stringify({
    version: VERIFIED_MEMBERS_VERSION,
    records: [...records].map(([loginId, memberId]) => ({ origin: BASE_URL, loginId, memberId }))
  });
}

// status: "absent"(기록 없음) / "ok" / "invalid"(읽기 실패·형식 오류 → 기록에 기대는 계정은 조회하지 않고, 쓰지도 않음)
function readVerifiedStore() {
  try {
    if (!Keychain.contains(VERIFIED_MEMBERS_KEY)) return { status: "absent", records: new Map() };
    const records = parseVerifiedStore(Keychain.get(VERIFIED_MEMBERS_KEY));
    return records ? { status: "ok", records } : { status: "invalid", records: new Map() };
  } catch (e) {
    return { status: "invalid", records: new Map() };
  }
}

// 저장 직전 계정 목록을 다시 읽는다 (앱 안에서만 읽고 밖으로 내보내지 않음). 읽을 수 없으면 null.
function readAccountsForCommit() {
  try {
    if (!Keychain.contains(KEYCHAIN_KEY)) return [];
    const parsed = JSON.parse(Keychain.get(KEYCHAIN_KEY));
    return Array.isArray(parsed) ? parsed.filter(a => a && typeof a === "object") : null;
  } catch (e) {
    return null;
  }
}

function randomToken() {
  let base = "";
  try {
    if (typeof UUID !== "undefined" && UUID && typeof UUID.string === "function") base = String(UUID.string());
  } catch (e) {
    base = "";
  }
  const rnd = () => Math.random().toString(36).slice(2, 12);
  return `${base}-${clock.now().toString(36)}-${rnd()}${rnd()}`.replace(/[^A-Za-z0-9-]/g, "");
}

// 배타 잠금: 자기만의 임시 claim 파일을 만든 뒤 FileManager.copy(claim, lock)로 잠금 파일을 만든다.
// Scriptable 문서상 copy는 대상 파일이 이미 있으면 실패한다(writeString·move는 덮어씀). copy가 성공했을 때만 잠금을 가진 것으로 본다.
// 오래된 잠금을 시간으로 자동 삭제하지 않는다(살아 있는 다른 쓰기의 잠금을 지우는 ABA 위험). 실제 기기의 원자성은 확인하지 못했다.
function acquireBindingLock() {
  let fm = null;
  let claimPath = null;
  let token = null;
  try {
    fm = FileManager.local();
    if (!fm || typeof fm.copy !== "function") return { status: "unavailable" };
    const dir = fm.libraryDirectory();
    const lockPath = fm.joinPath(dir, BINDING_LOCK_FILE);
    token = randomToken();
    const candidate = fm.joinPath(dir, `${BINDING_CLAIM_PREFIX}${token}.tmp`);
    if (fm.fileExists(candidate)) return { status: "unavailable" }; // 남의 파일을 덮어쓰지 않는다
    claimPath = candidate;
    fm.writeString(claimPath, token);
    try {
      fm.copy(claimPath, lockPath);
    } catch (e) {
      const busy = fm.fileExists(lockPath);
      removeIfOwned(fm, claimPath, token);
      return { status: busy ? "busy" : "unavailable" };
    }
    let back = null;
    try {
      back = fm.readString(lockPath);
    } catch (e) {
      back = null;
    }
    if (back !== token) {
      // 우리 것으로 확인되지 않은 잠금은 건드리지 않는다
      removeIfOwned(fm, claimPath, token);
      return { status: "busy" };
    }
    return { status: "held", fm, lockPath, claimPath, token };
  } catch (e) {
    if (fm && claimPath) removeIfOwned(fm, claimPath, token);
    return { status: "unavailable" };
  }
}

function removeIfOwned(fm, path, token) {
  try {
    if (fm.fileExists(path) && fm.readString(path) === token) fm.remove(path);
  } catch (e) {
    // 지우지 못해도 다른 실행의 파일은 건드리지 않는다
  }
}

function releaseBindingLock(lock) {
  if (!lock || lock.status !== "held") return;
  removeIfOwned(lock.fm, lock.lockPath, lock.token);
  removeIfOwned(lock.fm, lock.claimPath, lock.token);
}

// 첫 확인 회원번호를 저장한다. 잠금 안에서 기록을 다시 읽고 검사·병합한 뒤 Keychain.set 한 번, 다시 읽어 확인한다.
// 잠금 안에서는 await·네트워크를 쓰지 않는다. 묶음은 전부 저장하거나 하나도 저장하지 않는다.
// candidates: [{ index, loginId, memberId, pw }]
// 반환: { status: "saved"|"unchanged"|"busy"|"unavailable"|"invalid"|"conflict"|"failed", saved:Set, unchanged:Set, conflicts:Set }
function commitVerifiedBindings(candidates) {
  const out = { status: "failed", saved: new Set(), unchanged: new Set(), conflicts: new Set() };
  const lock = acquireBindingLock();
  if (lock.status !== "held") {
    out.status = lock.status;
    return out;
  }
  try {
    const current = readAccountsForCommit();
    if (!current) return out;
    const store = readVerifiedStore();
    if (store.status === "invalid") {
      out.status = "invalid";
      return out;
    }
    const records = new Map(store.records);
    const additions = [];
    for (const c of candidates) {
      // 계정이 그대로(같은 아이디 하나, 같은 비밀번호)일 때만 저장한다. 바뀌었으면 저장하지 않고 넘어간다.
      const same = current.filter(a => a.id === c.loginId);
      if (same.length !== 1 || same[0].pw !== c.pw) continue;
      const manual = memberIdState(same[0].memberId);
      if (manual.state === "valid" && manual.value === c.memberId) {
        out.unchanged.add(c.index);
        continue;
      }
      if (manual.state !== "absent") {
        out.conflicts.add(c.index); // 그 사이 다른 회원번호(또는 형식 오류 값)가 직접 입력됨 → 덮어쓰지 않음
        continue;
      }
      const existing = records.get(c.loginId);
      if (existing !== undefined) {
        if (existing === c.memberId) out.unchanged.add(c.index);
        else out.conflicts.add(c.index); // 다른 값이 이미 기록됨 → 절대 덮어쓰지 않음
        continue;
      }
      const usedElsewhere = [...records].some(([k, v]) => k !== c.loginId && v === c.memberId) ||
        current.some(a => a.id !== c.loginId && memberIdState(a.memberId).value === c.memberId) ||
        additions.some(x => x.memberId === c.memberId || x.loginId === c.loginId);
      if (usedElsewhere) {
        out.conflicts.add(c.index);
        continue;
      }
      additions.push(c);
    }
    if (out.conflicts.size > 0) {
      out.status = "conflict"; // 새 기록은 하나도 쓰지 않는다 (이미 같은 값으로 있던 기록은 그대로)
      return out;
    }
    if (additions.length === 0) {
      out.status = "unchanged";
      return out;
    }
    for (const c of additions) records.set(c.loginId, c.memberId);
    const next = serializeVerifiedStore(records);
    Keychain.set(VERIFIED_MEMBERS_KEY, next);
    let back = null;
    try {
      back = Keychain.get(VERIFIED_MEMBERS_KEY);
    } catch (e) {
      back = null;
    }
    if (back !== next) return out; // 저장을 확인하지 못함 → 성공으로 보지 않음
    for (const c of additions) out.saved.add(c.index);
    out.status = "saved";
    return out;
  } catch (e) {
    out.status = "failed";
    out.saved.clear();
    return out;
  } finally {
    releaseBindingLock(lock);
  }
}

const BINDING_NOT_SAVED_MESSAGE = "이번에 확인한 회원번호는 저장하지 못했습니다 (다음 조회 때 다시 확인합니다)";
const BINDING_CONFLICT_MESSAGE = "이전에 확인·등록된 회원번호와 이번 확인 결과가 달라 결과를 숨기고 저장하지 않았습니다";

// 충돌 검사가 끝난 결과에 첫 저장을 반영한다. 숨겨진(오류) 계정의 후보는 저장하지 않는다.
function applyVerifiedBindings(entries, results) {
  const candidates = [];
  entries.forEach((e, i) => {
    if (e.binding && results[i].status !== "error") candidates.push({ index: i, ...e.binding });
  });
  if (candidates.length === 0) return results;
  const outcome = commitVerifiedBindings(candidates);
  const pending = new Set(candidates.map(c => c.index));
  return results.map((r, i) => {
    if (!pending.has(i)) return r;
    if (outcome.conflicts.has(i)) return quarantined(r, BINDING_CONFLICT_MESSAGE);
    if (outcome.saved.has(i) || outcome.unchanged.has(i)) return r;
    return { ...r, warnings: (r.warnings || []).concat([BINDING_NOT_SAVED_MESSAGE]), displayWarnings: uiWarnings(r).concat([BINDING_NOT_SAVED_MESSAGE]) };
  });
}

// ------------------------------------------------------------
// 실행 겹침 방지 (권고용 잠금). 원자적이지 않으므로 정확성은 쿠키 고정 + 신원 확인에 의존한다.
// ------------------------------------------------------------
const LEASE_FILE = "songpa-loan-tracker.lease.json";

// 실행 표시(lease) 길이는 앱·위젯·진단 모두 LIMITS.leaseTtlMs(270초) 하나다. 위젯 60초 후보는 철회했다:
// 일시 정지된 위젯이 만료 뒤 재개되는 경우의 안전성을 실기기로 확인하지 못했다. 만료 전 표시는 지우거나 줄이지 않는다.
// kind는 진단용 표시 종류(app/widget)만 담는다. 계정·아이디·쿠키·시각 원문은 담지 않는다. kind가 없는 기존 표시는 "unknown".
const LEASE_KIND_LABELS = Object.freeze({ app: "앱", widget: "위젯", unknown: "알 수 없음" });
function leaseKindOf(cur) {
  const k = cur && typeof cur.kind === "string" ? cur.kind : "";
  return k === "app" || k === "widget" ? k : "unknown";
}

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
      // 남은 시간은 표시가 만료될 때까지의 최대 시간일 뿐, 다른 실행이 살아 있다는 증거가 아니다. 표시는 지우거나 덮어쓰지 않는다.
      if (live) return { status: "busy", remainingMs: cur.expiresAt - now, kind: leaseKindOf(cur) };
    }
    const owner = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    fm.writeString(path, JSON.stringify({ owner, expiresAt: now + LIMITS.leaseTtlMs, kind: config.runsInWidget ? "widget" : "app" }));
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

async function collectData(accounts, onProgress = null) {
  const lease = acquireLease();
  if (lease.status === "busy") {
    // 조회하지 않은 실행: 인증·조회 실패가 아니다. 남은 시간은 표시 만료까지의 최대 시간 (살아 있는 실행인지는 알 수 없음)
    const retryAfterSec = Math.max(1, Math.ceil((Number(lease.remainingMs) || 0) / 1000));
    // 읽기 전용 진단: 표시 종류(app/widget/unknown)와 정수 초만. 살아 있는 실행이라는 증거가 아니다.
    const leaseKind = leaseKindOf(lease);
    return accounts.map(a => ({
      ...errorResult(a, `다른 실행이 조회 중이라 이번에는 건너뛰었습니다. 잠시 후 다시 실행해주세요. (실행 표시 남은 시간 약 ${retryAfterSec}초 · 실행 표시 종류 ${LEASE_KIND_LABELS[leaseKind]} · 멈춘 실행이 남긴 표시일 수도 있습니다)`),
      skipped: "busy",
      retryAfterSec,
      leaseKind
    }));
  }
  try {
    const staged = await fetchAllAccounts(accounts, config.runsInWidget ? LIMITS.widgetBudgetMs : LIMITS.appBudgetMs, true, onProgress);
    // 조회하는 동안 다른 실행이 표시를 가져갔으면(관측 가능한 경우) 이번 결과를 쓰지 않는다
    if (!leaseStillHeld(lease)) {
      return accounts.map(a => errorResult(a, "조회 중 다른 실행이 실행 표시(잠금)를 가져가 이번 결과를 버렸습니다. 잠시 후 다시 실행해주세요."));
    }
    return applyVerifiedBindings(staged.entries, staged.results);
  } finally {
    releaseLease(lease);
  }
}

// 전체 상태 요약: 모두 실패 / 일부만 확인 / 모두 확인(0건 포함)
// 실행 표시 때문에 이번 실행이 아무 계정도 조회하지 않은 경우 (조회 실패·로그인 실패가 아님). 화면 문구 전용.
function busyRunInfo(data) {
  const list = Array.isArray(data) ? data : [];
  if (list.length === 0 || !list.every(d => d && d.status === "error" && d.skipped === "busy")) return null;
  return { accounts: list.length, sec: Math.max(1, ...list.map(d => (Number.isFinite(d.retryAfterSec) ? d.retryAfterSec : 1))) };
}

function summarizeResults(data) {
  const s = { total: data.length, ok: 0, partial: 0, error: 0, pending: 0, items: 0, displayItems: 0, shownPartial: 0, loans: 0, pickups: 0, transits: 0, displayLoans: 0, displayPickups: 0, displayTransits: 0 };
  for (const d of data) {
    if (d.status === "pending") {s.pending++;continue;}
    if (d.status === "ok") s.ok++;
    else if (d.status === "partial") s.partial++;
    else {
      s.error++;
      continue;
    }
    s.items += (d.items || []).length;
    s.displayItems += displayTitleGroups(d.items).length; // 화면 항목 수 (기록 수 items는 그대로)
    const dc = displayStatusCounts(d.items); // 화면 항목 대표 상태 (대출 > 픽업 > 이동). 원시 카운터는 아래 그대로
    s.displayLoans += dc.loan;
    s.displayPickups += dc.pickup;
    s.displayTransits += dc.transit;
    if (uiPartial(d)) s.shownPartial++;
    s.loans += d.loanCount || 0;
    s.pickups += d.pickupCount || 0;
    s.transits += d.transitCount || 0;
  }
  s.allFailed = s.total > 0 && s.error === s.total;
  s.hasProblem = s.error + s.partial > 0;
  s.hasShownProblem = s.error + s.shownPartial > 0; // 화면 표시용
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
  // 화면 항목: 계정마다 전체 제목이 같은 대출·상호대차 기록을 한 줄로 (기록은 모두 남긴다)
  const allItems = [];
  for (const d of data) {
    if (d.status !== "error" && d.items) allItems.push(...displayTitleGroups(d.items));
  }
  allItems.sort((a, b) => a.records[0].diffDays - b.records[0].diffDays);

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText("📚 송파도서관");
  title.font = Font.boldSystemFont(13);
  title.textColor = themed("#000000", "#FFFFFF");
  header.addSpacer();

  const allCollected = data.length>0 && data.every(d=>d.status!=="error"&&d.loanComplete&&d.dooComplete&&!d.coverageUncertain);
  let badgeStr = `총 ${s.displayItems}건`;
  let badgeColor = gray;
  const busyRun = busyRunInfo(data);
  if (busyRun) {
    badgeStr = "⏳ 조회 보류";
    badgeColor = orange;
  } else if (s.allFailed) {
    badgeStr = "⚠️ 조회 실패";
    badgeColor = red;
  } else if (s.hasShownProblem) {
    badgeStr = allCollected ? `목록 완료 · ${s.displayItems}건 (확인 필요)` : `⚠️ 일부만 확인 · ${s.displayItems}건`;
    badgeColor = orange;
  } else if (s.displayPickups > 0) {
    badgeStr = `🔔 픽업 ${s.displayPickups} · 대출 ${s.displayLoans}`;
    badgeColor = themed("#9A6700", "#FFD60A");
  } else if (s.displayTransits > 0) {
    badgeStr = `🚚 이동 ${s.displayTransits} · 대출 ${s.displayLoans}`;
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
  const failed = d => d.status !== "ok" && d.status !== "partial";
  const problems = busyRun ? [{ text: `⏳ 다른 실행이 조회 중 · 약 ${busyRun.sec}초 뒤 다시 실행 (${busyRun.accounts}개 계정 이번엔 조회 안 함)`, color: orange }] : data.filter(d => failed(d) || uiPartial(d) || uiWarnings(d).length > 0).map(d => ({
    text: failed(d)
      ? `⚠️ ${d.name}: ${d.error || "조회 실패"}`
      : uiPartial(d)
        ? `⚠️ ${d.name}: ${d.loanComplete&&d.dooComplete&&!d.coverageUncertain ? "목록 완료·항목 확인" : "일부만 확인"} - ${uiWarnings(d)[0] || "목록 일부를 불러오지 못함"}`
        : `ℹ️ ${d.name}: ${uiWarnings(d)[0]}`,
    color: failed(d) ? red : uiPartial(d) ? orange : gray
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
    const group = allItems[i];
    const view = displayGroupView(group); // 대출이 있는 묶음: 대출 대표, 지난 도착 상호대차는 태그 없이 (원래 기록은 그대로)
    const item = view.primary;
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

    const tagOf = r => r.statusType === "픽업필요" ? "[픽업필요]" : r.statusType === "이동중" ? "[이동중]"
      : r.diffDays < 0 ? `[연체 ${Math.abs(r.diffDays)}일]` : r.diffDays === 0 ? "[오늘 반납]" : `[D-${r.diffDays}]`;
    const extraTags = view.active.filter(r => r !== item).map(tagOf).join(""); // 대표를 뺀 나머지 진행 상태 (지난 도착 기록 제외)
    const badge = row.addText(`${tagText}${extraTags} `);
    badge.font = Font.boldSystemFont(11);
    badge.textColor = tagColor;

    const label = row.addText(`${item.user}: ${group.title} (${[...new Set(view.active.map(r => displayLoanLocation(r).shortLib))].join("/")})`);
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
// 화면 안내 출처: displayWarnings가 있으면 그것만 노란 안내로 쓴다 (필드가 없는 옛 결과 객체는 warnings 그대로).
function uiWarnings(d) {
  if (d && Array.isArray(d.displayWarnings)) return d.displayWarnings;
  return (d && d.warnings) || [];
}

// 표시 전용 대출 위치 (v1.2.7 return-location-1). 원래 lib·provLib·shortLib는 읽기만 한다.
// resolved: 수령도서관=반납처, 제공도서관=소장. unknown: 반납처 미확인 + 대출목록 도서관(원래 값). raw: 기존 표시 그대로.
function displayLoanLocation(b) {
  if (!b || b.statusType !== "대출중") return { status: "raw", shortLib: b ? b.shortLib : "", returnLib: b ? b.lib : "", ownerLib: b ? b.provLib : "" };
  if (b.displayLocation === "resolved") return { status: "resolved", shortLib: b.displayShortLib, returnLib: b.displayReturnLib, ownerLib: b.displayOwnerLib };
  if (b.displayLocation === "unknown") return { status: "unknown", shortLib: "미확인", rawLib: b.displayRawLib || "" };
  return { status: "raw", shortLib: b.shortLib, returnLib: b.lib, ownerLib: b.provLib };
}

// 카드 반납 도서관 요약: 대출 항목의 표시 위치로 새로 센다 (원래 libSummary는 그대로 둔다)
const UNKNOWN_RETURN_SUMMARY = "반납처 미확인";
function displayLibSummary(d) {
  if (!d || !Array.isArray(d.items)) return Object.entries((d && d.libSummary) || {});
  const out = new Map();
  for (const b of d.items) {
    if (!b || b.statusType !== "대출중") continue;
    const loc = displayLoanLocation(b);
    const key = loc.status === "unknown" ? UNKNOWN_RETURN_SUMMARY : loc.shortLib;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out];
}

// 화면에서 "확인 필요"로 보일 부분 결과: 목록 미완료, 실제 누락 가능성, 또는 화면에 보일 안내가 있을 때만.
// 원래 status("partial")는 바꾸지 않는다.
function uiPartial(d) {
  return Boolean(d) && d.status === "partial" &&
    (!d.loanComplete || !d.dooComplete || Boolean(d.coverageUncertain) || uiWarnings(d).length > 0);
}

// 식별번호 없음·같은 제목 연결 미확정에서만 생기는 항목 메모는 화면에 띄우지 않는다 (기록의 qualityNotes에는 남음)
const QUIET_QUALITY_NOTES = ["중복 여부 미확정", "대출·상호대차 연결 미확정"];
function visibleQualityNotes(b) {
  return ((b && b.qualityNotes) || []).filter(n => !QUIET_QUALITY_NOTES.includes(n));
}

// 표시 전용: 한 계정의 items 안에서 전체 제목(displayTitleKey: NFC·공백 정리만)이 같은 대출과 진행 중 상호대차 기록을
// 한 화면 항목으로 묶는다. 소장처·displayGroup은 보지 않고, 등록번호는 아래의 다른 복본 분리에만 쓴다. 같은 종류끼리만 같은 제목이면 따로 둔다.
// 빈 제목은 묶지 않는다. 모든 기록을 원래 순서대로 한 번씩 담는다. 같은 실물 책이라는 판단이 아니다.
function displayTitleGroups(items) {
  const list = Array.isArray(items) ? items : [];
  const kindOf = b => (b && b.statusType === "대출중" ? "loan" : "ill");
  const byTitle = new Map();
  list.forEach((b, i) => {
    const k = displayTitleKey(b && b.title);
    if (!k) return;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(i);
  });
  // 양쪽 모두 명시된 등록번호 근거(COPY_ID_SPEC 필드·data-reg-no·"등록번호" 라벨 → displayCopyExplicit)와 자리 표시 문구가 아닌
  // 실제 도서관 범위가 있고, 같은 도서관에서 모든 대출과 다르면 다른 실물 책으로 보아 그 상호대차는 묶지 않는다 (픽업 안내 유지).
  // 옛 형식(체크박스·반납연기 링크)에서만 나온 등록번호는 이 분리에 쓰지 않는다 (이름공간 미확인. 틀렸다고 확인된 것은 아님).
  // 범위가 다르거나, 한쪽이라도 명시 근거가 없거나 모호하면 비교할 수 없으므로 기존처럼 전체 제목으로 묶는다.
  const copyOf = b => {
    if (!b || b.displayCopyExplicit !== true) return null;
    const c = typeof b.displayCopyScope === "string" ? b.displayCopyScope : "";
    const k = c.lastIndexOf("#"); // 등록번호에는 #이 없다 (COPY_ID_SPEC)
    if (!(k > 0 && k < c.length - 1)) return null;
    const lib = c.slice(0, k);
    return isPlaceholderLib(lib) ? null : { lib, id: c.slice(k + 1) };
  };
  const mixed = new Set();
  for (const idxs of byTitle.values()) {
    const loanCopies = idxs.filter(i => kindOf(list[i]) === "loan").map(i => copyOf(list[i]));
    const apart = i => {
      const c = kindOf(list[i]) === "loan" ? null : copyOf(list[i]);
      return Boolean(c) && loanCopies.length > 0 && loanCopies.every(l => l && l.lib === c.lib && l.id !== c.id);
    };
    const members = idxs.filter(i => !apart(i));
    if (new Set(members.map(i => kindOf(list[i]))).size > 1) members.forEach(i => mixed.add(i));
  }
  const groups = [];
  const placed = new Set();
  list.forEach((b, i) => {
    if (placed.has(i)) return;
    if (!mixed.has(i)) {
      placed.add(i);
      groups.push({ title: b ? b.title : "", records: [b] });
      return;
    }
    const records = byTitle.get(displayTitleKey(b.title)).filter(j => mixed.has(j) && !placed.has(j)).map(j => {
      placed.add(j);
      return list[j];
    });
    groups.push({ title: b.title, records });
  });
  return groups;
}

// 표시 전용 대표 상태 (v1.2.6 title-display-2): 한 화면 항목(같은 계정·같은 전체 제목 묶음) 안에서
// 대출 > 픽업필요 > 이동중 순으로 대표 기록 하나를 고른다. 대출이 여럿이면 반납일이 가장 가까운 기록.
// 원래 기록·상태·반납일·원시 카운터(loanCount 등)·경고는 바꾸지 않는다. 같은 실물 책이라는 판단이 아니다.
const DISPLAY_STATUS_PRIORITY = ["대출중", "픽업필요", "이동중"];
function primaryDisplayRecord(group) {
  const recs = group && Array.isArray(group.records) ? group.records.filter(Boolean) : [];
  for (const st of DISPLAY_STATUS_PRIORITY) {
    const same = recs.filter(r => r.statusType === st);
    if (same.length === 0) continue;
    if (st !== "대출중") return same[0];
    return same.reduce((best, r) => (Number.isFinite(r.diffDays) && (!Number.isFinite(best.diffDays) || r.diffDays < best.diffDays)) ? r : best);
  }
  return recs[0];
}

// 한 계정 items의 화면 항목별 대표 상태 수. 상태가 알려진 항목이면 합이 화면 항목 수와 같다.
function displayStatusCounts(items) {
  const c = { loan: 0, pickup: 0, transit: 0 };
  for (const g of displayTitleGroups(items)) {
    const p = primaryDisplayRecord(g);
    const t = p && p.statusType;
    if (t === "대출중") c.loan++;
    else if (t === "픽업필요") c.pickup++;
    else if (t === "이동중") c.transit++;
  }
  return c;
}

// 표시 전용 (v1.2.6 title-display-3): 묶음에 대출이 있으면 대출을 먼저 보인다 (대표 대출 먼저, 나머지 대출은 원래 순서).
// 이동중 등 다른 진행 기록은 그다음에 그대로 둔다. 도착(픽업필요) 상호대차 기록은 행동 안내 없이 접힌 '이전 기록'으로만 보인다.
// 대출이 없는 묶음(단독 픽업 등)은 바꾸지 않는다. 다른 계정은 묶이지 않으므로 영향이 없다.
// 새 배열만 만든다: 원래 기록·상태·반납일·원시 카운터·경고는 바꾸지 않는다. 같은 실물 책이라는 판단이 아니다.
function displayGroupView(group) {
  const recs = group && Array.isArray(group.records) ? group.records.filter(Boolean) : [];
  const primary = primaryDisplayRecord(group);
  const hasLoan = recs.some(r => r.statusType === "대출중");
  if (!hasLoan) return { primary, hasLoan, active: recs.slice(), history: [] };
  const loans = recs.filter(r => r.statusType === "대출중");
  const others = recs.filter(r => r.statusType !== "대출중");
  return {
    primary,
    hasLoan,
    active: [primary, ...loans.filter(r => r !== primary), ...others.filter(r => r.statusType !== "픽업필요")],
    history: others.filter(r => r.statusType === "픽업필요")
  };
}

// 대출 묶음 안 지난 도착 상호대차 기록의 중립 표시 (행동 문구·강조 색 없음). 도착·소장 도서관 기록은 그대로 보인다.
function historyRecordView(b) {
  const notesHtml = visibleQualityNotes(b).map(note => `<div class="rec-history-note">${escapeHtml(note)}</div>`).join("");
  return `<div class="rec-block rec-history"><div class="rec-head"><span class="badge-status badge-history">도착 기록 (현재 대출 중)</span> <span class="rec-lib">${escapeHtml(b.shortLib)}</span></div><div class="loc-detail">도착도서관: ${escapeHtml(b.lib)} <span class="prov-text">(소장: ${escapeHtml(b.provLib)})</span></div>${notesHtml}</div>`;
}

// 기록 하나의 화면 조각 (도서관·위치·상태·메모). 묶음 블록용 inlineStatus는 상태·반납일을 한 줄로 쓴다.
function recordView(b) {
  const notesHtml = visibleQualityNotes(b).map(note => `<div style="font-size:11px;color:var(--orange)">⚠ ${escapeHtml(note)}</div>`).join("");
  if (b.statusType === "픽업필요") {
    const statusHtml = `<span class="badge-status badge-pickup">픽업필요</span>`;
    return {
      libDisplay: `<div class="lib-main pickup-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령처</div>`,
      subLocText: `<div class="loc-detail"><span class="tag-pickup">픽업필요</span> 📍도착도서관: <strong>${escapeHtml(b.lib)}</strong> <span class="prov-text">(소장: ${escapeHtml(b.provLib)})</span></div>`,
      statusHtml, inlineStatus: statusHtml, notesHtml
    };
  }
  if (b.statusType === "이동중") {
    const statusHtml = `<span class="badge-status badge-transit">이동중</span>`;
    return {
      libDisplay: `<div class="lib-main transit-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령예정</div>`,
      subLocText: `<div class="loc-detail"><span class="tag-transit">이동중</span> 📍배송 경로: ${escapeHtml(b.provLib)} ➔ <strong>${escapeHtml(b.lib)}</strong></div>`,
      statusHtml, inlineStatus: statusHtml, notesHtml
    };
  }
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
  let libDisplay;
  let subLocText;
  const loc = displayLoanLocation(b);
  if (loc.status === "unknown") {
    libDisplay = `<div class="lib-main">${escapeHtml(loc.shortLib)}</div><div class="lib-sub">반납처</div>`;
    subLocText = `<div class="loc-detail"><span class="tag-booksole">책솔이</span> 📍반납처 미확인${loc.rawLib ? ` <span class="prov-text">(대출목록 도서관: ${escapeHtml(loc.rawLib)})</span>` : ""}</div>`;
  } else if (loc.status === "resolved") {
    libDisplay = `<div class="lib-main inter-highlight">${escapeHtml(loc.shortLib)}</div><div class="lib-sub">수령/반납</div>`;
    subLocText = `<div class="loc-detail"><span class="tag-booksole">책솔이</span> 📍반납처: <strong>${escapeHtml(loc.returnLib)}</strong> <span class="prov-text">(소장: ${escapeHtml(loc.ownerLib)})</span></div>`;
  } else if (b.isInter) {
    libDisplay = `<div class="lib-main inter-highlight">${escapeHtml(b.shortLib)}</div><div class="lib-sub">수령/반납</div>`;
    subLocText = `<div class="loc-detail"><span class="tag-booksole">책솔이</span> 📍반납처: <strong>${escapeHtml(b.lib)}</strong> <span class="prov-text">(소장: ${escapeHtml(b.provLib)})</span></div>`;
  } else {
    libDisplay = `<div class="lib-main">${escapeHtml(b.shortLib)}</div><div class="lib-sub">대출도서관</div>`;
    subLocText = `<div class="loc-detail">📍반납처: ${escapeHtml(b.lib)}</div>`;
  }
  return {
    libDisplay,
    subLocText,
    statusHtml: `${escapeHtml(b.shortDate)}<br><span class="badge-dday ${dueClass}">${escapeHtml(badge)}</span>`,
    inlineStatus: `<span class="badge-status badge-loan">대출중</span> 반납 ${escapeHtml(b.dueDate)} <span class="badge-dday ${dueClass}">${escapeHtml(badge)}</span>`,
    notesHtml
  };
}

function buildHtmlPage(data) {
  const s = summarizeResults(data);
  const countsText = `대출 ${s.displayLoans}건${s.displayPickups > 0 ? ` · 🔔 픽업 ${s.displayPickups}건` : ""}${s.displayTransits > 0 ? ` · 🚚 이동 ${s.displayTransits}건` : ""}`; // 화면 항목 대표 상태 기준
  const allCollected = data.length>0 && data.every(d=>d.status!=="error"&&d.loanComplete&&d.dooComplete&&!d.coverageUncertain);
  let subtitleHtml;
  const recordNote = s.displayItems !== s.items ? ` · 기록 ${s.items}건` : ""; // 화면 항목 수와 기록 수가 다를 때만
  if (s.pending>0) {
    subtitleHtml = `조회 중 · ${data.length-s.pending}/${data.length}계정 완료 · 목록 ${s.displayItems}건${recordNote}`;
  } else if (busyRunInfo(data)) {
    const busy = busyRunInfo(data);
    subtitleHtml = `<span class="subtitle-alert">⏳ 다른 실행이 조회 중이거나 그 실행 표시가 남아 있어 ${busy.accounts}개 계정 모두 이번에는 조회하지 않았습니다 · 약 ${busy.sec}초 뒤 다시 실행해주세요 (이번에는 도서 수를 확인하지 않음)</span>`;
  } else if (s.allFailed) {
    subtitleHtml = `<span class="subtitle-alert">⚠️ ${data.length}개 계정 모두 조회 실패 · 도서 수를 알 수 없습니다</span>`;
  } else if (allCollected && s.hasShownProblem) {
    subtitleHtml = `${data.length}개 계정 목록 조회 완료 · 목록 ${s.displayItems}건${recordNote} (${countsText}) · 확인 필요 항목 포함`;
  } else if (s.hasShownProblem) {
    subtitleHtml = `<span class="subtitle-alert">⚠️ 일부 계정·목록만 확인됨</span> · 확인된 목록 ${s.displayItems}건${recordNote} (${countsText})`;
  } else if (s.items === 0) {
    subtitleHtml = `${data.length}개 계정 · 현재 이용 중인 도서 없음 (조회 완료)`;
  } else {
    subtitleHtml = `${data.length}개 계정${allCollected ? " 목록 조회 완료" : ""} · 목록 ${s.displayItems}건${recordNote} 이용 (${countsText})`;
  }

  const tabsHtml = data.map((d, idx) => {
    const label = escapeHtml(d.name);
    const isError = d.status === "error";
    const items = isError ? [] : (d.items || []);
    const groups = displayTitleGroups(items); // 화면 항목 수 (기록은 items 그대로)
    const count = d.status==="pending" ? "조회 중" : isError ? "!" : `${groups.length}${d.status === "partial" && (!d.loanComplete||!d.dooComplete||d.coverageUncertain) ? "+" : ""}`;
    const interCount = groups.filter(g => g.records.some(b => b.isInter)).length;
    return `<a href="#card-${idx}" class="tab-pill">${label} <span class="tab-count">${count}</span>${isError ? "" : `<span class="tab-inter">(${interCount})</span>`}</a>`;
  }).join("");

  const cardsHtml = data.map((d, idx) => {
    const isError = d.status === "error";
    const isPending = d.status === "pending";
    const isPartial = uiPartial(d); // 화면 표시용 (원래 status는 그대로)
    const collected = !isError && d.loanComplete && d.dooComplete && !d.coverageUncertain;
    const items = isError ? [] : (d.items || []);
    const groups = displayTitleGroups(items); // 화면 항목 (기록은 items 그대로)
    const dc = displayStatusCounts(items); // 카드 통계: 화면 항목 대표 상태 기준 (원시 loanCount 등은 그대로)

    // 반납/수령할 도서관 기준 요약 라인
    const summaryEntries = displayLibSummary(d); // 표시 위치 기준 (원래 libSummary는 그대로)
    const summaryHtml = summaryEntries.length > 0
      ? summaryEntries.map(([lib, cnt]) => `<span>📍<strong>${escapeHtml(lib)}</strong>: ${Number(cnt)}권</span>`).join("&nbsp;&nbsp;·&nbsp;&nbsp;")
      : (isPartial && !collected ? "확인된 대출 도서관 없음 (일부 목록 미확인)" : "대출 중인 도서관 없음");

    const errHtml = isError ? (d.skipped === "busy" ? `<div class="err-box">⏳ 이번에는 조회하지 않음: ${escapeHtml(d.error || "")}</div>` : `<div class="err-box">⚠️ 조회 오류: ${escapeHtml(d.error || "알 수 없는 오류")}</div>`) : "";
    const warnings = isError ? [] : uiWarnings(d);
    const warnHtml = warnings.length > 0
      ? `<div class="warn-box">${isPartial ? (collected ? "<div><strong>목록 조회 완료 · 아래 항목은 확인 필요</strong></div>" : "<div><strong>일부만 확인된 결과입니다.</strong></div>") : ""}${warnings.map(w => `<div>⚠️ ${escapeHtml(w)}</div>`).join("")}</div>`
      : "";

    let rowsHtml = "";
    if (items.length === 0) {
      const emptyText = isPending ? "본인확인과 조회가 완료되면 이 계정의 결과를 표시합니다." : isError
        ? "도서 정보를 불러오지 못했습니다."
        : isPartial ? (collected ? "목록 조회 완료 · 표시하지 못한 상태 등 항목 확인이 필요합니다." : "확인된 도서가 없습니다 (목록 일부를 불러오지 못했거나 확인이 필요한 기록이 있어 0권이 아닐 수 있음).") : "현재 이용 중인 도서가 없습니다.";
      rowsHtml = `<tr><td colspan="4" class="empty-cell">${emptyText}</td></tr>`;
    } else {
      rowsHtml = groups.map((g, bIdx) => {
        if (g.records.length === 1) {
          const b = g.records[0];
          const v = recordView(b);
          return `
          <tr>
            <td class="col-num">${bIdx + 1}</td>
            <td class="col-lib">${v.libDisplay}</td>
            <td class="col-title">
              <div class="title-text">${escapeHtml(b.title)}</div>
              ${v.subLocText}
              ${v.notesHtml}
            </td>
            <td class="col-due">
              ${v.statusHtml}
            </td>
          </tr>
        `;
        }
        // 같은 계정·같은 전체 제목: 제목은 한 번, 원래 기록마다 상태·반납일·도서관을 따로 적는다 (실물 동일성·권수 주장 없음)
        const view = displayGroupView(g); // 대출 먼저, 지난 도착 상호대차는 접힌 중립 기록으로 (원래 기록은 그대로)
        const blocks = view.active.map(b => {
          const v = recordView(b);
          return `<div class="rec-block"><div class="rec-head">${v.inlineStatus} <span class="rec-lib">${escapeHtml(displayLoanLocation(b).shortLib)}</span></div>${v.subLocText}${v.notesHtml}</div>`;
        }).join("");
        const historyHtml = view.history.length === 0 ? ""
          : `<details class="rec-history-box"><summary>이전 상호대차 기록 ${view.history.length}건</summary>${view.history.map(historyRecordView).join("")}</details>`;
        return `
          <tr class="title-group" data-record-count="${g.records.length}">
            <td class="col-num">${bIdx + 1}</td>
            <td class="col-title" colspan="3">
              <div class="title-text">${escapeHtml(g.title)}</div>
              <div class="rec-note">같은 제목 · 상태 기록 ${g.records.length}건</div>
              ${blocks}${historyHtml}
            </td>
          </tr>
        `;
      }).join("");
    }

    const statsHtml = isPending ? `<span>${d.pendingActive ? "현재 계정 조회 중" : "순차 조회 중"}</span>` : isError
      ? (d.skipped === "busy" ? `<span style="color:var(--orange);">이번에는 조회하지 않음 · 도서 정보 없음</span>` : `<span style="color:var(--red);">조회 실패 · 도서 정보 없음</span>`)
      : `<span>대출 ${dc.loan}권${d.loanComplete === false ? " (일부 미확인)" : ""}</span>
            ${dc.pickup > 0 ? `<span style="color:var(--yellow); font-weight:800;">· 🔔 픽업필요 ${dc.pickup}권</span>` : ""}
            ${dc.transit > 0 ? `<span style="color:var(--sky);">· 🚚 이동중 ${dc.transit}권</span>` : ""}
            ${d.dooComplete === false ? `<span style="color:var(--orange);">· 상호대차 일부 미확인</span>` : ""}`;

    return `
      <div class="card" id="card-${idx}">
        <div class="card-header">
          <div class="user-row">
            <span class="user-name">👤 ${escapeHtml(d.name)}</span>
            <span class="badge-total">${isPending ? "조회 중" : isError ? (d.skipped === "busy" ? "조회 보류" : "조회 실패") : `${groups.length}건${isPartial && !collected ? "+" : ""}${groups.length !== items.length ? ` · 기록 ${items.length}건` : ""}`}</span>
          </div>
          <div class="stats-row">
            ${statsHtml}
          </div>
        </div>

        ${errHtml}
        ${warnHtml}


        ${isError || isPending ? "" : `<div class="lib-summary">
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
  .rec-block { border-left: 3px solid var(--tint-blue-border); padding: 4px 0 4px 8px; margin-top: 6px; }
  .rec-head { font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .rec-lib { font-weight: 700; color: var(--text-primary); }
  .rec-note { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
  .badge-loan { background: var(--tint-green); color: var(--green); border: 1px solid var(--line); margin-bottom: 2px; }
  .rec-history-box { margin-top: 6px; font-size: 11px; color: var(--text-secondary); }
  .rec-history-box > summary { cursor: pointer; color: var(--text-secondary); }
  .rec-history { border-left-color: var(--line); }
  .rec-history .loc-detail { color: var(--text-faint); }
  .rec-history-note { font-size: 11px; color: var(--text-faint); }
  .badge-history { background: var(--badge-bg); color: var(--text-secondary); border: 1px solid var(--line); font-weight: 600; }
  .empty-cell {
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
    padding: 20px 0 !important;
  }
</style>
</head>
<body>
  <div class="app-header" data-pending="${s.pending}">
    <div class="app-title">📚 송파도서관 대출 현황</div>
    <div class="app-subtitle">${subtitleHtml}</div>
    <div style="font-size:10px;color:var(--text-faint)">v${SCRIPT_VERSION}</div>
  </div>

  <div class="tabs-container">
    ${tabsHtml}
  </div>

  <div class="cards-deck">
    ${cardsHtml}
  </div>
<script>window.__songpaFinal=${s.pending===0};</script>
</body>
</html>
  `;
}

// ==========================================
// 3. 본인 확인 진단 (별도 생성본 songpa-identity-check.js의 진입점. 이 메인 스크립트는 호출하지 않는다)
// ==========================================
// 사용자가 고른 계정 하나로 일반 로그인 1회 → 회원정보 확인 화면 → 메인 화면 → 회원정보 확인 화면 재확인만 한다.
// 대출·상호대차 목록, 업데이트 확인, 회원번호 기록 저장, 계정 목록 수정은 하지 않는다.
// 보고에는 결과 코드와 참/거짓만 넣는다 (아이디·회원번호·비밀번호·쿠키·화면 원문 없음).
const IDENTITY_REPORT_KEYS = [
  "loginOk", "profileResponseOk", "principalMatches", "memberUnique", "storedMemberMatches",
  "homeMatches", "finalProofMatches", "sessionStable", "listsRequested", "bindingWritten", "accountsWritten"
];

function identityReport(result, fields = {}) {
  const r = {
    result,
    loginOk: false,
    profileResponseOk: false,
    principalMatches: false,
    memberUnique: false,
    storedMemberMatches: null, // null = 직접 입력·확인 기록이 없어 비교하지 않음
    homeMatches: false,
    finalProofMatches: false,
    sessionStable: false,
    listsRequested: false,
    bindingWritten: false,
    accountsWritten: false
  };
  for (const k of IDENTITY_REPORT_KEYS) if (hasOwn(fields, k)) r[k] = fields[k];
  return r;
}

function diagnosticCode(e) {
  const code = e && e.code;
  const map = {
    PROFILE_NETWORK: "FAIL_NETWORK",
    PROFILE_RESPONSE: "FAIL_PROFILE_RESPONSE",
    SESSION_CHANGED: "FAIL_SESSION_CHANGED",
    PRINCIPAL_MISSING: "FAIL_PRINCIPAL_MISSING",
    PRINCIPAL_AMBIGUOUS: "FAIL_PRINCIPAL_AMBIGUOUS",
    PRINCIPAL_MISMATCH: "FAIL_PRINCIPAL_MISMATCH",
    MEMBER_MISSING: "FAIL_MEMBER",
    MEMBER_AMBIGUOUS: "FAIL_MEMBER",
    NAME_MISMATCH: "FAIL_NAME_MISMATCH",
    PROFILE_PARSE: "FAIL_PROFILE_PARSE"
  };
  return map[code] || "FAIL_PROFILE_PARSE";
}

// 계정 하나의 진단. 운영 코드와 같은 함수(login, proveProfilePrincipal, checkIndexIdentity)를 쓴다. 저장하지 않는다.
async function runIdentityDiagnostic(account) {
  const snap = snapshotAccount(account);
  const f = {};
  if (!snap.ok) return identityReport("FAIL_SETUP", f);
  const expected = expectedMemberFor(snap, readVerifiedStore()); // 읽기만 한다
  if (expected.error) return identityReport("FAIL_SETUP", f);
  const lease = acquireLease();
  if (lease.status === "busy") return identityReport("BUSY", f);
  try {
    const ctx = { deadline: clock.now() + LIMITS.appBudgetMs };
    const observed = new Set();
    let session;
    try {
      session = await login(snap, ctx);
      f.loginOk = true;
    } catch (e) {
      return identityReport(e && e.kind === "network" ? "FAIL_NETWORK" : "FAIL_LOGIN", f);
    }
    let member;
    try {
      member = await proveProfilePrincipal(session, snap, observed, "진단", ctx);
      Object.assign(f, { profileResponseOk: true, principalMatches: true, memberUnique: true });
    } catch (e) {
      const code = diagnosticCode(e);
      if (["FAIL_PRINCIPAL_MISSING", "FAIL_PRINCIPAL_AMBIGUOUS", "FAIL_PRINCIPAL_MISMATCH", "FAIL_MEMBER", "FAIL_NAME_MISMATCH"].includes(code)) f.profileResponseOk = true;
      if (code === "FAIL_MEMBER" || code === "FAIL_NAME_MISMATCH") f.principalMatches = true;
      if (code === "FAIL_NAME_MISMATCH") f.memberUnique = true;
      return identityReport(code, f);
    }
    if (expected.memberId) {
      f.storedMemberMatches = member === expected.memberId;
      if (!f.storedMemberMatches) return identityReport("FAIL_STORED_MEMBER", f);
    }
    const effective = Object.freeze({ label: snap.label, id: snap.id, siteName: snap.siteName, memberId: member });
    try {
      await checkIndexIdentity(session, effective, observed, "진단", ctx);
      f.homeMatches = true;
    } catch (e) {
      return identityReport("FAIL_HOME", f);
    }
    try {
      const again = await proveProfilePrincipal(session, snap, observed, "진단", ctx);
      f.finalProofMatches = again === member;
    } catch (e) {
      return identityReport("FAIL_FINAL", f);
    }
    if (!f.finalProofMatches || observed.size !== 1) return identityReport("FAIL_FINAL", f);
    f.sessionStable = true; // 모든 응답에서 고정한 JSESSIONID가 바뀌거나 지워지지 않았다
    return identityReport("PASS", f);
  } finally {
    releaseLease(lease);
  }
}

// 계정 하나를 고르고, 일반 로그인 1회 시작에 동의를 받는다. 취소하면 네트워크 요청 없이 끝난다.
async function runIdentityCheck() {
  const accounts = getAccounts();
  if (accounts.length === 0) return identityReport("NO_ACCOUNTS");
  const pick = new Alert();
  pick.title = "🔎 본인 확인 진단";
  pick.message = "확인할 계정 하나를 고르세요.\n대출 목록 조회·업데이트·회원번호 저장·계정 수정은 하지 않습니다.";
  accounts.forEach((a, i) => pick.addAction(`${i + 1}. ${accountLabel(a)}`));
  pick.addCancelAction("취소");
  const idx = await pick.presentAlert();
  if (typeof idx !== "number" || idx < 0 || idx >= accounts.length) return identityReport("CANCELLED");

  const confirm = new Alert();
  confirm.title = "일반 로그인 1회";
  confirm.message = "고른 계정으로 도서관 홈페이지에 일반 로그인을 한 번 하고, 회원정보 확인 화면과 메인 화면만 읽습니다.\n" +
    "비밀번호 확인 칸은 제출하지 않습니다. 결과에는 성공·실패 표시만 나오고 아이디·회원번호·비밀번호·쿠키는 나오지 않습니다.";
  confirm.addAction("로그인 1회 시작");
  confirm.addCancelAction("취소");
  if (await confirm.presentAlert() !== 0) return identityReport("CANCELLED");
  return runIdentityDiagnostic(accounts[idx]);
}

function formatIdentityReport(report) {
  const lines = [`result: ${report.result}`];
  for (const k of IDENTITY_REPORT_KEYS) lines.push(`${k}: ${report[k] === null ? "null" : report[k] ? "true" : "false"}`);
  return lines.join("\n");
}

async function identityCheckMain() {
  const report = await runIdentityCheck();
  const a = new Alert();
  a.title = report.result === "PASS" ? "✅ 본인 확인 진단 통과" : "본인 확인 진단 결과";
  a.message = `${formatIdentityReport(report)}\n\n이 표시(코드와 true/false)만 알려 주세요. 다른 값은 보내지 마세요.`;
  a.addAction("확인");
  await a.presentAlert();
  return report;
}

function progressResults(accounts, snapshot) {
  return accounts.map((account,index)=>index<snapshot.results.length ? snapshot.results[index] : {
    ...errorResult(account,""),status:"pending",pendingActive:index===snapshot.activeIndex
  });
}

function nativeRenderStage(code) {
  if (!NATIVE_TRACE) return;
  try {
    const fm=FileManager.local();
    const path=fm.joinPath(fm.libraryDirectory(),"songpa-render-stage-safe.json");
    fm.writeString(path,JSON.stringify({build:NATIVE_PROBE_BUILD,stage:code,atMs:clock.now()}));
  } catch (_) {}
}

async function updateProgressView(view, data, finished = false) {
  const html=buildHtmlPage(data);
  const body=html.slice(html.indexOf("<body>")+6,html.lastIndexOf("</body>"));
  let timer;
  try {
    const result=await Promise.race([
      view.evaluateJavaScript(`(()=>{if(window.__songpaFinal&&!${JSON.stringify(finished)})return false;const y=window.scrollY;document.body.innerHTML=${JSON.stringify(body)};if(${JSON.stringify(finished)})window.__songpaFinal=true;document.body.setAttribute("data-finished",${JSON.stringify(String(finished))});window.scrollTo(0,y);return true;})()`,false),
      new Promise(resolve=>{timer=Timer.schedule(2500,false,()=>resolve(false));})
    ]);
    return result===true;
  } catch (_) {return false;}
  finally {if(timer) timer.invalidate();}
}

async function runMain() {
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

  // single-render-1: 앱 실행은 조회와 실행 표시 해제(collectData의 finally)가 모두 끝난 뒤에만 화면을 만든다.
  // 조회 중에는 WebView를 만들거나 불러오거나 띄우지 않고, 진행 상황 콜백을 넘기지 않으며, DOM을 중간에 바꾸지 않는다.
  // progressResults·updateProgressView는 보조 함수로 남아 있지만 이 실행 흐름에서는 호출하지 않는다.
  // 실기기에서 흰 화면이 사라지는지는 이 변경으로 확인된 것이 아니다.
  nativeRenderStage("COLLECT_START");
  const data=await collectData(accounts);
  nativeRenderStage("COLLECT_DONE");
  if (NATIVE_TRACE) try {
    const fm=FileManager.local();
    fm.writeString(fm.joinPath(fm.libraryDirectory(),"songpa-native-safe-trace.json"),JSON.stringify({build:NATIVE_PROBE_BUILD,progress:[],accounts:data.map((d,index)=>({index:index+1,status:d.status,loanComplete:d.loanComplete,dooComplete:d.dooComplete,trace:d.nativeTrace||"",identifierEvidence:d.identifierEvidence||{}}))}));
  } catch (_) {}
  if (config.runsInWidget) {
    const widget=await createWidget(data,updateInfo);
    widget.url=URLScheme.forRunningScript();Script.setWidget(widget);
  } else {
    // 최종 HTML 하나를 WebView 하나에 한 번만 불러와 한 번만 띄운다 (실행 표시는 이미 해제됨).
    const html=buildHtmlPage(data);
    const wv=new WebView();
    await wv.loadHTML(html);
    nativeRenderStage("FINAL_RENDER_DONE");
    await wv.present(true);
  }
}

async function main() {
  try {await runMain();}
  catch (e) {
    nativeRenderStage("MAIN_ERROR");
    if (!config.runsInWidget) {
      const alert=new Alert();alert.title="화면 표시 또는 조회 오류";
      alert.message="대출 현황을 표시하지 못했습니다. 진단 코드: MAIN_ERROR";
      alert.addAction("확인");await alert.presentAlert();
    }
    throw e;
  }
}

// 진단 전용 진입점 (scripts/build-scriptable-identity-check.mjs 생성본). 목록 조회·업데이트·저장 없음.
await identityCheckMain();
Script.complete();
