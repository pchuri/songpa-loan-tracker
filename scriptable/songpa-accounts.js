// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: key;
// 송파구립도서관 대출 현황 - 계정 설정 (iOS 키체인 저장)
// https://github.com/pchuri/songpa-loan-tracker (MIT License)
// 아이디·비밀번호는 실행할 때 입력받아 이 기기의 키체인에만 저장한다. 코드에 적지 않는다.

const KEYCHAIN_KEY = "SPLIB_ACCOUNTS";

function loadAccounts() {
  if (!Keychain.contains(KEYCHAIN_KEY)) return [];
  try {
    const parsed = JSON.parse(Keychain.get(KEYCHAIN_KEY));
    return Array.isArray(parsed) ? parsed : [];
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

async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("확인");
  await a.presentAlert();
}

async function addAccount(accounts) {
  const a = new Alert();
  a.title = "➕ 계정 추가";
  a.message = "송파구립도서관 홈페이지 로그인 정보를 입력하세요.\n같은 아이디가 이미 있으면 새 정보로 바꿉니다.";
  a.addTextField("이름 (화면에 표시)", "");
  a.addTextField("도서관 홈페이지 아이디", "");
  a.addSecureTextField("비밀번호", "");
  a.addAction("저장");
  a.addCancelAction("취소");
  if (await a.presentAlert() === -1) return false;

  const label = a.textFieldValue(0).trim();
  const id = a.textFieldValue(1).trim();
  const pw = a.textFieldValue(2);
  if (!label || !id || !pw) {
    await notify("입력 누락", "이름, 아이디, 비밀번호를 모두 입력해주세요.");
    return false;
  }

  const idx = accounts.findIndex(acc => acc.id === id);
  if (idx >= 0) accounts[idx] = { label, id, pw };
  else accounts.push({ label, id, pw });
  saveAccounts(accounts);
  await notify("저장 완료", `${label} 계정을 키체인에 저장했습니다. (총 ${accounts.length}개)`);
  return true;
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
      ? `저장된 계정 ${accounts.length}개\n` + accounts.map(acc => `• ${acc.label} (${acc.id})`).join("\n")
      : "저장된 계정이 없습니다. 계정을 추가해주세요.";
    a.addAction("➕ 계정 추가");
    if (accounts.length > 0) {
      a.addAction("🗑️ 계정 하나 삭제");
      a.addDestructiveAction("⚠️ 전체 삭제");
    }
    a.addCancelAction("닫기");

    const choice = await a.presentAlert();
    if (choice === -1) return;
    if (choice === 0) {
      await addAccount(accounts);
    } else if (choice === 1) {
      await removeAccount(accounts);
    } else if (choice === 2) {
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
