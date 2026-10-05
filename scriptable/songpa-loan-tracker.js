// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: magic;
// 송파구립도서관 대출 현황 - iOS Scriptable 위젯 + 전체 카드 화면
// https://github.com/pchuri/songpa-loan-tracker (MIT License)
// 계정은 songpa-accounts.js로 iOS 키체인에 저장한다. 이 파일에는 계정 정보를 넣지 않는다.

const SCRIPT_VERSION = "1.1.0";
const UPDATE_URL = "https://raw.githubusercontent.com/pchuri/songpa-loan-tracker/main/scriptable/songpa-loan-tracker.js";
const KEYCHAIN_KEY = "SPLIB_ACCOUNTS";

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
      alert.message = `송파도서관 대출현황 새 버전(v${remoteVer})이 있습니다.\n(현재: v${SCRIPT_VERSION})\n\n지금 업데이트하시겠습니까?`;
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
        done.message = `v${remoteVer} 버전으로 업데이트되었습니다.\n스크립트를 다시 실행해주세요.`;
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

// 한글 세 글자 이름이면 성을 빼고 부른다 (예: 홍길동 → 길동). 그 외에는 첫 단어.
function shortName(name) {
  const first = (name || "").split(" ")[0];
  return /^[가-힣]{3}$/.test(first) ? first.slice(1) : first;
}

// 서로 다른 계정인데 같은 회원 이름이 나오면 세션이 섞인 것이므로 오류로 표시한다
function markSessionMixup(result, account, seenSiteNames) {
  if (!result.siteName) return result;
  const prev = seenSiteNames.get(result.siteName);
  if (prev && prev.id !== account.id) {
    return {
      ...result,
      error: `다른 계정(${prev.label})과 같은 회원(${result.siteName})의 정보가 조회됨`,
      items: [],
      libSummary: {},
      loanCount: 0,
      pickupCount: 0,
      transitCount: 0
    };
  }
  seenSiteNames.set(result.siteName, account);
  return result;
}

function getAccounts() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    try {
      const parsed = JSON.parse(Keychain.get(KEYCHAIN_KEY));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.warn("Keychain 파싱 오류: " + e.message);
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
const PAGE_SIZE = 10;

// 진행 중인 상호대차 상태 (완료·복귀중·신청취소는 지난 이력)
const ACTIVE_DOO_STATUSES = ["입수", "발송", "요청중", "신청중"];

// 로그인 실패도 HTTP 200에 쿠키까지 내려주므로 응답 문구로 실패를 가려낸다 (데스크탑 앱과 동일)
const LOGIN_FAILURE_PATTERNS = [
  "로그인 정보가 올바르지 않거나",
  "비밀번호가 일치하지 않습니다",
  "회원번호가 일치하지 않습니다",
  "존재하지 않는 회원",
  "로그인에 실패",
  "회원정보가 없습니다"
];

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
    .replace(/"/g, "&quot;");
}

function splitRows(html) {
  return (html || "").split('<div class="myArticle-list">').slice(1);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 메인 페이지 바코드 영역의 회원 이름 (로그인 안 됐으면 null)
function parseUserName(indexHtml) {
  const m = (indexHtml || "").match(/<div class="barcodeInfo"[^>]*>\s*([^<]+)/);
  return m ? htmlToText(m[1]) : null;
}

async function fetchAccount(account) {
  let cookieHeader = "";
  let httpStatus = 0;

  try {
    // 1. 로그인 요청
    const loginReq = new Request(LOGIN_URL);
    loginReq.method = "POST";
    loginReq.headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT
    };
    loginReq.body = `userId=${encodeURIComponent(account.id)}&password=${encodeURIComponent(account.pw)}`;

    loginReq.onRedirect = (newReq) => {
      if (loginReq.response && loginReq.response.cookies) {
        for (const c of loginReq.response.cookies) {
          if (c.name.toUpperCase() === "JSESSIONID") cookieHeader = `${c.name}=${c.value}`;
        }
      }
      if (!cookieHeader && loginReq.response && loginReq.response.headers) {
        for (const k of Object.keys(loginReq.response.headers)) {
          if (k.toLowerCase() === "set-cookie") {
            const m = loginReq.response.headers[k].match(/JSESSIONID=[^;]+/i);
            if (m) cookieHeader = m[0];
          }
        }
      }
      return newReq;
    };

    const loginBody = await loginReq.loadString();

    if (loginReq.response) {
      httpStatus = loginReq.response.statusCode;
    }

    if (LOGIN_FAILURE_PATTERNS.some(p => loginBody.includes(p))) {
      throw new Error("로그인 실패 (아이디·비밀번호를 확인해주세요)");
    }

    // 응답 객체에서 쿠키 추출
    if (!cookieHeader && loginReq.response && loginReq.response.cookies && loginReq.response.cookies.length > 0) {
      for (const c of loginReq.response.cookies) {
        if (c.name.toUpperCase() === "JSESSIONID") {
          cookieHeader = `${c.name}=${c.value}`;
          break;
        }
      }
      if (!cookieHeader) {
        cookieHeader = loginReq.response.cookies.map(c => `${c.name}=${c.value}`).join("; ");
      }
    }

    // 헤더에서 쿠키 추출
    if (!cookieHeader && loginReq.response && loginReq.response.headers) {
      for (const k of Object.keys(loginReq.response.headers)) {
        if (k.toLowerCase() === "set-cookie") {
          const raw = loginReq.response.headers[k];
          const m = raw.match(/JSESSIONID=[^;]+/i);
          if (m) {
            cookieHeader = m[0];
            break;
          }
        }
      }
    }

    const getHtml = (url) => {
      const req = new Request(url);
      req.headers = { "User-Agent": USER_AGENT };
      if (cookieHeader) req.headers["Cookie"] = cookieHeader;
      return req.loadString();
    };

    // 2. 회원 이름 + 대출 목록 + 상호대차 동시 요청 (같은 세션)
    const [indexHtml, loanHtml, dooHtml] = await Promise.all([
      getHtml(INDEX_URL),
      getHtml(LOAN_URL),
      getHtml(DOO_URL)
    ]);

    // 회원 이름은 main()에서 계정 간 세션이 섞였는지 대조하는 데 쓴다
    const siteName = parseUserName(indexHtml);
    if (!siteName) {
      throw new Error("로그인 확인 실패 (회원 정보가 보이지 않음)");
    }

    // 3. 한 페이지(10건)가 가득 차면 2페이지까지 읽는다
    const [loanHtml2, dooHtml2] = await Promise.all([
      splitRows(loanHtml).length >= PAGE_SIZE ? getHtml(`${LOAN_URL}?currentPageNo=2`) : "",
      splitRows(dooHtml).length >= PAGE_SIZE ? getHtml(`${DOO_URL}?currentPageNo=2`) : ""
    ]);

    // 4. 대출 및 상호대차 통합 파싱 (하나의 목록으로 결합)
    const loanRows = [...splitRows(loanHtml), ...splitRows(loanHtml2)];
    const dooRows = [...splitRows(dooHtml), ...splitRows(dooHtml2)];
    const { items, libSummary, loanCount, pickupCount, transitCount } = parseMemberBooks(loanRows, dooRows, account.label);

    return {
      name: account.label,
      siteName,
      items,
      libSummary,
      loanCount,
      pickupCount,
      transitCount,
      cookieStatus: cookieHeader ? "OK" : "Auto/None",
      httpStatus
    };
  } catch (err) {
    return {
      name: account.label,
      error: err.message,
      items: [],
      libSummary: {},
      loanCount: 0,
      pickupCount: 0,
      transitCount: 0,
      cookieStatus: cookieHeader ? "OK" : "ERR",
      httpStatus
    };
  }
}

// 상호대차 페이지에서 도서별 [수령도서관, 제공도서관, 상태] 정보 추출
// 같은 제목이 여러 건일 수 있어 제목으로 묶지 않고 목록으로 돌려준다
function parseDooraeEntries(rows) {
  const entries = [];

  for (const part of rows) {
    const cleanPart = part.replace(/<!--[\s\S]*?-->/g, "");
    const titleMatch = cleanPart.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
    const provMatch = cleanPart.match(/제공도서관\s*:\s*<\/span>\s*([^<\n\r]+)/);
    const recvMatch = cleanPart.match(/수령도서관\s*:\s*<\/span>\s*([^<\n\r]+)/);
    const statusMatch = cleanPart.match(/<div class="statusBox"[^>]*>([\s\S]*?)<\/div>/);
    if (!titleMatch) continue;

    const title = htmlToText(titleMatch[1]);
    // "요청중 신청취소"처럼 버튼 문구가 붙어 나오므로 첫 단어만 상태로 본다
    const status = (statusMatch ? htmlToText(statusMatch[1]) : "").split(" ")[0];

    entries.push({
      title,
      normTitle: normalizeTitle(title),
      providing: provMatch ? htmlToText(provMatch[1]) : "",
      receiving: recvMatch ? htmlToText(recvMatch[1]) : "",
      status,
      isActive: ACTIVE_DOO_STATUSES.includes(status)
    });
  }

  return entries;
}

// 대출 및 상호대차 통합 파싱 (하나의 통합 목록으로 결합)
function parseMemberBooks(loanRows, dooRows, userName) {
  const dooEntries = parseDooraeEntries(dooRows);
  const items = [];
  const libSummary = {};
  const rawLoanTitles = new Set();
  const seenLoans = new Set();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 제목이 같은 기록이 여러 건이면 먼저 나온(최신) 건을 쓴다
  const activeDooByTitle = new Map();
  const anyDooByTitle = new Map();
  for (const doo of dooEntries) {
    if (doo.isActive && !activeDooByTitle.has(doo.normTitle)) activeDooByTitle.set(doo.normTitle, doo);
    if (!anyDooByTitle.has(doo.normTitle)) anyDooByTitle.set(doo.normTitle, doo);
  }

  let loanCount = 0;
  let pickupCount = 0;
  let transitCount = 0;

  // 1. 대출 목록 파싱
  for (const part of loanRows) {
    const tm = part.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
    const libMatch = part.match(/<strong>([^<]+)<\/strong>/);
    const dueMatch = part.match(/반납(?:예정)?일\s*:\s*(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    const statusMatch = part.match(/<div class="statusBox"[^>]*>([\s\S]*?)<\/div>/);
    if (!tm || !dueMatch) continue;

    const title = htmlToText(tm[1]);
    const rawLib = libMatch ? htmlToText(libMatch[1]) : "";
    const [, yy, mm, dd] = dueMatch;
    const dueDateStr = `${yy}.${pad2(mm)}.${pad2(dd)}`;

    // 2페이지를 읽을 때 같은 책이 두 번 잡히지 않도록 한다
    const loanKey = `${normalizeTitle(title)}|${dueDateStr}|${rawLib}`;
    if (seenLoans.has(loanKey)) continue;
    seenLoans.add(loanKey);

    const dueDate = new Date(Number(yy), Number(mm) - 1, Number(dd));
    const diffTime = dueDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    rawLoanTitles.add(normalizeTitle(title));

    // 상호대차 판정은 데스크탑 앱과 같게: 책솔이 표시가 있거나, 진행 중인 상호대차와 제목이 같을 때만
    const isBooksole = statusMatch ? statusMatch[1].includes("책솔이") : false;
    const activeDoo = activeDooByTitle.get(normalizeTitle(title));
    const isInter = isBooksole || Boolean(activeDoo);
    const dooInfo = activeDoo || (isBooksole ? anyDooByTitle.get(normalizeTitle(title)) : null);

    let returnLib = rawLib;
    let provLib = rawLib;
    if (dooInfo && dooInfo.receiving) {
      returnLib = dooInfo.receiving;
      provLib = dooInfo.providing || rawLib;
    }

    const shortLib = abbreviateLibrary(returnLib);
    libSummary[shortLib] = (libSummary[shortLib] || 0) + 1;
    loanCount++;

    items.push({
      user: userName,
      title,
      lib: returnLib,
      provLib,
      shortLib,
      statusType: "대출중",
      diffDays,
      dueDate: dueDateStr,
      shortDate: `${pad2(mm)}.${pad2(dd)}`,
      isInter
    });
  }

  // 2. 상호대차 (수령대기 / 이동중) 도서 추가
  for (const doo of dooEntries) {
    if (!doo.isActive || rawLoanTitles.has(doo.normTitle)) continue;

    const shortLib = abbreviateLibrary(doo.receiving);
    if (doo.status === "입수") {
      pickupCount++;
      items.push({
        user: userName,
        title: doo.title,
        lib: doo.receiving,
        provLib: doo.providing,
        shortLib,
        statusType: "픽업필요",
        diffDays: -999, // 픽업필요는 목록 최상단에 노출
        dueDate: "-",
        shortDate: "-",
        isInter: true
      });
    } else {
      transitCount++;
      items.push({
        user: userName,
        title: doo.title,
        lib: doo.receiving,
        provLib: doo.providing,
        shortLib,
        statusType: "이동중",
        diffDays: 999, // 이동중은 목록 최하단에 노출
        dueDate: "-",
        shortDate: "-",
        isInter: true
      });
    }
  }

  // 정렬: 픽업필요(-999) -> 대출중(반납 임박순 diffDays) -> 이동중(999)
  items.sort((a, b) => a.diffDays - b.diffDays);

  return { items, libSummary, loanCount, pickupCount, transitCount };
}

// ==========================================
// 1. 홈 화면 위젯 뷰
// ==========================================
async function createWidget(data, updateInfo) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#1C1C1E");

  let allLoans = [];
  let allItems = [];
  let totalLoans = 0;
  let totalPickups = 0;
  let totalTransits = 0;

  for (const d of data) {
    if (d.items) allItems.push(...d.items);
    totalLoans += d.loanCount || 0;
    totalPickups += d.pickupCount || 0;
    totalTransits += d.transitCount || 0;
  }

  allItems.sort((a, b) => a.diffDays - b.diffDays);

  const header = widget.addStack();
  header.centerAlignContent();
  const title = header.addText("📚 송파도서관");
  title.font = Font.boldSystemFont(13);
  title.textColor = new Color("#FFFFFF");
  header.addSpacer();

  let badgeStr = `총 ${allItems.length}권`;
  if (totalPickups > 0) {
    badgeStr = `🔔 픽업 ${totalPickups} · 대출 ${totalLoans}`;
  } else if (totalTransits > 0) {
    badgeStr = `🚚 이동 ${totalTransits} · 대출 ${totalLoans}`;
  }
  const countBadge = header.addText(badgeStr);
  countBadge.font = Font.systemFont(11);
  countBadge.textColor = totalPickups > 0 ? new Color("#FFD60A") : new Color("#8E8E93");

  widget.addSpacer(6);

  const maxDisplay = 4;
  for (let i = 0; i < Math.min(allItems.length, maxDisplay); i++) {
    const item = allItems[i];
    const row = widget.addStack();
    row.centerAlignContent();

    let tagText = "";
    let tagColor = new Color("#30D158");

    if (item.statusType === "픽업필요") {
      tagText = "[픽업필요]";
      tagColor = new Color("#FFD60A");
    } else if (item.statusType === "이동중") {
      tagText = "[이동중]";
      tagColor = new Color("#64D2FF");
    } else {
      if (item.diffDays < 0) {
        tagText = `[연체 ${Math.abs(item.diffDays)}일]`;
        tagColor = new Color("#FF453A");
      } else if (item.diffDays === 0) {
        tagText = "[오늘 반납]";
        tagColor = new Color("#FF453A");
      } else if (item.diffDays <= 3) {
        tagText = `[D-${item.diffDays}]`;
        tagColor = new Color("#FF9F0A");
      } else {
        tagText = `[D-${item.diffDays}]`;
        tagColor = new Color("#30D158");
      }
    }

    const badge = row.addText(`${tagText} `);
    badge.font = Font.boldSystemFont(11);
    badge.textColor = tagColor;

    const label = row.addText(`${item.user.split(" ")[0]}: ${item.title} (${item.shortLib})`);
    label.font = Font.systemFont(11);
    label.textColor = new Color("#FFFFFF");
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
  footer.textColor = hasUpdate ? new Color("#FF9F0A") : new Color("#8E8E93");

  return widget;
}

// ==========================================
// 2. HTML 카드 뷰 (통합 테이블 목록)
// ==========================================
function buildHtmlPage(data) {
  let totalLoans = 0;
  let totalPickups = 0;
  let totalTransits = 0;
  let totalAll = 0;

  for (const d of data) {
    totalLoans += d.loanCount || 0;
    totalPickups += d.pickupCount || 0;
    totalTransits += d.transitCount || 0;
    totalAll += (d.items ? d.items.length : 0);
  }

  const tabsHtml = data.map((d, idx) => {
    const short = escapeHtml(shortName(d.name));
    const count = d.items ? d.items.length : 0;
    const interCount = d.items ? d.items.filter(b => b.isInter).length : 0;
    return `<a href="#card-${idx}" class="tab-pill">${short} <span class="tab-count">${count}</span><span class="tab-inter">(${interCount})</span></a>`;
  }).join("");

  const cardsHtml = data.map((d, idx) => {
    const items = d.items || [];

    // 반납/수령할 도서관 기준 요약 라인
    const summaryEntries = Object.entries(d.libSummary || {});
    const summaryHtml = summaryEntries.length > 0 
      ? summaryEntries.map(([lib, cnt]) => `<span>📍<strong>${escapeHtml(lib)}</strong>: ${cnt}권</span>`).join("&nbsp;&nbsp;·&nbsp;&nbsp;")
      : "대출 중인 도서관 없음";

    let errHtml = "";
    if (d.error) {
      errHtml = `<div class="err-box">⚠️ 조회 오류: ${escapeHtml(d.error)} (HTTP: ${d.httpStatus}, 쿠키: ${d.cookieStatus})</div>`;
    }

    let rowsHtml = "";
    if (items.length === 0) {
      rowsHtml = `<tr><td colspan="4" class="empty-cell">${d.error ? "도서 정보를 불러오지 못했습니다." : "현재 이용 중인 도서가 없습니다."}</td></tr>`;
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

          statusHtml = `${b.shortDate}<br><span class="badge-dday ${dueClass}">${badge}</span>`;
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

    return `
      <div class="card" id="card-${idx}">
        <div class="card-header">
          <div class="user-row">
            <span class="user-name">👤 ${escapeHtml(d.name)}</span>
            <span class="badge-total">${items.length}권</span>
          </div>
          <div class="stats-row">
            <span>대출 ${d.loanCount || 0}권</span>
            ${d.pickupCount > 0 ? `<span style="color:var(--yellow); font-weight:800;">· 🔔 픽업필요 ${d.pickupCount}권</span>` : ""}
            ${d.transitCount > 0 ? `<span style="color:#64D2FF;">· 🚚 이동중 ${d.transitCount}권</span>` : ""}
          </div>
        </div>

        ${errHtml}

        <div class="lib-summary">
          ${summaryHtml}
        </div>

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
  :root {
    --bg-color: #000000;
    --card-bg: #1C1C1E;
    --card-border: #2C2C2E;
    --text-primary: #FFFFFF;
    --text-secondary: #8E8E93;
    --green: #30D158;
    --blue: #0A84FF;
    --red: #FF453A;
    --orange: #FF9F0A;
    --yellow: #FFD60A;
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
    background: #000000;
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
  .tabs-container {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 6px 0 14px 0;
    position: sticky;
    top: var(--safe-top);
    background: rgba(0,0,0,0.85);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    z-index: 100;
    scrollbar-width: none;
  }
  .tabs-container::-webkit-scrollbar { display: none; }
  .tab-pill {
    background: #2C2C2E;
    color: #FFFFFF;
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
    background: rgba(255,255,255,0.2);
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
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    scroll-margin-top: 50px;
  }
  .card-header {
    margin-bottom: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
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
    background: rgba(255,255,255,0.12);
    color: #FFFFFF;
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
  .stat-transit { color: #64D2FF; }
  .err-box {
    background: rgba(255, 69, 58, 0.15);
    border: 1px solid rgba(255, 69, 58, 0.35);
    color: #FF453A;
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    margin-bottom: 10px;
    font-weight: 600;
  }
  .lib-summary {
    background: rgba(255,255,255,0.05);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    color: #D1D1D6;
    line-height: 1.5;
    margin-bottom: 12px;
  }
  .lib-summary strong {
    color: #FFFFFF;
  }
  .pickup-highlight { color: var(--yellow) !important; }
  .transit-highlight { color: #64D2FF !important; }
  .tag-pickup {
    display: inline-block;
    background: rgba(255, 214, 10, 0.18);
    color: var(--yellow);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    margin-right: 4px;
  }
  .tag-transit {
    display: inline-block;
    background: rgba(10, 132, 255, 0.18);
    color: #64D2FF;
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
    background: rgba(255, 214, 10, 0.2);
    color: var(--yellow);
    border: 1px solid rgba(255, 214, 10, 0.4);
  }
  .badge-transit {
    background: rgba(10, 132, 255, 0.2);
    color: #64D2FF;
    border: 1px solid rgba(10, 132, 255, 0.4);
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
    border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .book-table td {
    padding: 11px 4px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
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
    color: #FFFFFF;
  }
  .inter-highlight {
    color: #30D158 !important;
  }
  .lib-sub {
    font-size: 10px;
    color: #8E8E93;
    margin-top: 2px;
  }
  .col-title {
    padding-right: 6px !important;
  }
  .title-text {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    color: #F2F2F7;
  }
  .loc-detail {
    font-size: 11px;
    color: #98989D;
    margin-top: 4px;
  }
  .loc-detail strong {
    color: #30D158;
  }
  .prov-text {
    color: #636366;
  }
  .tag-booksole {
    display: inline-block;
    background: rgba(48, 209, 88, 0.15);
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
    <div class="app-subtitle">${data.length}개 계정 · 총 ${totalAll}권 이용 (대출 ${totalLoans}권${totalPickups > 0 ? ` · 🔔 픽업 ${totalPickups}권` : ''}${totalTransits > 0 ? ` · 🚚 이동 ${totalTransits}권` : ''})</div>
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
      widget.backgroundColor = new Color("#1C1C1E");
      const title = widget.addText("⚠️ 계정 설정 필요");
      title.font = Font.boldSystemFont(13);
      title.textColor = new Color("#FF9F0A");
      widget.addSpacer(4);
      const sub = widget.addText("Scriptable 앱에서 계정설정 스크립트(songpa-accounts)를 실행해 계정을 먼저 저장해주세요.");
      sub.font = Font.systemFont(11);
      sub.textColor = new Color("#FFFFFF");
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

  // 계정 간 세션(JSESSIONID/쿠키) 충돌 방지를 위해 순차 실행
  const data = [];
  const seenSiteNames = new Map();
  for (const a of accounts) {
    data.push(markSessionMixup(await fetchAccount(a), a, seenSiteNames));
  }

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
