import { Command, Help } from "commander";

const descriptions: Record<string, string> = {
  help: "처음 시작하는 순서·전체 기능 또는 지정 명령의 도움말을 봅니다.",
  setup: "서버 주소와 프로젝트 연결 설정을 다시 안내합니다.",
  connect:
    "웹 로그인과 기기 코드로 이 컴퓨터를 연결합니다. 서버 주소가 필요합니다.",
  doctor: "설치·GitHub/AI 로그인·서비스 연결 상태와 해결 방법을 확인합니다.",
  status: "연결된 계정, TIG 잔액과 연결 정보를 조회합니다.",
  tasks: "작업 목록을 조회합니다. --mine으로 내가 요청한 작업만 봅니다.",
  task: "작업 상태, 결과와 검토 기한을 조회합니다.",
  work: "로컬 AI로 작업합니다. 본인 요청은 개인 체험, 타인 요청은 수락·실행·제출합니다.",
  result:
    "제출된 결과를 JSON으로 조회하거나 저장합니다. 코드에 적용하지 않습니다.",
  approve: "요청자가 결과를 승인하고 수행자에게 TIG를 지급합니다. --yes 필수.",
  issue:
    "요청자가 문제를 접수해 보상을 환불받고 작업을 종료합니다. --yes 필수.",
  cancel: "수락 전 요청을 취소합니다. task에서 확인한 version을 지정합니다.",
  inbox: "읽은 알림을 포함한 작업 알림과 읽지 않은 개수를 조회합니다.",
  read: "알림 하나를 읽음으로 표시합니다.",
  insights: "내 프로젝트의 최근 30일 일일 집계를 조회합니다.",
  "sync-codex": "로컬 Codex에서 조회한 사용량을 Tokenisgold에 전송합니다.",
  "sync-claude": "Claude 상태줄에서 수집한 사용량을 Tokenisgold에 전송합니다.",
  "claude-statusline":
    "Claude Code가 호출하는 사용량 상태줄입니다. 먼저 install을 실행하세요.",
  "claude-statusline install":
    "Claude Code에 TIG 사용량 상태줄을 설치합니다. 기존 상태줄을 유지합니다.",
  "claude-statusline uninstall":
    "TIG 상태줄을 제거하고 이전 설정을 복원합니다.",
  "claude-notes":
    "Claude Code가 호출하는 답변 저장 hook입니다. 먼저 install을 실행하세요.",
  "claude-notes install":
    "Claude Code 세션의 마지막 답변을 로컬에 저장하는 hook을 설치합니다.",
  "claude-notes uninstall": "TIG 답변 저장 hook을 제거합니다.",
  project: "공개 GitHub 저장소를 서비스 프로젝트로 등록합니다.",
  init: "요청용 프로젝트 연결과 AI 지침을 설정합니다. 게시할 때마다 새 공개 저장소가 만들어집니다. 일반 사용자는 tig로 시작하세요.",
  instructions: "기존 AI가 읽을 Tokenisgold 요청 작성 규칙을 출력합니다.",
  untracked: "프로젝트의 Git 미추적 파일을 조회합니다.",
  checkpoint: "프로젝트 변경과 인계 요약을 로컬 초안으로 저장합니다.",
  watch:
    "파일 변경을 감시해 로컬 초안을 저장합니다. 수행 대기는 work --watch입니다.",
  export: "저장된 로컬 초안을 JSON 파일로 내보냅니다.",
  request: "AI가 작성한 명세로 Git 요청을 단계별 준비·확인·게시합니다.",
  "request prepare": "명세 JSON과 프로젝트로 공개 전 요청 패키지를 준비합니다.",
  "request show": "준비한 요청의 내용·파일 목록·승인용 digest를 확인합니다.",
  "request publish":
    "검토한 digest를 지정해 새 공개 저장소를 만들어 게시하고 TIG를 예치합니다. --yes 필요.",
  post: "명세 JSON과 checkpoint 초안을 플랫폼에 게시합니다. 일반 사용자는 tig를 쓰세요.",
  observe:
    "허용된 사용량 메타데이터 JSON을 전송합니다. 구독 지급 자격 검증과는 별개입니다.",
  accept: "작업 하나를 수동 수락합니다. --yes 필수. 보통 work가 처리합니다.",
  start:
    "수락한 작업의 실행 시작을 서버에 기록합니다. AI 실행 명령은 work입니다.",
  heartbeat: "현재 작업의 진행 신호를 서버에 보냅니다.",
  interrupt:
    "서버에 작업 중단을 기록합니다. 실행 중인 CLI 종료는 Ctrl+C입니다.",
  resume:
    "중단된 작업을 서버에서 재개합니다. 이어서 work <taskId>를 실행하세요.",
  submit: "구조화된 결과 JSON을 수동 제출합니다. 보통 work가 처리합니다.",
  "demo-post": "개발용 샘플 작업을 게시하고 샘플 TIG를 예치합니다.",
  "demo-run":
    "고정된 개발용 샘플을 실행·제출합니다. 실제 AI를 호출하지 않습니다.",
};

const examples: Record<string, string> = {
  connect:
    "tig connect --origin https://YOUR-TOKENISGOLD-SERVER --name my-computer\n웹에서 기기 코드를 10분 안에 확인하고 Device connected.가 나올 때까지 기다리세요.\n주소는 실제 실행 중인 Tokenisgold 서버 주소로 바꾸세요. clone/CLI 설치만으로 서버가 켜지지는 않습니다.",
  work: "tig work --market              지금 가능한 작업 한 건을 제안받기\ntig work --watch               10분마다 확인하며 제안·알림 받기 (Ctrl+C 종료)\ntig work --watch --every 5     5분 간격으로 확인하기\ntig work <taskId>              지정 작업 수행/실패한 작업 이어가기\n제안에서 yes=수락·실행·제출, next=다른 작업, no=이번에는 안 함.\n본인 요청은 개인 체험으로 제출·지급하지 않습니다. 실제 거래는 다른 계정이 필요합니다.\n중단 상태면 tig resume <taskId> 후 tig work <taskId>로 이어갑니다.",
  tasks:
    "tig tasks --mine\n출력의 id를 tig task <taskId> 같은 명령에 사용하세요. <...>는 실제 값으로 바꾸며 꺾쇠는 입력하지 않습니다.",
  task: "tig task <taskId>",
  result:
    "tig result <taskId> --output result.json\n결과 코드는 PR에서 검토하세요. 다운로드·TIG 지급·코드 적용은 별도입니다.",
  approve:
    "tig approve <taskId> --yes\n결과를 확인한 뒤 실행하세요. 예치한 TIG를 지급하며 자동으로 코드를 병합하지 않습니다.",
  issue: "tig issue <taskId> --yes",
  cancel:
    "tig task <taskId>\ntig cancel <taskId> --version 3\n3은 예시입니다. 방금 조회한 작업의 실제 version으로 바꾸세요.",
  read: "tig read <notificationId>\n알림 ID는 tig inbox에서 확인하세요.",
  "sync-claude":
    "tig claude-statusline install\nClaude Code에서 응답을 한 번 받은 다음 tig sync-claude를 실행하세요.",
  project:
    "tig project --repository OWNER/REPO --type web_app --stack TypeScript,React",
  init: "tig init --project /path/to/project --install-instructions\n저장소를 미리 정하지 않습니다. 요청을 게시할 때 내 GitHub 계정 아래에 새 공개 저장소(<프로젝트>-tig-<날짜>-<id>)가 만들어집니다.",
  checkpoint:
    'tig checkpoint --project /path/to/project --summary "완료한 것과 다음 작업"',
  watch:
    "tig watch --project /path/to/project\n초안은 로컬에 저장됩니다. 종료는 Ctrl+C. 작업 제안을 기다리려면 tig work --watch.",
  export: "tig export --project /path/to/project --output handoff.json",
  "request prepare":
    "tig request prepare --spec request-spec.json --project /path/to/project",
  "request show":
    "tig request show <requestId>\nrequestId는 prepare 결과의 요청 ID이며, 게시 후 플랫폼 taskId와 다릅니다.",
  "request publish":
    "tig request show <requestId>\ntig request publish <requestId> --approve <digest> --yes\n방금 확인한 요청의 승인용 digest를 사용하세요.",
  post: "tig checkpoint --project /path/to/project\ntig post --project /path/to/project --spec task.json",
  observe: "tig observe --file observation.json",
  accept: "tig accept <taskId> --yes",
  submit: "tig submit <taskId> --file result.json",
  "demo-post": "tig demo-post --reward 100",
  "demo-run":
    "tig accept <taskId> --yes\ntig demo-run <taskId> --yes\n개발용 샘플 작업에만 사용하세요.",
};

const groups = [
  ["연결·상태", ["doctor", "connect", "setup", "status"]],
  [
    "요청·수행·결과",
    ["tasks", "task", "work", "result", "approve", "issue", "cancel"],
  ],
  ["알림·인사이트", ["inbox", "read", "insights"]],
  [
    "AI 사용량·연동",
    ["sync-codex", "sync-claude", "claude-statusline", "claude-notes"],
  ],
  [
    "고급: 초안·Git·AI 자동화",
    [
      "project",
      "init",
      "instructions",
      "untracked",
      "checkpoint",
      "watch",
      "export",
      "request",
      "post",
      "observe",
    ],
  ],
  [
    "고급: 수동 작업 제어",
    ["accept", "start", "heartbeat", "interrupt", "resume", "submit"],
  ],
  ["개발용 샘플", ["demo-post", "demo-run"]],
] as const;

const introduction = `Tokenisgold — 터미널 사용 안내

처음이면 이 순서로
  1. tig doctor       설치·로그인·서버 연결을 확인하고 안내된 항목을 해결하세요.
  2. tig              맡길 프로젝트 폴더에서 실행하세요. 첫 연결은 화면이 안내합니다.
     다른 서버를 쓰면: tig connect --origin https://YOUR-TOKENISGOLD-SERVER
     위 주소는 예시입니다. 실제 서버 주소가 필요하며 CLI 설치만으로 서버가 켜지지는 않습니다.
  3. 폴더가 맞는지 확인(Enter=예, no=다른 폴더를 경로나 이름으로 입력)합니다.
     이어서 GitHub 로그인 계정을 보여 주고 그 계정에 요청 저장소를 만들지 묻습니다(no=다른 계정으로 로그인).
     Codex·Claude Code가 설치돼 있는데 로그인이 안 됐으면 공식 로그인을 열어 줍니다.
  4. 맡길 작업을 한 문장으로 적습니다. 도구·모델·추론 수준·TIG를 같이 적으면 그 항목은 묻지 않습니다.
     예: 인증 미들웨어 리팩터링, claude / opus / high, 300 TIG
     빠진 항목(도구, 모델, 추론 수준, TIG, 완료 기준)만 하나씩 묻습니다. tig가 대신 정하지 않습니다.
  5. 요약을 확인하고 yes를 입력하면 내 GitHub 계정에 새 공개 저장소를 만들어 프로젝트 전체와
     request.md를 올리고 TIG를 예치합니다. 요청마다 저장소가 하나씩 생깁니다.

하고 싶은 일별 시작 명령
  작업 맡기기     tig
  설명을 한 번에  tig "버그를 고치고 테스트를 추가해줘, codex / gpt-5 / high, 100 TIG"
  작업 받아 하기  tig work --market
  계속 제안 받기  tig work --watch             (기본 10분, 종료 Ctrl+C)
  내 요청 보기    tig tasks --mine
  결과 확인하기   tig task <taskId>            (작업 ID는 목록의 id)
  결과 승인·지급  tig approve <taskId> --yes
  문제 접수·환불  tig issue <taskId> --yes
  잔액 확인하기   tig status

게시 화면에서 답하는 방법
  yes/네 = 공개 게시·예치, no/아니요 = 바꿀 점을 입력하면 요청 내용에 덧붙여 다시 준비
  details = 명세·파일 상세, later = 게시하지 않고 종료, 숫자 = 보상 변경
  provider / model / effort = 수행자 AI 조건 변경 (예: codex / 모델명 / high)
  request.md는 내 답변과 프로젝트 사실(브랜치·최근 커밋·설치/테스트 명령)로만 작성됩니다. AI가 초안을 쓰지 않습니다.
  보상·도구·모델·추론 수준은 내가 적은 값만 쓰며 추천 금액은 없습니다. yes 전에 금액·공유 파일을 확인하세요.
  tig는 실행할 때마다 새 요청입니다. 이전 실행의 내용을 이어받거나 보여 주지 않습니다.

수행 흐름
  tig work --market → 제안 확인 → yes → AI 작업·Git PR·플랫폼 제출
  next는 다른 작업, no는 이번에는 안 함입니다. 제안만으로 실행되지는 않습니다.
  tig work <taskId>로 지정 작업을 이어갈 수 있습니다.
  본인 요청은 개인 체험: 결과 제출·TIG 지급 없음. 실제 거래는 서로 다른 계정이 필요합니다.
  제출 후 요청자가 결과를 검토합니다. TIG 지급과 결과 코드 적용은 별도입니다.

전체 명령 (세부 옵션·예시: tig <명령> --help)
  <taskId>, <requestId>, <경로> 등은 실제 값으로 바꾸세요. 꺾쇠는 입력하지 않습니다.
  조회 명령 상당수는 JSON을 출력합니다. 고급 명령은 일반 흐름에서 직접 칠 필요가 없습니다.
`;

/** Help only formats command metadata; it must never connect, draft or call an AI. */
export function configureTigHelp(program: Command) {
  program.addHelpCommand(false);
  program.command("help [command...]").action((names: string[]) => {
    let target = program;
    for (const name of names) {
      const next = target.commands.find((child) => child.name() === name);
      if (!next)
        throw new Error(
          `알 수 없는 명령: ${names.join(" ")}. tig help에서 전체 명령을 확인하세요.`,
        );
      target = next;
    }
    target.outputHelp();
  });
  function localize(command: Command, path = "") {
    if (descriptions[path]) command.description(descriptions[path]);
    command.helpOption("-h, --help", "명령 설명·옵션·예시 보기");
    if (examples[path])
      command.addHelpText("after", `\n사용 예시\n${examples[path]}\n`);
    for (const child of command.commands) {
      localize(child, path ? `${path} ${child.name()}` : child.name());
    }
  }
  localize(program);
  program.description(
    "작업 요청·수행·TIG 결과 확인을 연결하는 Tokenisgold CLI",
  );
  program.configureHelp({
    formatHelp(command, helper) {
      if (command !== program) return new Help().formatHelp(command, helper);
      const lines = [introduction];
      const shown = new Set<string>();
      function entry(child: Command, parent = "") {
        lines.push(
          `  tig ${parent}${helper.subcommandTerm(child)}`,
          `    ${child.description()}`,
        );
        for (const nested of child.commands)
          entry(nested, `${parent}${child.name()} `);
      }
      for (const [title, names] of groups) {
        lines.push(title);
        for (const name of names) {
          const child = command.commands.find((c) => c.name() === name);
          if (child) {
            entry(child);
            shown.add(name);
          }
        }
        lines.push("");
      }
      // Newly registered commands still appear even before a category is chosen.
      const rest = helper
        .visibleCommands(command)
        .filter((c) => !shown.has(c.name()));
      if (rest.length) {
        lines.push("도움말·기타");
        for (const child of rest) entry(child);
      }
      lines.push(
        "",
        "옵션",
        "  -h, --help       이 안내 보기",
        "  -V, --version    설치 버전 보기",
        "",
        "더 알아보기",
        "  tig help work              수행·대기 옵션과 예시",
        "  tig help request publish   고급 게시 옵션과 예시",
        "  tig request --help         Git 요청 단계별 명령",
        "  도움말은 로그인·서버 연결 없이 볼 수 있으며 AI 호출이나 게시를 하지 않습니다.",
        "",
      );
      return lines.join("\n");
    },
  });
}
