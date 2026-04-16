# 작업 진행 로그 — codebase-memory-sync

> **최초 작성**: 2026-04-17  
> **프로젝트**: 사내 코드 분석 지식 저장소 (CMS)  
> **목표**: SCIP 기반 중앙 공유 코드 인덱스 + MCP/REST 노출

---

## 배경 요약

사내 500+ 저장소의 코드 분석 결과를 중앙에 저장하고 LLM 에이전트 및 개발 도구에서 재사용하기 위한 플랫폼 구축.  
권장 아키텍처는 **Option D (SCIP 중심 자체 스택)** — 자세한 내용은 [`architecture-plan.md`](./architecture-plan.md) 참조.

---

## 완료된 작업

### Phase 0 — 초기 구현 (2026-04-16)
**커밋**: `895078d feat: Phase 0 SCIP 중심 코드 분석 지식 저장소 초기 구현`

#### 핵심 성과

| 항목 | 내용 |
|------|------|
| 검증 결과 | typecheck 0 errors, vitest 6/6 pass, E2E 6/6 pass |
| 신규 파일 | 43개, +6,431 lines |

#### 구현 내역

**`packages/core-service`** — REST API 게이트웨이 (TypeScript + Fastify)

| 파일 | 역할 |
|------|------|
| `src/routes/upload.ts` | `POST /v1/scip/upload` — SCIP blob 수신, 멱등 처리, CI-wins 충돌 규칙 |
| `src/routes/indexes.ts` | `GET /v1/repos/:id/indexes` — 인덱스 상태 폴링 |
| `src/routes/repos.ts` | `GET /v1/repos` — 저장소 목록 (초안) |
| `src/routes/search.ts` | `GET /v1/search` — 심볼 FTS 검색 (초안) |
| `src/routes/health.ts` | `GET /healthz` |
| `src/services/conflict.ts` | CI-wins 충돌 판정 서비스 |
| `src/storage/postgres.ts` | DB 연결 및 쿼리 헬퍼 |
| `src/storage/minio.ts` | SCIP blob 저장/조회 (MinIO/S3) |
| `src/auth/bearer.ts` | Bearer token 인증 미들웨어 |
| `src/storage/schema.sql` | Postgres 스키마 (repos, indexes, symbols, occurrences, repo_head, upload_receipts, audit_log) |

**`packages/scip-processor`** — SCIP → Postgres materialization worker

| 파일 | 역할 |
|------|------|
| `src/parser.ts` | SCIP protobuf 파싱 (`@sourcegraph/scip` 기반) |
| `src/materialize.ts` | symbols + occurrences bulk INSERT (full replace 방식) |
| `src/worker.ts` | LISTEN/NOTIFY 기반 비동기 처리 루프 |
| `test/fixtures/build-hello-scip.ts` | 테스트용 SCIP fixture 생성기 |

**`packages/ci-lib`** — Jenkins 공통 라이브러리 스캐폴딩

| 파일 | 역할 |
|------|------|
| `jenkins/vars/cmsIndex.groovy` | `cmsIndex()` shared step — SCIP 생성 + 업로드 |
| `jenkins/resources/run.sh` | Docker 기반 SCIP indexer 실행 래퍼 |
| `docker/scip-java.Dockerfile` | scip-java 인덱서 이미지 |

**인프라**

- `docker-compose.yml` — PostgreSQL 15 + MinIO 로컬 개발 환경
- `scripts/bootstrap.sh` — DB 스키마 초기화
- `scripts/make-fixture.sh` — 테스트 SCIP fixture 생성
- `scripts/e2e.sh` — 업로드 → 파싱 → 조회 End-to-End 검증

---

### Phase 1 — MCP 서버 MVP + core-service REST 확장 (2026-04-17)
**커밋**: `563bb18 feat: Phase 1 MCP 서버 MVP — 3개 tool + core-service REST 확장`

#### 핵심 성과

| 항목 | 내용 |
|------|------|
| 검증 결과 | typecheck 0 errors, vitest 34/34 pass |
| 신규 파일 | 25개, +1,903 lines |

#### 구현 내역

**`packages/core-service` — REST 확장**

| 변경 파일 | 내용 |
|----------|------|
| `src/routes/repos.ts` | `GET /v1/repos` — `json_agg` 기반 N+1 없는 레포 목록 + head 정보 반환 |
| `src/routes/symbols.ts` | `GET /v1/symbols?scip_symbol=` — 심볼 상세 + occurrences 반환 (신규) |
| `src/routes/search.ts` | `$1:*` SQL 버그 수정, `kind` 파라미터 필터 추가 |
| `src/server.ts` | symbols 라우트 등록 추가 |
| `test/helpers/build-app.ts` | 테스트용 Fastify 앱 팩토리 |
| `test/routes/repos.test.ts` | 라우트 통합 테스트 (app.inject 기반) |
| `test/routes/search.test.ts` | 검색 통합 테스트 |
| `test/routes/symbols.test.ts` | 심볼 상세 통합 테스트 |

**`packages/mcp-server`** — MCP stdio 서버 (신규 패키지)

| 파일 | 역할 |
|------|------|
| `src/server.ts` | `@modelcontextprotocol/sdk` 기반 stdio transport 서버, tool 3개 등록 |
| `src/client.ts` | core-service REST 호출 클라이언트 |
| `src/format.ts` | MCP text 응답 포맷팅 유틸 |
| `src/tools/list-projects.ts` | `list_projects` — 전체 레포 + head 정보 텍스트 포맷 |
| `src/tools/search-symbols.ts` | `search_symbols` — 심볼 FTS 검색, repo/lang/kind 필터 지원 |
| `src/tools/get-symbol-detail.ts` | `get_symbol_detail` — SCIP 심볼 상세 + references 목록 |
| `test/tools/*.test.ts` | pure handler 단위 테스트 (의존성 주입 방식) 15개 |
| `test/server.integration.test.ts` | MCP Client SDK roundtrip 통합 테스트 4개 |

**MCP Tool 명세 (MVP 3개)**

| Tool | 입력 | 출력 |
|------|------|------|
| `list_projects` | `{ query? }` | 저장소 목록 + 최신 색인 커밋 |
| `search_symbols` | `{ query, repo?, lang?, kind?, limit? }` | 심볼 목록 (파일·라인 포함) |
| `get_symbol_detail` | `{ scip_symbol, repo? }` | 상세 정의, 시그니처, 문서, references |

---

### 기타 설정 작업 (2026-04-17)

**`mcp__codeatlas*` 도구 비활성화 (이 프로젝트 한정)**

- `codeatlas`는 `~/.mcp.json`에 user-scope로 등록된 형제 프로젝트 MCP 서버
- `~/.claude.json`의 `disabledMcpServers` 배열에 `"codeatlas"` 추가하여 이 프로젝트에서만 로드 차단
- 결과: `/context` 기준 MCP tools가 26개 → 2개(Context7)로 감소

---

### Phase 2a — MCP tool 2개 추가 (2026-04-17)
**커밋**: `91f34da feat: Phase 2a MCP tools — get_symbol_references + get_file_overview`

#### 핵심 성과

| 항목 | 내용 |
|------|------|
| 검증 결과 | typecheck 0 errors, vitest 62/62 pass (core-service 24, scip-processor 6, mcp-server 32) |
| 신규 파일 | 8개 |

#### 구현 내역

**`packages/core-service` — REST 추가**

| 파일 | 역할 |
|------|------|
| `src/routes/symbol-references.ts` | `GET /v1/symbols/references?scip_symbol=&repo?&include_definitions?&limit?` |
| `src/routes/file-overview.ts` | `GET /v1/files/overview?repo=&file_path=&commit?` |
| `src/server.ts` | 2개 route 등록 추가 |
| `test/routes/symbol-references.test.ts` | 라우트 통합 테스트 8개 |
| `test/routes/file-overview.test.ts` | 라우트 통합 테스트 7개 |

**`packages/mcp-server` — MCP tool 추가**

| 파일 | 역할 |
|------|------|
| `src/tools/get-symbol-references.ts` | `get_symbol_references` pure handler |
| `src/tools/get-file-overview.ts` | `get_file_overview` pure handler |
| `src/client.ts` | `getSymbolReferences()`, `getFileOverview()` + 관련 타입 추가 |
| `src/server.ts` | 2개 tool 등록 추가 |
| `test/tools/get-symbol-references.test.ts` | 단위 테스트 6개 |
| `test/tools/get-file-overview.test.ts` | 단위 테스트 5개 |
| `test/server.integration.test.ts` | 2개 roundtrip case 추가 |

**MCP Tool 명세 (Phase 2a 추가)**

| Tool | 입력 | 출력 |
|------|------|------|
| `get_symbol_references` | `{ scip_symbol, repo?, include_definitions?, limit? }` | occurrence 목록 (file:line + role) |
| `get_file_overview` | `{ repo, file_path, commit? }` | 파일 내 심볼 목록 (start_line 순서) |

**보류 결정**
- `read_symbol_body`, `read_file_range` — 원본 소스 저장 파이프라인 없음 → Phase 2c 별도 설계
- `find_implementors`, `get_dependencies`, `get_impact_analysis` — SCIP relationships 파싱 + `symbol_relationships` 테이블 필요 → Phase 2b

---

### Phase 2b — SCIP relationships + MCP tool 3개 추가 (2026-04-17)
**커밋**: (pending)

#### 핵심 성과

| 항목 | 내용 |
|------|------|
| 검증 결과 | typecheck 0 errors, vitest 109/109 pass (scip-processor 13, core-service 46, mcp-server 50) |
| 신규 파일 | 16개 |

#### 구현 내역

**`packages/scip-processor` — SCIP relationships 파싱**

| 파일 | 역할 |
|------|------|
| `src/parser.ts` | `ParsedRelationship` 인터페이스 + `ParsedIndex.relationships` 필드 + 파싱 루프 추가 |
| `src/materialize.ts` | `symbol_relationships` 삭제 + bulk-insert 블록 추가 |
| `test/parser.relationships.test.ts` | 관계 파싱 단위 테스트 5개 (신규) |
| `test/materialize.relationships.test.ts` | 관계 materialize 통합 테스트 2개 (신규) |

**`packages/core-service` — REST 라우트 3개 추가**

| 파일 | 역할 |
|------|------|
| `src/storage/schema.sql` | `symbol_relationships` 테이블 + 인덱스 4개 추가 |
| `src/routes/implementors.ts` | `GET /v1/symbols/implementors` — is_implementation 관계 기반 구현체 목록 (신규) |
| `src/routes/dependencies.ts` | `GET /v1/symbols/dependencies` — from_symbol 기반 직접 의존 목록 (신규) |
| `src/routes/impact.ts` | `GET /v1/symbols/impact` — 재귀 CTE + cycle detection, depth cap 5 (신규) |
| `src/server.ts` | 3개 route 등록 추가 |
| `test/routes/implementors.test.ts` | 통합 테스트 7개 (신규) |
| `test/routes/dependencies.test.ts` | 통합 테스트 7개 (신규) |
| `test/routes/impact.test.ts` | 통합 테스트 8개 (신규, depth/cycle 포함) |

**`packages/mcp-server` — MCP tool 3개 추가**

| 파일 | 역할 |
|------|------|
| `src/client.ts` | `ImplementorsResult`, `DependenciesResult`, `ImpactResult` 등 6개 타입 + 3개 메서드 추가 |
| `src/tools/find-implementors.ts` | `find_implementors` pure handler (신규) |
| `src/tools/get-dependencies.ts` | `get_dependencies` pure handler (신규) |
| `src/tools/get-impact-analysis.ts` | `get_impact_analysis` pure handler (신규) |
| `src/server.ts` | 3개 tool 등록 추가 |
| `test/tools/find-implementors.test.ts` | 단위 테스트 5개 (신규) |
| `test/tools/get-dependencies.test.ts` | 단위 테스트 5개 (신규) |
| `test/tools/get-impact-analysis.test.ts` | 단위 테스트 5개 (신규) |
| `test/server.integration.test.ts` | 3개 roundtrip case 추가, tool name assertion 8개로 확대 |

**MCP Tool 명세 (Phase 2b 추가)**

| Tool | 입력 | 출력 |
|------|------|------|
| `find_implementors` | `{ scip_symbol, repo?, limit? }` | 인터페이스 구현체 목록 (class/kind/file:line) |
| `get_dependencies` | `{ scip_symbol, repo?, limit? }` | 직접 의존 심볼 목록 (관계 타입 태그 포함) |
| `get_impact_analysis` | `{ scip_symbol, repo?, depth?, limit? }` | 역방향 재귀 의존 목록 (depth 레벨 포함) |

**보류 결정**
- `read_symbol_body`, `read_file_range` — 원본 소스 저장 파이프라인 없음 → Phase 2c 별도 설계

---

## 현재 상태

```
packages/
├── core-service/     ✅ REST API (upload, repos, symbols, symbol-references, file-overview, search,
│                                  indexes, health, implementors, dependencies, impact)
├── scip-processor/   ✅ SCIP → Postgres worker (relationships 파싱 포함)
├── mcp-server/       ✅ MCP stdio (list_projects, search_symbols, get_symbol_detail,
│                                  get_symbol_references, get_file_overview,
│                                  find_implementors, get_dependencies, get_impact_analysis)
└── ci-lib/           ✅ Jenkins shared library 스캐폴딩
```

### 테스트 커버리지 현황

| 패키지 | 테스트 수 | 종류 |
|--------|----------|------|
| `core-service` | 46개 | 라우트 통합 (app.inject) |
| `scip-processor` | 13개 | 단위 + E2E + 관계 통합 |
| `mcp-server` | 50개 | 단위 41개 + stdio roundtrip 통합 9개 |

---

## 다음 단계 (v1)

아키텍처 계획서 기준 v1 범위 (`+6–8주`):

| 항목 | 내용 | 우선순위 |
|------|------|---------|
| MCP tool 추가 | `read_symbol_body`, `read_file_range` (Phase 2c — 원본 소스 파이프라인 설계 필요) | 높음 |
| scip-typescript 지원 | Nuxt/Next 저장소 인덱싱 | 높음 |
| Memory tools | `write/read/list/edit/delete_memory` (저장소 단위 공유 노트) | 중간 |
| Zoekt 사이드카 | `code_search` tool — 전문 텍스트/regex 검색 | 중간 |
| Web UI | Monaco 기반 심볼 검색 UI (`packages/web-ui/`) | 낮음 |
| Serena fallback uploader | `packages/serena-uploader/` Python 플러그인 | 낮음 |
| GraphQL endpoint | REST와 병렬 운영 | 낮음 |
| GHA shared workflow | GitHub Actions 버전 (`ci-lib` 추가) | 중간 |

---

## 참고 링크

- [아키텍처 계획서](./architecture-plan.md) — 설계 결정 근거, 기각 옵션, 마일스톤
- [ci-lib README](../packages/ci-lib/README.md) — Jenkins 통합 가이드
