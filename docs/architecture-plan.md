# 사내 코드 분석 지식 저장소 — 아키텍처 계획서

> **작성일**: 2026-04-16  
> **상태**: 리뷰 중 (v0.1)

---

## 1. 배경 및 목적

### 1.1 현황
- 사내 소스 저장소 500+개, 개발 인력 100+명
- 주요 스택: Java (Spring, JPA, MyBatis), Oracle/MySQL, Nuxt.js/Next.js (TypeScript)
- 코드 분석 결과의 공유·재사용 체계 없음

### 1.2 목표 플로우

```
개발자 / LLM 에이전트
    │
    ▼
[공용 지식 저장소] ──조회──▶ 결과 반환 (HIT)
    │
    MISS
    │
    ▼
[클라이언트 (Serena MCP 등)] ──분석──▶ [공용 지식 저장소] ──저장
```

### 1.3 요구사항 (확정)

| 항목 | 결정 |
|------|------|
| 비용 | OSS + 자체 구축 (상용 제외) |
| 쓰기 주체 | CI primary + 클라이언트 fallback (Hybrid) |
| 노출 인터페이스 | MCP 서버, 코드검색 Web UI, REST/GraphQL API |
| CI 표준화 | 높음 (공통 Jenkins/GHA 템플릿 존재) |

---

## 2. Prior Art 리서치

### 2.1 해외 빅테크 사내 시스템

#### Meta — Glean (2024.12 오픈소스)
- **역할**: 소스코드 사실(fact) 수집·파생·쿼리 시스템
- **저장**: RocksDB + Angle 쿼리 언어
- **상위 레이어**: `Glass` 심볼 서버 (코드 네비게이션 API 추상화)
- **용도**: 코드 브라우징, 검색, 문서 생성
- **⚠️ 제약**: 공식 Java/Kotlin/TypeScript indexer 없음 → **본 건 비적합**

#### Google — Kythe (오픈소스)
- **역할**: 사내 코드 index/cross-reference
- **방식**: 빌드 시스템 계측(instrumented) → 언어 불문 graph schema
- **⚠️ 제약**: 빌드 시스템 깊은 커스터마이징 필요

#### 표준 포맷 흐름
```
LSIF (Microsoft 제안, 2019)
    │
    ▼
SCIP (Sourcegraph, 2022) ← 2026 현재 사실상 표준
    │
    ├── scip-java      (Gradle/Maven/sbt 플러그인, 기성품)
    ├── scip-typescript (기성품)
    └── scip-ctags     (범용, 경량)
```

---

### 2.2 상용 솔루션

#### Sourcegraph
- 코드 검색 + Code Graph 플랫폼. 멀티 코드호스트 통합
- SCIP 업로드 모델 지원 — 본 건 설계와 가장 유사한 구조
- **⚠️ 2026년 유료 전환**: $49/user/월 → 100명 기준 연 약 **7,800만원**
- **→ 완전 제외 확정**

#### Qodo
- AI 코드리뷰, 수천 repo 인덱싱 가능
- 유료 SaaS → 제외

---

### 2.3 LLM / MCP 시대 OSS 도구 (2025–2026)

| 도구 | 특징 | 평가 |
|------|------|------|
| **Serena MCP** | LSP 기반, HTTP 모드 지원, Tantivy 로컬 캐시 | 개인/에이전트 IDE. 중앙 공유 구조 ✗ |
| **codebase-memory-mcp** | 단일 바이너리, 로컬 SQLite, 66개 언어 | 로컬 전용. 중앙 공유 ✗, SCIP ✗, REST ✗ |
| **codeatlas** | 사내 형제 프로젝트, 단일 프로젝트용 MCP, 24개 tool | **tool surface 계약 계승 활용 가능** |
| **CodeMCP** | CLI/HTTP/MCP — 심볼, 임팩트, 아키텍처 | 소규모 래퍼 |

---

### 2.4 OSS 코드검색 엔진

| 도구 | 특징 | 비고 |
|------|------|------|
| **OpenGrok** (Oracle) | 60+ 언어, 10년+ 운영 (Oracle, Red Hat), Tomcat 기반 | 안정, UI 구형, 시맨틱 ✗ |
| **Zoekt** (Google/Sourcegraph) | Sourcegraph 내부 trigram 엔진, 최고속 | 텍스트/regex 전용, 시맨틱 ✗ |
| **Hound** (Etsy) | 단순, 빠름 | 단일 서버 한계, 소규모용 |

> 모두 텍스트 검색 전용 → 시맨틱(symbol navigation)은 SCIP 계층 별도 필요

---

### 2.5 국내 기업 사례

| 기업 | 시스템 | 공개 수준 |
|------|--------|----------|
| 삼성 | `code.iSR` — 사내 코드 기반 코딩 AI (LLM) | 블로그 수준, 아키텍처 미공개 |
| 네이버 | HyperCLOVA X 코드 자동완성 | LLM 중심, 코드 지식 저장소 별도 공개 ✗ |
| 카카오 | TestBot (코드 스멜/버그/취약점), 자동 리뷰어 할당 Chrome Extension | 파편화 도구, 중앙 지식 저장소 ✗ |

> **관찰**: 국내 대형 기술기업 중 "전사 중앙 코드 지식 저장소" 아키텍처를 공개한 사례 희소.

---

## 3. Serena MCP 중앙 백본 검토 (Option E)

> 사용자 추가 요청: Serena MCP 기반 신규 구축 가능성 검토

### 3.1 Serena MCP 실체

| 항목 | 현황 |
|------|------|
| Transport | stdio + **HTTP streamable** 모두 지원 |
| 인덱스 저장 | LSP 기반 + Tantivy 로컬 캐시 (프로젝트당) |
| SCIP/LSIF 입출력 | ✗ 없음 |
| 멀티테넌시 / Auth / 쿼터 | ✗ 없음 (단일 워크스페이스 전제 설계) |
| 중앙 공유 인덱스 | ✗ 개념 없음 |
| 쓰기 도구 | `replace_symbol_body`, `insert_before/after_symbol` 등 포함 |
| Java LSP | Eclipse JDT Language Server (프로젝트당 프로세스 1개 상주) |

### 3.2 Option E 가상 아키텍처

```
Router/LB (repo hash → sticky)
    │
    ▼
Serena Worker Farm (N 노드)
  - 각 노드: serena-mcp-server --transport http --project /repos/<one>
  - LSP 프로세스 상주 (Java JDT LS, tsserver ...)
  - Tantivy 인덱스 → 공유 NFS/EFS 마운트
    │
    ▼
공유 인프라
  - Redis: "이 repo/commit 인덱스 요청" 큐
  - Auth/Proxy: OIDC sidecar (Serena 외부)
  - Postgres: 워커-repo 매핑, TTL 관리
    │
    ▼
Exposure (별도 게이트웨이로 자체 구현 여전히 필요)
  MCP / Web UI / REST API
```

### 3.3 Option E 장단점

| 기준 | Option D (SCIP 중심) | Option E (Serena 백본) |
|------|---------------------|----------------------|
| 아키텍처 적합성 | 설계 목적에 부합 | ⚠️ 로컬 개인 도구를 중앙 서버로 비틀기 |
| 500 repo 스케일 | blob+DB 수평 확장 용이 | ❌ 500 LSP 프로세스 필요 |
| Java JDT LS 메모리 | SCIP 생성 후 프로세스 종료 | ❌ repo당 2–8GB 상주 (100 hot = ~800GB) |
| CI primary 쓰기 | SCIP upload로 자연스러움 | ❌ SCIP import 없음, 직접 push 불가 |
| Cold-start | 파싱된 SCIP 즉시 응답 | ❌ LSP full load 수 분 |
| Web UI / REST | 자체 구현 | 자체 구현 (동일) |
| 표준 상호운용 | SCIP 표준 호환 | ❌ Serena 내부 포맷 lock-in |
| 쓰기 도구 위험 | 미노출 | ⚠️ 기본 tool에 쓰기 포함 → 별도 차단 필요 |
| 업스트림 의존 | CLI 호출만 | ❌ Serena 내부 API 변화에 민감 |
| 장애 격리 | worker stateless | ❌ LSP crash = 해당 repo 전체 down |
| MCP tool surface | 자체 구현 (codeatlas 계승) | ✓ 기성 24개 tool 즉시 활용 |
| **엔지니어링 총량** | **중간** | ❌ **D보다 많음** (멀티테넌트+auth+UI+REST 전부 외부 구현) |

### 3.4 기각 결론

- **Option E (풀 백본)**: ❌ 비권장 — 엔지니어링 총량 증가, 근본 설계 불일치
- **Option E' (cold-start 워커 한정)**: Serena → SCIP 변환이 비자명 → `scip-ctags` 대안으로 수렴, 실익 없음
- **Serena 활용 지점**: 클라이언트 fallback 업로더 플러그인(`cms-serena-uploader`)으로 한정

---

## 4. 권장 아키텍처 — Option D (SCIP 중심 자체 스택)

### 4.1 전체 구조

```
┌──────────────────────────────────────────────────────────────┐
│  WRITERS (Hybrid)                                            │
│  ┌─────────────────────────┐   ┌──────────────────────────┐  │
│  │  CI Pipeline (primary)  │   │  Client Fallback         │  │
│  │  - scip-java            │   │  Serena MCP              │  │
│  │  - scip-typescript      │   │  + cms-serena-uploader   │  │
│  │  - scip-ctags           │   │    (ensure check 후 upload)│ │
│  └──────────┬──────────────┘   └────────────┬─────────────┘  │
│             └──────────────┬────────────────┘                 │
│                            ▼                                  │
│                  POST /v1/scip/upload                         │
│          (Bearer token, idempotency key, CI-wins 규칙)        │
├──────────────────────────────────────────────────────────────┤
│  CORE SERVICE (cms-core, TypeScript + Fastify)               │
│                                                              │
│  ┌─────────────────┐   ┌──────────────────────────────────┐  │
│  │ MinIO / S3      │   │ Postgres 15                      │  │
│  │ SCIP blob 원본  │   │ repos, indexes, symbols,         │  │
│  │                 │   │ occurrences, repo_head, audit    │  │
│  └─────────────────┘   └──────────────────────────────────┘  │
│                                                              │
│  cms-scip-processor (worker)                                 │
│  @sourcegraph/scip → bulk materialize → Postgres            │
│                                                              │
│  (v1+) Zoekt 사이드카 — 텍스트/regex 검색                    │
├──────────────────────────────────────────────────────────────┤
│  READERS                                                     │
│  ┌───────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ MCP Server    │  │ REST/GraphQL    │  │ Web UI        │  │
│  │ (LLM 에이전트)│  │ (사내 도구 연동)│  │ (Next.js +   │  │
│  │               │  │                 │  │  Monaco)      │  │
│  └───────────────┘  └─────────────────┘  └───────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 컴포넌트 목록

| # | 이름 | 역할 | 기술 스택 |
|---|------|------|----------|
| C1 | `cms-core` | REST/GraphQL 게이트웨이, 업로드, 쿼터 | TypeScript + Fastify |
| C2 | `cms-scip-processor` | SCIP → Postgres materialize worker | TypeScript + `@sourcegraph/scip` |
| C3 | `cms-mcp-server` | MCP stdio/HTTP 서버 | TypeScript + `@modelcontextprotocol/sdk` |
| C4 | `cms-web-ui` | 검색/심볼 네비게이션 UI (v1+) | Next.js 14 + Monaco Editor |
| C5 | `cms-zoekt` | 전문 텍스트 검색 사이드카 (v1+) | Go — upstream Zoekt 무수정 |
| C6 | `cms-ci-lib` | Jenkins/GHA 공용 스크립트 + scip Dockerfile | Shell/Docker |
| C7 | `cms-serena-uploader` | Serena fallback 업로더 플러그인 (v1+) | Python |

---

### 4.3 Postgres 스키마 (요약)

```sql
-- 저장소 등록
repos (id uuid pk, org, name, default_branch, primary_lang, ...)

-- 인덱스 메타 (unique: repo_id + commit_sha + tool)
indexes (id, repo_id, commit_sha, uploader[ci|client], tool, 
         blob_key, blob_sha256, status[pending|ready|failed], ...)

-- 심볼 정의 (commit별 full replace)
symbols (id, index_id, repo_id, commit_sha, scip_symbol,
         display_name, kind, language, file_path, start/end line/col,
         signature, doc)

-- 참조/출현 (SCIP SymbolRole bitmask)
occurrences (id, index_id, repo_id, commit_sha, scip_symbol,
             file_path, range, role)

-- 활성 커밋 포인터
repo_head (repo_id pk, branch, commit_sha, indexed_at)

-- 멱등 업로드 영수증
upload_receipts (idempotency_key pk, index_id, created_at)

-- 감사 로그
audit_log (ts, actor, action, repo_id, detail jsonb)
```

**설계 원칙**: 커밋별 `full replace` — 기존 `index_id` 행 DELETE → BULK INSERT. 증분 병합 없이 단순성 확보.

---

### 4.4 업로드 프로토콜

```
POST /v1/scip/upload
  Authorization: Bearer <CMS_CI_TOKEN>           # 정적 Bearer 토큰 (OIDC 미구현)
  X-CMS-Idempotency-Key: <{org}/{repo}:{commit}:{tool}:{uploader}>
  X-CMS-Uploader: ci | client
  Content-Type: multipart/form-data
  Fields:
    repo          — "{org}/{name}" 형식
    commit        — full SHA
    branch        — 브랜치명 (origin/ 접두사 제거)
    tool          — scip-java | scip-typescript | scip-ctags
    scip          — binary (.scip 파일)
    source        — binary (.zip 파일, CI: 필수 / client: 400 거부)

응답
  201  새로 생성
  200  멱등 재생 (이미 동일 업로드 존재)
  400  source 규칙 위반 (CI가 누락하거나 client가 포함)
  409  ci_wins (CI 인덱스 존재 시 client 거부)
  413  too large (>500MB)
```

**Conflict 규칙**: CI 업로드는 client 인덱스를 무조건 덮어씀. Client 업로드는 CI 인덱스 존재 시 409 반환.

> SCIP + source.zip 동일 요청 전송 설계 근거 → [ADR-014](./ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)

---

### 4.5 MCP Tool Surface

codeatlas의 tool 계약을 계승하되, 중앙 공유용으로 재구현.  
**쓰기 도구 (`rename_symbol`, `replace_symbol_body` 등)는 중앙 서버에서 노출하지 않음.**

#### MVP (3개)
| Tool | 입력 | 출력 |
|------|------|------|
| `list_projects` | `{ query? }` | 저장소 목록 + 최신 색인 커밋 |
| `search_symbols` | `{ query, repo?, kind?, limit? }` | 심볼 목록 (파일/라인 포함) |
| `get_symbol_detail` | `{ scip_symbol, repo? }` | 상세 정의, 시그니처, 문서 |

#### v1 (+ 8개)
`get_symbol_references`, `find_implementors`, `get_impact_analysis`,  
`get_file_overview`, `get_dependencies`, `read_symbol_body`,  
`read_file_range`, `code_search` (Zoekt 연동)

#### v1 Memory (5개)
저장소 단위 공유 노트: `write/read/list/edit/delete_memory`

#### v2 도메인 특화 (3개)
`find_mybatis_callers`, `get_jpa_entity_usage`, `get_spring_di_graph`

---

### 4.6 CI 통합 (Jenkins shared library)

```groovy
// packages/ci-lib/jenkins/vars/cmsIndex.groovy
def call(Map cfg = [:]) {
  def tool     = cfg.tool ?: detectTool()  // scip-java | scip-typescript | scip-ctags
  def endpoint = cfg.endpoint ?: env.CMS_ENDPOINT ?: 'http://localhost:3000'

  stage("CMS: SCIP index (${tool})") {
    def org      = env.ORG_NAME  ?: sh(script: 'basename $(dirname $(git remote get-url origin))', returnStdout: true).trim()
    def repoName = env.REPO_NAME ?: sh(script: 'basename $(git remote get-url origin) .git', returnStdout: true).trim()
    def commit   = env.GIT_COMMIT
    def branch   = env.GIT_BRANCH?.replaceAll('^origin/', '')
    def idemKey  = "${org}/${repoName}:${commit}:${tool}:ci"

    // 1. SCIP 인덱스 생성
    sh """
      docker run --rm -v "\$PWD:/work" \\
        registry.internal/cms/scip-indexer:${tool}-latest /run.sh
    """

    // 2. source.zip 생성 — 빌드 산출물·바이너리·VCS 제외 (ADR-014 제외 패턴)
    sh """
      zip -qr /work/source.zip . \\
        -x '.git/*' -x 'node_modules/*' -x 'target/*' -x 'build/*' \\
        -x 'dist/*' -x '.gradle/*' -x '.next/*' -x '.venv/*' \\
        -x '__pycache__/*' -x '*.jar' -x '*.class' -x '*.war' \\
        -x '*.png' -x '*.jpg' -x '*.pdf'
    """

    // 3. SCIP + source.zip 업로드
    sh """
      curl -fSs -X POST "${endpoint}/v1/scip/upload" \\
        -H "Authorization: Bearer \$CMS_CI_TOKEN" \\
        -H "X-CMS-Uploader: ci" \\
        -H "X-CMS-Idempotency-Key: ${idemKey}" \\
        -F "repo=${org}/${repoName}" \\
        -F "commit=${commit}" \\
        -F "branch=${branch}" \\
        -F "tool=${tool}" \\
        -F "scip=@index.scip" \\
        -F "source=@source.zip"
    """
  }
}
```

**업로드 트리거**: `default_branch`, `main/master/develop` push만. PR/MR는 빌드만 수행.  
**환경 변수**: `CMS_ENDPOINT` (기본값 `http://localhost:3000`), `CMS_CI_TOKEN` (Jenkins Credentials)

---

### 4.7 Serena Fallback 업로더 동작

```
개발자 Serena 호출
  │
  ├─ [1] Serena 로컬 SCIP 생성 (기존과 동일)
  │
  └─ [NEW] cms-serena-uploader 플러그인
        │
        ├─ GET /v1/repos/{org}/{repo}/heads?commit={sha}
        │     200 (있음) → skip, 로컬 Serena 결과만 사용
        │     204 (없음) → POST /v1/scip/upload (uploader=client)
        │                   409 ci_wins → silent skip
        │
        └─ CMS_ENDPOINT / CMS_TOKEN 미설정 시 플러그인 전체 off
```

---

### 4.8 Cold-start 정책

| 단계 | 정책 | 상세 |
|------|------|------|
| MVP | (A) fail-fast | 404 + Jenkins 빌드 링크 hint |
| v1 | (C) partial | scip-ctags로 30초 내 심볼 부분 인덱스 즉시 응답 + 백그라운드 full job |
| v2 | (B) auto-trigger | Jenkins API 자동 호출 + 202 polling |

---

### 4.9 MinIO 레이아웃

```
s3://cms-scip/
  {org}/{name}/{commit}/{tool}.scip       # SCIP 인덱스 (CI + client)
  {org}/{name}/{commit}/source.zip        # 원본 소스 아카이브 (CI 전용)
```

- `sha256`은 별도 파일이 아닌 `indexes.sha256` / `indexes.source_sha256` DB 컬럼에 저장
- 2-tier commit prefix(`{commit[:2]}`) 및 `_manifests/` 디렉토리는 미구현

> 상세 키 규칙 및 source 저장 정책 → [ADR-014](./ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)

---

## 5. 단계별 마일스톤

### MVP (4–6주) — "Java 파일럿 10개 리포에서 심볼 검색이 된다"

| 포함 | 제외 |
|------|------|
| Postgres + MinIO 기반 cms-core | Zoekt, Web UI(Monaco), Serena uploader |
| scip-java indexer | TypeScript 인덱싱 |
| 3개 MCP tool (`list_projects`, `search_symbols`, `get_symbol_detail`) | Cross-repo reference |
| Jenkins shared lib 초안 | v2 커스텀 분석기 |
| 단순 Web UI (검색창 + 결과 테이블) | GraphQL |

**합격 기준**
- commit push → queryable < 10분
- 멱등: 동일 CI 3회 재시도 → row 1개, blob 1개
- CI-wins: client 먼저 업로드 → CI 덮어쓰기 확인
- p95 search < 200ms (10 repo 기준)

---

### v1 (+6–8주) — "Java + TS, 전문 검색, 크로스 리포"

- scip-typescript 추가 (Nuxt/Next 저장소)
- Zoekt 사이드카 + `code_search` tool
- 나머지 7개 MCP tool 추가
- Serena fallback 업로더 (`cms-serena-uploader`)
- Monaco 기반 Web UI + cross-repo 검색
- GraphQL endpoint
- Memory tools (공유 노트)
- GHA shared workflow
- 50개 리포 rollout

---

### v2 (+8–12주) — "프레임워크 도메인 지식 (MyBatis / JPA / Spring)"

- `cms-analyzer-mybatis`: XML mapper 파싱 → Java method ↔ SQL ID 연결
- `cms-analyzer-jpa`: @Entity 그래프, @Query 분석
- `cms-analyzer-spring-di`: @Service/@Autowired/@Configuration 정적 해석
- Oracle/MySQL 스키마 수집기: 테이블 ↔ JPA entity ↔ MyBatis statement 연결
- Cold-start (B) Jenkins API auto-trigger
- 전사 500 repo default on

---

## 6. 레포 구조 제안

```
codebase-memory-sync/
├── docker-compose.yml              # Postgres + MinIO + cms-core (+ v1: zoekt)
├── .env.example
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── packages/
│   ├── core-service/               # C1
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── upload.ts       ← 핵심
│   │   │   │   ├── indexes.ts
│   │   │   │   ├── repos.ts
│   │   │   │   └── search.ts
│   │   │   ├── auth/oidc.ts
│   │   │   ├── storage/
│   │   │   │   ├── postgres.ts
│   │   │   │   ├── minio.ts
│   │   │   │   └── schema.sql      ← 핵심
│   │   │   ├── queue/notify.ts
│   │   │   └── services/conflict.ts
│   │   └── test/
│   │
│   ├── scip-processor/             # C2
│   │   ├── src/
│   │   │   ├── worker.ts
│   │   │   ├── parser.ts           ← 핵심
│   │   │   └── materialize.ts      ← 핵심
│   │   └── test/fixtures/          # .scip 샘플
│   │
│   ├── mcp-server/                 # C3
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── tools/
│   │   │       ├── list-projects.ts
│   │   │       ├── search-symbols.ts    ← 핵심 (MVP)
│   │   │       ├── get-symbol-detail.ts
│   │   │       ├── get-symbol-references.ts
│   │   │       ├── find-implementors.ts
│   │   │       ├── get-impact-analysis.ts
│   │   │       ├── code-search.ts       # v1+
│   │   │       └── memory/              # v1+
│   │
│   ├── web-ui/                     # C4 (v1+)
│   │
│   ├── ci-lib/                     # C6
│   │   ├── jenkins/
│   │   │   ├── vars/cmsIndex.groovy    ← 핵심
│   │   │   └── resources/run.sh
│   │   ├── github/workflows/cms-index.yml
│   │   └── docker/
│   │       ├── scip-java.Dockerfile
│   │       ├── scip-typescript.Dockerfile
│   │       └── scip-ctags.Dockerfile
│   │
│   ├── serena-uploader/            # C7 (v1+)
│   │   └── python/cms_serena_uploader/plugin.py
│   │
│   └── analyzers/ (v2)
│       ├── mybatis/
│       ├── jpa/
│       └── spring-di/
│
├── deploy/
│   ├── compose/
│   └── helm/ (v1+)
│
├── docs/
│   ├── architecture-plan.md        ← 이 문서
│   ├── api.md
│   ├── mcp-tools.md
│   └── runbook.md
│
└── scripts/
    ├── bootstrap-postgres.sh
    ├── seed-fixtures.sh
    └── e2e.sh
```

---

## 7. 기각된 옵션 요약

| 옵션 | 기각 사유 |
|------|---------|
| **Sourcegraph 도입** | 2026년 $49/user/월 유료 전환. 연 약 7,800만원 |
| **Meta Glean 내재화** | Java/Kotlin/TypeScript 공식 indexer 없음 |
| **Serena MCP 중앙 백본** | LSP 상주형, SCIP import 없음, 멀티테넌트 외부 구현 필요. 엔지니어링 D 이상 |
| **codebase-memory-mcp 그대로** | 로컬 전용 SQLite. 중앙 공유 구조 아님 |
| **Neo4j / Graphiti** | 초기 실험 흔적. 멀티테넌트·백업·HA는 Postgres 우위 |
| **Java 기반 core service** | MCP 생태계·`@sourcegraph/scip` Node 중심. thin service라 이득 작음 |
| **Conflict 병합** | 생성기 버전 편차로 merge 무의미 → CI-wins 단순화 |
| **업로드 시점 parse 생략** | 쿼리 latency 예측 불가 → 업로드 시 materialize 확정 |

---

## 8. 검증 계획

### MVP
- 파일럿 1개 repo Jenkins `cmsIndex()` 추가 → push → 10분 내 queryable
- `search_symbols({query:"OrderService"})` → 파일/라인 반환 확인
- CI-wins, 멱등, auth scope 오류 케이스

### v1
- TS repo 추가, cross-repo refs 정확도 검증
- Serena fallback E2E: CI 없는 repo → 클라이언트 업로드 → 질의 성공 → CI 도착 후 client row 교체
- Zoekt regex p95 < 500ms

### v2
- `find_mybatis_callers` 커버리지 ≥ 95%
- JPA entity usage 그래프 정확도
- 500 repo 전사 색인 후 운영 지표 기준 충족

### 상시
- `tests/e2e/` : docker-compose fixture 기반 upload → query full path
- `tests/golden/` : 특정 commit에 대한 symbols/occurrences 스냅샷 diff
- k6 부하: 업로드 100 concurrent, query 1,000 QPS

---

*끝*
