# agent-orchestrator 고도화 설계 (2026-06)

> **구현 현황 (2026-06-11): P0–P4 전부 구현 완료.** 테스트 136개 통과. 각 Phase의 동작 문서는 README의 해당 섹션(Routing / Review panel / A3 Interview·Replan / A4 Parallel) 참조.

oh-my-openagent(OmO)의 오케스트레이션 패턴을 참고하되, 본 프로젝트의 핵심 설계 원칙은 유지한다.

## 유지하는 것 (변경하지 않음)

OmO와 비교한 결과, 아래는 현재 설계가 더 우수하거나 OmO 방식이 적용 불가하여 **그대로 유지**한다.

| 영역 | 판단 |
| --- | --- |
| **Review-first 루프** | OmO의 Todo Enforcer(멈추면 재촉)보다 구조화된 verdict(approve/request_changes/requires_human_review) 기반 루프가 감사·재현성 면에서 우월. 유지. |
| **중앙 오케스트레이션 (no nested agents)** | OmO Team Mode는 멤버 간 직접 메시징을 허용하지만, 본 프로젝트의 "워커는 서로 호출 불가" 원칙이 README의 존재 이유. 병렬화는 하되 통신은 오케스트레이터 경유로 유지. |
| **안전 모델** (allowedPaths / risk tags / denyShellPatterns / redaction) | OmO에 대응물 없음. 모든 신규 기능은 이 안전 모델을 우회하지 않아야 함. |
| **아티팩트 기반 감사 추적** (runs/, conversation.jsonl, timeline.jsonl) | OmO는 tmux 시각화 중심, 영속 감사 로그 없음. 유지하고 신규 기능도 같은 형식으로 기록. |
| **Hashline (해시 앵커 편집)** | 에이전트 내부 편집 도구 레이어 기능. 워커가 CLI(Claude Code/Codex) 자체 편집 도구를 쓰는 본 구조에는 적용 대상 아님. 도입 안 함. |
| **예산/중단 체계** (maxTasks, wall-clock, consecutiveFailures) | 완주 루프(Phase 4)를 도입해도 예산은 항상 하드 캡으로 우선. requires_approval 게이트도 어떤 루프도 우회 불가. |

## 도입하는 것 — 5 Phase

구현 순서는 의존성과 리스크 기준: **P0 메시지 envelope → P1 라우팅 → P2 리뷰 패널 → P3 인터뷰+완주 루프 → P4 병렬 worktree** (가장 침습적인 병렬화를 마지막에). P0은 P1과 같은 PR로 묶어도 좋다.

---

## Phase 0 — 메시지 envelope + 내부 이벤트 버스 (pub/sub)

워커 통신의 오류 방지·전달 보장. pub/sub 구조를 차용하되 **경계를 명확히 한다**:

- **워커 ↔ 오케스트레이터: 요청-응답 유지 (pub/sub 아님).** 워커는 1회성 서브프로세스(`claude -p`, `codex exec`)라 구독이라는 개념이 성립하지 않고, 전송 채널(stdin/stdout)에 유실·재정렬이 없어 ack/재전송 메커니즘은 해결할 문제가 없는 복잡도다. 외부 브로커(Redis/NATS) 도입도 같은 이유로 하지 않는다. 여기에 도입하는 것은 envelope(exchange_id) 기반 **상관관계 추적 + 응답 진위 검증**이다.
- **오케스트레이터 내부: 이벤트 버스로 pub/sub 차용.** 현재 콜백 체인으로 꿰어져 있는 onProgress와 직접 쓰기 방식의 conversation/timeline 로그를, 토픽 기반 in-process 이벤트 버스의 **구독자**로 재편한다. P4 병렬화(여러 태스크가 동시에 이벤트 발행)와 로드맵의 웹 대시보드(실시간 스트림 = 구독)의 기반이 된다.

### 설계 A — 내부 이벤트 버스

**1. 신규 `src/orchestration/eventBus.ts`** (in-process, 외부 의존성 없음)
- 토픽: `run:<runId>`, `project:<projectId>` (+ 와일드카드 구독)
- 메시지 = envelope: `{ seq, ts, topic, stage, actor, kind, exchangeId?, payload }` — 발행 시 버스가 토픽별 단조 seq 발급
- 발행자: workflow 스테이지, 워커 호출 래퍼, verifier, 프로젝트 루프
- 구독자:
  - ConversationLog writer (`conversation.jsonl` append) — 로그 파일은 버스의 **내구성 있는 구독 결과물**이 됨
  - timeline writer (`timeline.jsonl`)
  - CLI/REPL 진행 표시 (기존 onProgress 콜백 체인을 구독으로 대체, 외부 API는 호환 유지)
  - (후속) HTTP SSE `/runs/{id}/events` → 웹 대시보드 실시간 스트림
- 구독자 에러는 격리 (한 구독자의 throw가 루프를 죽이지 않음 — 현재 emit()의 try/catch 정책 계승)

### 설계 B — 워커 요청-응답 envelope

**1. exchange_id (요청-응답 상관관계 + 에코 검증)**
- 형식: `<runId 축약>-r<round>-<stage>[-<perspective>]-<rand4>` — 사람이 읽을 수 있게 (예: `0611a-r2-review-security-k3f9`)
- 모든 워커 프롬프트 상단에 envelope 블록으로 포함
- **JSON 산출 스테이지**(plan / review / decompose / clarify / replan)는 출력 계약에 "최상위에 `exchange_id` 필드를 그대로 에코하라"를 추가
  - 검증: `extractJson` 결과의 `exchange_id`가 요청값과 불일치 또는 누락 → 1회 재시도 → 재실패 시 `protocol_error`로 명시 실패 (잘못된 페이로드를 조용히 소비 금지)
  - 기존 fallbackPlan/fallbackReview 산출물에도 exchange_id 주입 (검증 경로 단일화)
- **파일 편집 스테이지**(implement / repair)는 출력이 JSON이 아니라 git diff로 수확되므로 에코 검증 대상 아님 — envelope은 추적용으로만 포함
- verifier(셸)는 대상 아님

**2. seq (토픽별 단조 증가 시퀀스)**
- 이벤트 버스가 발급한 `seq`가 `conversation.jsonl` / `timeline.jsonl` 이벤트에 그대로 기록됨
- 목적: P2/P4 병렬화 시 ms 타임스탬프 충돌과 무관한 결정적 이벤트 순서, 향후 resume/replay 기반

**3. 아티팩트 바인딩**
- `plan.json` / `review.r<N>.json` 등 JSON 아티팩트에 `_meta: { runId, round, exchangeId }` 추가
- repair 프롬프트 조립 시 `_meta.round`가 직전 라운드와 일치하는지 검사 → 라운드 간 stale 아티팩트 소비를 구조적으로 차단

**4. 스키마/로그 반영**
- conversation 이벤트 meta에 `exchangeId` 포함 → prompt 이벤트와 response 이벤트가 ID로 연결됨 (현재는 ts/stage/round로 추정)
- `protocol_error`는 conversation에 `kind: "error"` + 별도 카운터로 final_report에 표시

### 테스트
- 에코 누락/불일치 → 재시도 → protocol_error 경로
- 버스: 토픽별 seq 단조성 (병렬 발행 시뮬레이션), 구독자 에러 격리, 구독 결과물(conversation.jsonl)이 기존 스키마와 호환
- stale 라운드 아티팩트 거부

---

## Phase 1 — 작업 카테고리 라우팅 + 단계별 워커/모델 지정

OmO의 "카테고리 지정 → 모델 자동 할당" (quick/deep/ultrabrain) 패턴.

### 설계

**1. WorkerInput에 `model?: string` 추가** (`src/workers/Worker.ts`)
- ClaudeWorker: `model` 있으면 args에 `--model <m>` 추가
- CodexWorker: `-m <m>` 추가
- CursorWorker/MockWorker: 무시(로그만)

**2. config에 `routing` 섹션 추가** (`src/config/schema.ts`)

```jsonc
{
  "routing": {
    // 단계별 기본 워커/모델. 미지정 시 현재 하드코딩과 동일 (claude=plan/review, codex=implement/repair)
    "stages": {
      "plan":      { "worker": "claude", "model": "opus" },
      "implement": { "worker": "codex" },
      "review":    { "worker": "claude", "model": "sonnet" },
      "repair":    { "worker": "codex" },
      "decompose": { "worker": "claude" }
    },
    // 카테고리별 오버라이드. 백로그 task의 category가 매칭되면 해당 stage 설정을 덮어씀
    "categories": {
      "quick": {
        "implement": { "worker": "claude", "model": "haiku" },
        "review":    { "worker": "claude", "model": "haiku" },
        "maxRounds": 2
      },
      "deep": {
        "implement": { "worker": "codex", "model": "gpt-5.5-codex" },
        "maxRounds": 5
      }
    }
  }
}
```

**3. 라우팅 해석기** — 신규 `src/orchestration/routing.ts`

```
resolveStage(stage, category, config, workerSet) → { worker, model?, maxRounds? }
```

해석 순서: `categories[category][stage]` → `stages[stage]` → 기존 하드코딩 기본값.
지정된 워커가 disabled면 명시적 에러 (조용한 폴백 금지 — 기존 fallbackPlan/fallbackReview는 "claude 자체가 disabled"일 때만 그대로 동작).

**4. 카테고리 부여**
- `BacklogTask`에 `category: "quick" | "standard" | "deep"` 추가 (`src/project/types.ts`)
- `decompose.claude.md` 프롬프트에 category 산정 기준 추가 (기존 `estimated_complexity`와 정합: trivial/small→quick, large/risky→deep)
- 단일 태스크 모드(`run`): `--category` CLI 플래그 + task.md frontmatter(`category: quick`) 지원, 기본 standard
- 폴백 분해기는 전부 standard

**5. runWorkflow 변경** (`src/orchestration/runWorkflow.ts`)
- `runPlanner`/`runReviewer`/implement/repair 호출부가 고정 `workers.claude`/`workers.codex` 대신 `resolveStage()` 결과 사용
- `category`를 `RunWorkflowOptions`에 추가, `runProject`가 task.category 전달
- conversation.jsonl 이벤트 meta에 `{ worker, model, category }` 기록 (감사 추적)

### 테스트
- routing.test.ts: 해석 우선순위, disabled 워커 에러
- workflow.test.ts 확장: MockWorker 2개로 카테고리별 라우팅 검증

---

## Phase 2 — 다중 리뷰 패널 (OmO hyperplan식 적대적 검증)

### 설계

**1. config** (`verifier`와 동급의 `review` 섹션 신설)

```jsonc
{
  "review": {
    "panel": {
      "enabled": false,               // 기본 off — 기존 동작 보존
      "perspectives": [
        { "name": "correctness", "focus": "로직 오류, 엣지 케이스, 회귀" },
        { "name": "security",    "focus": "입력 검증, 인증/인가, 시크릿 노출" },
        { "name": "testing",     "focus": "테스트 커버리지, 깨지기 쉬운 테스트" }
      ],
      "decision": "strict",           // strict: 1명이라도 request_changes면 request_changes
                                      // majority: 과반
      "trigger": "risky"              // always | risky (risk tag 검출 또는 diff > N파일일 때만 패널, 그 외 단일 리뷰)
    }
  }
}
```

**2. 실행** (`runWorkflow.ts`의 review 스텝)
- 패널 활성 시 N개 리뷰어를 `Promise.all`로 병렬 실행 (워커는 독립 서브프로세스라 현재 spawnUtil 그대로 병렬 안전)
- 각 리뷰어 프롬프트 = 기존 `review.claude.md` + perspective focus 주입 (템플릿 변수 `{{PERSPECTIVE}}`)
- 카테고리 quick은 trigger와 무관하게 항상 단일 리뷰 (비용 제어)

**3. verdict 합산** — 신규 `src/orchestration/reviewPanel.ts`
- `requires_human_review` 1명이라도 → `requires_human_review` (안전 우선, decision 설정 무관)
- `request_changes`: strict=1명 이상 / majority=과반
- 나머지 → `approve`
- bugs/missing_tests/risks/recommended_fixes는 perspective 출처 태그를 달아 병합

**4. 아티팩트**
- `rounds/review.r<N>.<perspective>.json` (개별) + `rounds/review.r<N>.json` (병합 — 기존 스키마 유지)
- repair 프롬프트는 병합본만 소비 → repair 로직 무변경

### 테스트
- reviewPanel.test.ts: 합산 규칙 (strict/majority/escalation 우선)
- MockWorker로 패널 3명 중 1명 reject 시나리오

---

## Phase 3 — 인터뷰 플래너 + 완주 루프

### 3a. 인터뷰 플래너 (OmO Prometheus식)

분해 전에 스펙의 모호함을 표면화한다.

**1. 신규 프롬프트** `src/project/prompts/clarify.claude.md`
- 입력: spec
- 출력 JSON: `{ "questions": [{q, why, default_assumption}], "assumptions": [...], "ready": bool }`

**2. 모드** — config `project.interview: "off" | "auto" | "required"` (기본 off)
- `auto`: 질문이 있으면 각 질문의 `default_assumption`을 채택하고, 스펙에 `## Assumptions (auto-adopted)` 섹션으로 명시 후 진행. timeline에 `assumptions_adopted` 이벤트 기록
- `required`: 질문이 있으면 중단. CLI는 신규 exit code **14** + 질문 목록 출력, MCP/HTTP는 `status: "needs_clarification"` + questions 반환 → 호출자가 답을 스펙에 반영해 재호출. chat REPL은 인라인으로 질문하고 답을 받아 스펙에 병합 후 진행

**3. 산출물**: `projects/<id>/clarification.json`

### 3b. 완주 루프 (OmO Ralph Loop식 — 단, 예산 내에서)

현재: 태스크 실패 → 동일 태스크 재시도(maxAttemptsPerTask) → 소진 시 stopped_blocked/failures로 종료.
개선: 종료 직전에 **재계획(replan)** 단계를 넣어 접근을 바꿔서 끝까지 민다.

**1. 신규 프롬프트** `src/project/prompts/replan.claude.md`
- 입력: 실패/블록 태스크들 + 각 final_report 요약 + 실패 에러 테일 + 현재 backlog
- 출력 JSON: 실패 태스크를 대체할 새 태스크들(분할 또는 대안 접근) + 어떤 태스크를 대체하는지(`replaces`)

**2. runProject 루프 변경** (`src/project/runProject.ts` — pickNextTask가 null이고 failed/blocked가 남았을 때)
- `replanCount < project.maxReplans` (기본 0 = off, 권장 2)이면 replan 실행
- 새 태스크는 backlog에 append (id에 `R<n>-` 접두), 대체된 태스크는 `superseded` 상태(신규) 표시
- timeline에 `replanned` 이벤트 + `projects/<id>/replan.<n>.json` 아티팩트

**3. 정체(stall) 감지**
- 실패 시그니처 = (task가 건드린 파일 집합 + verifier 실패 커맨드 + exit code) 해시
- replan 후 동일 시그니처로 다시 실패하면 해당 계열은 더 이상 replan하지 않고 종료 (무한 루프 방지)

**4. 절대 불변 조건**
- 예산(maxTasks/wall-clock/consecutiveFailures)은 replan보다 항상 우선
- `needs_approval` 태스크는 replan 대상에서 제외 — 사람 승인 게이트를 우회하는 재계획 금지

### 테스트
- replan 시나리오: fail → replan → 새 태스크 성공 / 동일 시그니처 재실패 → 중단
- interview 모드 3종 각각의 분기

---

## Phase 4 — 병렬 태스크 실행 + git worktree 격리

가장 침습적이라 마지막. 의존성 그래프(`depends_on`)는 이미 있으므로 스케줄러와 실행 루프만 바꾼다.

### 설계

**1. 스케줄러** (`src/project/scheduler.ts`)
- `pickReadyTasks(backlog, limit): BacklogTask[]` 신설 (기존 `pickNextTask`는 limit=1 케이스로 유지)
- **경로 중첩 가드**: 동시 실행 후보들의 `allowed_paths` glob이 겹치면 뒤 태스크는 이번 웨이브에서 제외 (충돌 사전 차단). allowed_paths가 없는 태스크는 전체 경로로 간주 → 단독 실행

**2. worktree 매니저** — 신규 `src/orchestration/worktree.ts`
- `createTaskWorktree(repoRoot, taskId)`: `git worktree add <repoRoot>/.orchestrator/worktrees/<taskId> -b orch/task/<taskId>` (base = 현재 HEAD)
- 태스크 실행 시 해당 worktree 경로를 `config.projectRoot`로 주입해 `runWorkflow` 호출 — 기존 파이프라인(diff 캡처, verifier, 안전 검사)이 worktree 안에서 그대로 동작
- 성공 시: worktree 브랜치에서 auto-commit → base 브랜치로 `git merge --no-ff` (또는 squash). **머지 충돌 시 태스크를 `failed`(reason: merge_conflict)로 처리하고 재큐잉 → 다음 시도는 갱신된 HEAD 기반 새 worktree에서 단독(직렬) 실행**
- 종료 시: `git worktree remove` + 브랜치 정리. orphan worktree는 프로젝트 시작 시 `git worktree prune`

**3. 동시성 제어** (`src/project/runProject.ts`)
- config `project.maxParallelTasks` (기본 **1** — 기존 동작과 완전 동일, 안전한 롤아웃)
- 메인 루프를 wave 방식이 아닌 **슬롯 방식**으로: 실행 중 태스크 Map 유지, 하나 끝날 때마다(`Promise.race`) reconcile 후 슬롯 채움 — 가장 느린 태스크에 전체가 묶이지 않음
- **backlog/state/timeline 쓰기는 코디네이터 루프 단일 스레드에서만** 수행 (태스크 완료 콜백에서 직접 쓰지 않음) → 동시 쓰기 없음
- 예산 체크는 슬롯 채우기 전마다 수행. 예산 초과 시 신규 슬롯 중단, 실행 중인 것은 완료 대기

**4. 진행 표시**
- ProjectProgressEvent에 `task_starting/finished`가 이미 있으므로 REPL/CLI는 `[T03|implement r1]`처럼 taskId 접두로 멀티플렉싱 출력

**5. 제약 (1차 범위에서 제외)**
- `autoCommitBetweenTasks=false`와 병렬 모드 동시 사용 금지 (config 검증에서 거부)
- 비-git projectRoot에서 maxParallelTasks>1 금지
- pre-verifier(npm install)는 worktree마다 독립 실행 — node_modules 공유 최적화는 후속

### 테스트
- scheduler: 경로 중첩 가드, 슬롯 채우기
- worktree: 임시 git repo에서 생성→커밋→머지→정리, 충돌 시나리오
- 통합: MockWorker 2태스크 병렬 → 둘 다 머지 확인

---

## 마이그레이션 / 호환성

- 모든 신규 config는 optional + 기본값이 기존 동작과 동일 (`routing` 미지정 = 현재 하드코딩, `panel.enabled=false`, `interview=off`, `maxReplans=0`, `maxParallelTasks=1`)
- 기존 config 파일은 수정 없이 그대로 동작 (zod `.strict()`라 신규 필드는 스키마에만 추가)
- 신규 exit code: **14** (needs_clarification, project 모드)
- README: 각 Phase 머지 시 해당 섹션 갱신

## Phase별 예상 작업량

| Phase | 신규 파일 | 수정 파일 | 리스크 |
| --- | --- | --- | --- |
| P0 envelope+버스 | eventBus.ts | conversationLog, runWorkflow, runProject, jsonExtract(에코 검증), 프롬프트 5종 | 낮음 |
| P1 라우팅 | routing.ts | schema, Worker 3종, runWorkflow, types, decompose 프롬프트, cli | 낮음 |
| P2 리뷰 패널 | reviewPanel.ts | schema, runWorkflow, review 프롬프트 | 낮음 |
| P3 인터뷰+완주 | clarify/replan 프롬프트, 시그니처 유틸 | schema, runProject, scheduler(상태 추가), cli/mcp/http | 중간 |
| P4 병렬 worktree | worktree.ts | scheduler, runProject(루프 재작성), schema, git.ts | 높음 |
