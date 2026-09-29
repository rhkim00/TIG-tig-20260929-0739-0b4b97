# TH-030 검증 — 서로 다른 컴퓨터·실제 GitHub 계정으로 한 사이클

날짜: 2026-09-13. 목적: 배포 후 조건과 같게, 요청자와 수행자가 **다른 컴퓨터·다른 GitHub 계정**에서 `tig`만으로 요청→수행→PR→제출→승인→지급이 끝나는지 확인한다. 사용자 안내는 [사용 안내](../USER_GUIDE.md).

## 결과

| 단계 | 어디서 | 계정 | 결과 |
| --- | --- | --- | --- |
| 요청 게시 | 개발 서버(dlilab), `tig` | demo-requester (개발 서버 미리보기 계정) | 작업 `00f67338…`, 200 TIG 예치, `rhkim00/test-tig-requests`의 `tig/requests/00f67338…`, 요청 커밋 `f9b3c804`, 요구 Claude opus/medium |
| 기기 연결 | 다른 Linux 서버(aicoss195), 공개 HTTPS 주소 | kimkimrh2000-bit | `tig connect` → 웹 GitHub 로그인 → 기기 `aicoss195` 등록 |
| 수행 | aicoss195, `tig work --market` | kimkimrh2000-bit, Claude Code | claim→start→Claude opus/medium→결과 커밋 `da415bb8`→push 권한 없음이라 **fork** `kimkimrh2000-bit/test-tig-requests`의 `tig/results/00f67338…`→PR `rhkim00/test-tig-requests#2`(11 파일, +697, mergeable)→submit(`execution` client_observed, `gitResult` server_verified) |
| 검토 | 개발 서버 웹 | demo-requester | `AWAITING_REVIEW` → 웹에서 승인 21:01:33Z → **PAID**(version 5). 그 뒤 CLI 승인은 `REVIEW_CLOSED`로 거절(중복 정산 방지 확인) |
| 정산 | DB | — | settlements `paid/requester_approved` 1건, 수행자 available 200.00, 요청자 escrow 0 |

같은 DB를 두 서버(개발 서버 4173/4310, 검증용 빌드 서버 4320)가 공유했으므로 개발 계정이 올린 요청이 공개 주소의 마켓에도 보였다. 요청자까지 실제 계정으로 바꾼 사이클은 아직이며, 요청자 계정 `rhkim00`의 로그인·TIG 발행(아래)까지는 확인했다.

수행 도중 이 서버의 루트 디스크(3.5TB)가 가득 차 PostgreSQL이 재시작되고 node 서버 3개가 `Connection terminated unexpectedly`로 종료됐다. 공간 확보 후 재기동했고 거래 데이터는 보존됐다. 서버 프로세스는 DB 연결이 끊기면 스스로 재시작하지 않는다(운영 배포 TH-023에서 감독 프로세스 필요).

## 운영자 준비 (검증용, 정식 스테이징 아님)

정식 스테이징(호스팅·DNS/TLS·비밀 관리·백업)은 TH-023 범위다. 아래는 그 전에 외부 사용자 조건을 만드는 최소 절차이며 모두 [DEVELOPMENT.md](../DEVELOPMENT.md)의 기존 실행 방식(빌드 후 `npm start`)과 `.env.example`의 변수만 쓴다.

1. **공개 HTTPS 주소.** 개발 서버는 loopback만 듣는다. `cloudflared tunnel --url http://127.0.0.1:4320`(quick tunnel)로 임시 `https://<random>.trycloudflare.com`을 받는다. 재시작하면 주소가 바뀌므로 아래 2·3을 다시 맞춰야 한다.
2. **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New): Application name `Tokenisgold`, Homepage URL = 공개 주소, Authorization callback URL = `공개 주소/auth/github/callback`, Device Flow 미사용. 등록 후 Client ID와 **Generate a new client secret**. secret은 파일에만 넣고 채팅·PR·스크린샷에 올리지 않는다(노출되면 새로 생성하고 이전 것을 삭제).
3. **환경 파일** (예: `.local/staging/.env.staging`, gitignored):
   `NODE_ENV=production`, `TIG_DEV_MODE=false`, `TIG_LOCAL_TRIAL=true`, `APP_ORIGIN=<공개 주소>`, `HOST=127.0.0.1`, `PORT=4320`, `DATABASE_URL=<개발 DB>`, `GITHUB_CLIENT_ID=…`, `GITHUB_CLIENT_SECRET=…`.
   `TIG_LOCAL_TRIAL`은 Git 요청의 미격리 local trial 수락/제출을 개발 모드 밖에서 켜는 명시 플래그다([거래 계약](../contracts/lifecycle.md)).
4. **실행**: `npm run build` → 워커 `node --env-file=<파일> --import tsx apps/worker/src/main.ts &` → API `node --env-file=<파일> build/apps/api/src/main.js`. `/v1/config`가 `development:false, githubSignIn:true, localTrialSubmission:true`를 돌려주면 된다. 이 모드에는 데모 계정이 없고 실제 GitHub 로그인만 있다.
5. **TIG 자격(요청자만 필요).** 자동 구독 검증기는 미구현이다. 설계(P-029/031/034, `packages/db/migrations/001`)대로 `plan_prices`와 `verified` 상태의 `entitlements` 행을 넣으면 워커의 `grantDue()`가 표준 월 요금 USD×50 TIG를 즉시, 이후 매주 발행한다(`subscription.granted`). 검증에서 쓴 운영자 스크립트(가입 후 실행, 원문은 이 서버 `.local/staging/verify-entitlement.mts`):

   ```ts
   // node --env-file=<env> --import tsx verify-entitlement.mts <github-login> <codex|claude> <plan-id> <monthly-usd>
   import { randomUUID, createHash } from "node:crypto";
   import { pool, transaction } from "../../packages/db/src/index.js";
   const [login, provider, planId, monthlyUsd] = process.argv.slice(2);
   const db = pool(process.env.DATABASE_URL!);
   await transaction(db, async (tx) => {
     const user = (await tx.query("SELECT id FROM users WHERE login=$1", [login])).rows[0];
     if (!user) throw new Error("sign in on the website first");
     const now = new Date();
     const price = (await tx.query(
       "INSERT INTO plan_prices(id,provider,plan_id,monthly_usd,source_url,checked_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
       [randomUUID(), provider, planId, monthlyUsd, "operator://manual-verification", now])).rows[0];
     const subject = createHash("sha256").update(`operator:${provider}:${login}`).digest("hex"); // UNIQUE(provider,subject_hash)
     await tx.query(
       "INSERT INTO entitlements(id,user_id,provider,subject_hash,price_id,status,verified_until,first_verified_at) VALUES($1,$2,$3,$4,$5,'verified',$6,$7)",
       [randomUUID(), user.id, provider, subject, price.id, new Date(now.getTime() + 30 * 86400000), now]);
   });
   await db.end();
   ```

   확인: `rhkim00 claude max-5x 100` → 다음 tick에 `{"grants":1}` 로그, `ledger_accounts` available 5000.00. 수행자는 잔액 없이 수락할 수 있으므로 자격이 필요 없다.
6. **요청자 CLI**: 개발 서버 연결과 분리하려면 `TIG_STATE_DIR=~/.local/share/tokenisgold-staging tig connect --origin <공개 주소>`.

검증이 끝나면 OAuth App을 삭제하고 터널을 내린다.

## 이번 변경 (CLI 온보딩·잔여량)

- `tig doctor`: Node 24·Git·GitHub CLI(2.21+, 로그인)·Codex/Claude Code(구독 로그인)·Tokenisgold 연결·격리를 한 표로 보여주고 ✗마다 고칠 명령을 붙인다. 로컬 AI는 하나만 준비돼도 통과. `--json`, 준비 안 되면 종료 코드 1.
- 네트워크 실패 문구: `fetch failed` → `Cannot reach <website>. Check the website address, your network and that the website is running`. JSON이 아닌 응답(터널 오류 페이지 등)도 주소 확인 안내.
- 기기 연결: 코드 만료 시간(서버 `expiresIn`, 10분)과 "터미널을 열어 두라"는 안내, 만료 시 재실행 안내. 첫 실행이 내장 주소를 쓸 때 다른 서버면 `tig connect --origin`을 쓰라고 명시.
- Claude Code 잔여량(P-018/P-053): `tig claude-statusline install`이 사용자 동의 후 `~/.claude/settings.json`의 `statusLine`을 tig 실행 파일 절대경로로 설정하고 이전 설정을 상태 폴더에 보관해 그대로 위에 실행한다(덮어쓰지 않음, `uninstall`로 복원). 저장 값은 `rate_limits`의 `five_hour`/`seven_day`/`spend_limit`의 `used_percentage`·`resets_at`뿐이며 cwd·모델·비용은 버린다. reset이 지난 창은 unknown. `tig sync-claude`가 이를 `client_observed` 관측으로 서버에 보내고 `observe`/`sync-codex`와 같은 알림 규칙(80%/30%/6시간 억제)을 공유한다.
- 미결정으로 남긴 것(유찬 확인): 상태줄/hook 설치를 첫 연결에서 제안할지(DRAFT-03), 조회 주기·자동 sync(QUOTA-03), OS 알림 채널(P-046).

검사: `npx tsc --noEmit`, `node --test tests/doctor.test.ts tests/claude-usage.test.ts tests/cli.test.ts tests/wizard.test.ts tests/executables.test.ts` 32/32, 실제 설치본에서 `tig doctor`(Ready/미연결 두 경우), `tig claude-statusline`(stdin JSON→`Tig · 5h 12% · 7d 40%`), 임시 `CLAUDE_CONFIG_DIR`에서 install/uninstall 왕복, `tig sync-claude` 미연결 안내.
