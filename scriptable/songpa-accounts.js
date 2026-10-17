// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: key;
// 송파구립도서관 대출 현황 - 계정 설정 (iOS 키체인 저장)
// https://github.com/pchuri/songpa-loan-tracker (MIT License)
// 아이디·비밀번호·회원번호는 실행할 때 입력받아 이 기기의 키체인에만 저장한다. 코드에 적지 않는다.

const KEYCHAIN_KEY = "SPLIB_ACCOUNTS";

const MEMBER_ID_GUIDE =
  "회원번호(대출증 바코드 번호)는 도서관 회원증이나 홈페이지 마이페이지에서 직접 확인한 값을 입력하세요. " +
  "메인 스크립트는 조회한 화면의 회원번호가 이 값과 같을 때만 결과를 보여줍니다. 아이디와 다를 수 있습니다.";

function loadAccounts() {
  if (!Keychain.contains(KEYCHAIN_KEY)) return [];
  try {
    const parsed = JSON.parse(Keychain.get(KEYCHAIN_KEY));
    return Array.isArray(parsed) ? parsed.filter(a => a && typeof a === "object") : [];
  } catch (e) {
    return [];
  }
}

function saveAccounts(accounts) {
  if (accounts.length === 0) {
    if (Keychain.contains(KEYCHAIN_KEY)) Keychain.remove(KEYCHAIN_KEY);
    return;
  }
  Keychain.set(KEYCHAIN_KEY, JSON.stringify(accounts));
}

// 메인 스크립트(songpa-loan-tracker.js)와 같은 규칙: 공백·하이픈 제거, 대문자, 영문·숫자 4~32자
function normalizeMemberId(value) {
  const s = String(value == null ? "" : value).replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(s) ? s : null;
}

function memberIdStatus(acc) {
  const m = normalizeMemberId(acc.memberId);
  return m ? `회원번호 ••••${m.slice(-3)}` : "⚠️ 회원번호 미설정";
}

// 입력값을 계정 목록에 반영한다. 비워 둔 비밀번호·회원번호·회원 이름은 기존 값을 유지한다.
// 회원 이름에 "-"를 넣으면 지운다. 성공하면 새 배열을 돌려준다(원본은 바꾸지 않음).
function mergeAccount(accounts, input) {
  const id = String(input.id || "").trim();
  if (!id) return { ok: false, message: "도서관 홈페이지 아이디를 입력해주세요." };
  // 예전 계정의 아이디에 앞뒤 공백이 있어도 같은 계정으로 찾는다. 공백을 빼면 둘 이상이 겹치면 고치지 않는다.
  const matches = accounts.map((a, i) => (String(a.id == null ? "" : a.id).trim() === id ? i : -1)).filter(i => i >= 0);
  if (matches.length > 1) return { ok: false, message: "같은 아이디로 저장된 계정이 여러 개라 고칠 수 없습니다. 하나를 삭제해주세요." };
  const idx = matches.length === 1 ? matches[0] : -1;
  const prev = idx >= 0 ? accounts[idx] : null;

  const label = String(input.label || "").trim() || (prev ? String(prev.label || "") : "");
  const pw = input.pw ? String(input.pw) : (prev ? prev.pw : "");
  if (!label || !pw) return { ok: false, message: "이름과 비밀번호를 입력해주세요." };

  const rawMember = String(input.memberId || "").trim();
  let memberId;
  if (rawMember) {
    memberId = normalizeMemberId(rawMember);
    if (!memberId) return { ok: false, message: "회원번호 형식이 올바르지 않습니다 (영문·숫자 4~32자)." };
  } else {
    memberId = prev ? normalizeMemberId(prev.memberId) : null;
  }
  if (!memberId) return { ok: false, message: `회원번호를 입력해주세요.\n\n${MEMBER_ID_GUIDE}` };
  if (accounts.some((a, i) => i !== idx && normalizeMemberId(a.memberId) === memberId)) {
    return { ok: false, message: "같은 회원번호가 다른 계정에 이미 등록되어 있습니다." };
  }

  const next = { ...(prev || {}), label, id, pw, memberId };
  const rawSite = String(input.siteName == null ? "" : input.siteName).trim();
  if (rawSite === "-") delete next.siteName;
  else if (rawSite) next.siteName = rawSite;

  const list = accounts.slice();
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  return { ok: true, accounts: list, account: next, updated: idx >= 0 };
}

async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("확인");
  await a.presentAlert();
}

async function saveInput(accounts, input) {
  const r = mergeAccount(accounts, input);
  if (!r.ok) {
    await notify("저장하지 않음", r.message);
    return false;
  }
  saveAccounts(r.accounts);
  await notify("저장 완료", `${r.account.label} 계정을 키체인에 ${r.updated ? "수정" : "저장"}했습니다. (총 ${r.accounts.length}개)`);
  return true;
}

async function addAccount(accounts) {
  const a = new Alert();
  a.title = "➕ 계정 추가";
  a.message = "송파구립도서관 홈페이지 로그인 정보와 직접 확인한 회원번호를 입력하세요.\n" +
    "같은 아이디가 이미 있으면 그 계정을 고칩니다 (비워 둔 비밀번호·회원번호·회원 이름은 기존 값 유지).\n\n" + MEMBER_ID_GUIDE;
  a.addTextField("이름 (화면에 표시)", "");
  a.addTextField("도서관 홈페이지 아이디", "");
  a.addSecureTextField("비밀번호", "");
  a.addTextField("회원번호 (회원증·마이페이지에서 확인)", "");
  a.addTextField("홈페이지 표시 회원 이름 (선택)", "");
  a.addAction("저장");
  a.addCancelAction("취소");
  if (await a.presentAlert() === -1) return false;

  return saveInput(accounts, {
    label: a.textFieldValue(0),
    id: a.textFieldValue(1),
    pw: a.textFieldValue(2),
    memberId: a.textFieldValue(3),
    siteName: a.textFieldValue(4)
  });
}

// 기존 계정의 이름·비밀번호·회원번호를 고친다. 아이디는 바꾸지 않는다.
async function editAccount(accounts) {
  const pick = new Alert();
  pick.title = "✏️ 수정할 계정 선택";
  for (const acc of accounts) pick.addAction(`${acc.label} (${acc.id}) · ${memberIdStatus(acc)}`);
  pick.addCancelAction("취소");
  const idx = await pick.presentAlert();
  if (idx === -1) return false;
  const acc = accounts[idx];

  const a = new Alert();
  a.title = `✏️ ${acc.label} 수정`;
  a.message = `아이디: ${acc.id}\n비밀번호를 비워 두면 기존 비밀번호를 유지합니다. 회원 이름에 "-"를 넣으면 지웁니다.\n\n${MEMBER_ID_GUIDE}`;
  a.addTextField("이름 (화면에 표시)", String(acc.label || ""));
  a.addSecureTextField("새 비밀번호 (비우면 유지)", "");
  a.addTextField("회원번호 (회원증·마이페이지에서 확인)", normalizeMemberId(acc.memberId) || "");
  a.addTextField("홈페이지 표시 회원 이름 (선택)", String(acc.siteName || ""));
  a.addAction("저장");
  a.addCancelAction("취소");
  if (await a.presentAlert() === -1) return false;

  return saveInput(accounts, {
    id: acc.id,
    label: a.textFieldValue(0),
    pw: a.textFieldValue(1),
    memberId: a.textFieldValue(2),
    siteName: a.textFieldValue(3)
  });
}

async function removeAccount(accounts) {
  const a = new Alert();
  a.title = "🗑️ 삭제할 계정 선택";
  for (const acc of accounts) a.addDestructiveAction(`${acc.label} (${acc.id})`);
  a.addCancelAction("취소");
  const idx = await a.presentAlert();
  if (idx === -1) return;

  const [removed] = accounts.splice(idx, 1);
  saveAccounts(accounts);
  await notify("삭제 완료", `${removed.label} 계정을 삭제했습니다. (남은 계정 ${accounts.length}개)`);
}

async function main() {
  while (true) {
    const accounts = loadAccounts();
    const a = new Alert();
    a.title = "🔑 송파도서관 계정 설정";
    a.message = accounts.length > 0
      ? `저장된 계정 ${accounts.length}개\n` + accounts.map(acc => `• ${acc.label} (${acc.id}) · ${memberIdStatus(acc)}`).join("\n")
      : "저장된 계정이 없습니다. 계정을 추가해주세요.";
    a.addAction("➕ 계정 추가");
    if (accounts.length > 0) {
      a.addAction("✏️ 계정 수정 (회원번호 입력)");
      a.addAction("🗑️ 계정 하나 삭제");
      a.addDestructiveAction("⚠️ 전체 삭제");
    }
    a.addCancelAction("닫기");

    const choice = await a.presentAlert();
    if (choice === -1) return;
    if (choice === 0) {
      await addAccount(accounts);
    } else if (choice === 1) {
      await editAccount(accounts);
    } else if (choice === 2) {
      await removeAccount(accounts);
    } else if (choice === 3) {
      const confirm = new Alert();
      confirm.title = "전체 삭제";
      confirm.message = "저장된 계정을 모두 삭제할까요?";
      confirm.addDestructiveAction("모두 삭제");
      confirm.addCancelAction("취소");
      if (await confirm.presentAlert() === 0) {
        saveAccounts([]);
        await notify("삭제 완료", "키체인에서 모든 계정을 삭제했습니다.");
      }
    }
  }
}

await main();
Script.complete();
