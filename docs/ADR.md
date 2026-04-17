# Architecture Decision Records

## 철학

MVP 속도 최우선. 외부 의존성 최소화 (상용 제품 제외, OSS + 자체 구축). 작동하는 최소 구현을 선택하고, 복잡성은 실제로 필요해질 때 추가한다. CI가 코드 인텔리전스의 primary source이며, 중앙 서버는 읽기 전용으로 노출한다.

---

### ADR-001: SCIP 중심 자체 스택 선택 (Option D)

**결정**: Sourcegraph, Glean, Serena MCP 등 기존 도구를 채택하지 않고, SCIP 포맷을 중심으로 PostgreSQL + MinIO + 자체 REST/MCP 서버를 직접 구축한다.

**이유**:
- Sourcegraph: 2026년 유료 전환 ($49/user/월, 100명 기준 연 약 7,800만원) → 비용 제외
- Meta Glean: Java/Kotlin/TypeScript 공식 indexer 없음 → 주요 스택 미지원
- Serena MCP: LSP 상주형 설계 (500 repo = 500 LSP 프로세스 상주, 메모리 ~800GB), SCIP import 없음, CI primary 쓰기 불가
- SCIP는 2026년 현재 `scip-java`, `scip-typescript`, `scip-ctags` 기성품이 존재하는 사실상 표준 포맷

**트레이드오프**: 인프라·운영 비용 자체 부담. 기성 UI/검색 기능 없음 → 직접 구현 필요.

---

### ADR-002: TypeScript + Fastify for core-service

**결정**: core-service를 TypeScript + Fastify로 구현한다.

**이유**:
- MCP SDK(`@modelcontextprotocol/sdk`)와 SCIP 파서(`protobufjs`, `@sourcegraph/scip`)가 Node.js 중심
- thin service (upload + query proxy)라 Java의 생태계 이점이 크지 않음
- mcp-server와 동일 런타임 → 패키지 공유, 단일 빌드 파이프라인

**트레이드오프**: Java Spring 팀 대비 내부 운영 경험 차이. Java가 더 친숙한 팀에게 온보딩 부담.

---

### ADR-003: PostgreSQL as primary datastore

**결정**: 심볼, 참조, 관계 데이터를 모두 PostgreSQL 15에 저장한다.

**이유**:
- 멀티테넌트, 백업, HA 운영 측면에서 Neo4j/Graphiti 대비 내부 운영 역량 보유
- GIN 인덱스 + `$1:*` 패턴으로 prefix FTS 구현 가능
- recursive CTE로 그래프 순회(impact analysis) 지원 → 별도 그래프 DB 불필요 (MVP 규모)
- pg_notify/LISTEN으로 비동기 메시지 버스 역할까지 겸임 가능

**트레이드오프**: 초대형 그래프(수천만 edges) 순회 성능은 전용 그래프 DB 대비 열위. v2+ 규모에서 재검토 필요.

---

### ADR-004: MinIO/S3 for SCIP blob storage

**결정**: 업로드된 `.scip` 원본 바이너리를 MinIO(S3 호환)에 보관한다.

**이유**:
- 원본 보존 → 스키마 변경 시 재파싱(reprocessing) 가능
- Postgres에 blob을 저장하면 테이블 팽창 → 별도 객체 스토리지 분리
- `blob_key = {org}/{repo}/{commit[:2]}/{commit}/{tool}.scip` 경로로 결정론적 주소 지정

**트레이드오프**: 로컬 개발에 MinIO 컨테이너 추가 필요. 클라우드 배포 시 S3 버킷 관리 추가.

---

### ADR-005: CI-wins conflict rule

**결정**: 동일 repo/commit/tool에 대해 CI 업로드는 client 인덱스를 무조건 덮어쓰고, client 업로드는 CI 인덱스 존재 시 409를 반환한다.

**이유**:
- SCIP 생성기(tool) 버전 편차로 인해 CI와 client 결과를 병합하면 일관성 보장 불가
- CI 인덱스가 항상 재현 가능한 빌드 환경에서 생성됨 → 더 신뢰도 높음
- 단순 규칙으로 충돌 해결 로직 최소화

**트레이드오프**: client가 더 최신 심볼 정보를 가진 경우에도 CI 인덱스에 덮어씌워짐. CI 파이프라인 미설정 repo는 client 업로드만 가능.

---

### ADR-006: Full replace materialization (DELETE + bulk INSERT)

**결정**: scip-processor는 새 인덱스를 처리할 때 기존 `index_id` 행을 먼저 DELETE한 뒤 BULK INSERT로 전체 교체한다. 증분 병합은 하지 않는다.

**이유**:
- SCIP는 커밋 단위 전체 스냅샷 포맷 → 증분 diff 적용이 자명하지 않음
- full replace는 멱등성이 자명: 동일 인덱스 재처리 시 항상 동일 결과
- 구현 복잡도 최소화

**트레이드오프**: 커밋별 diff(라인 단위 변경 이력)를 DB에서 추적 불가. 필요 시 blob 두 개를 별도로 파싱해 비교해야 함.

---

### ADR-007: pg_notify/LISTEN for async processing

**결정**: core-service의 upload 완료 시점에 `pg_notify('cms_index_ready', indexId)`를 발행하고, scip-processor가 `LISTEN`으로 구독하는 방식으로 비동기 파싱을 처리한다.

**이유**:
- Kafka, RabbitMQ 등 별도 메시지 브로커 추가 없이 PostgreSQL 하나로 해결
- MVP 의존성 최소화 원칙 부합
- 재처리 필요 시 `indexes.status='pending'` 행을 직접 notify하면 됨

**트레이드오프**: 고처리량(초당 수백 건 업로드) 환경에서 pg_notify backlog 관리가 어려움. 프로세스 재시작 중 missed notify 복구 로직 필요. v1+ 규모에서 전용 큐로 교체 검토 필요.

---

### ADR-008: 정적 Bearer token 인증 (MVP)

**결정**: MVP에서는 `CMS_CI_TOKEN`, `CMS_CLIENT_TOKEN` 두 개의 정적 Bearer token으로 인증한다. OIDC는 v1+에서 도입한다.

**이유**:
- Jenkins 파이프라인에 OIDC 통합은 사내 IdP 연동이 선행되어야 함 → MVP 일정 내 불가
- 두 token으로 CI/client 역할 구분이 가능해 CI-wins 규칙 적용에 충분
- 정적 token은 secret manager(Vault 등)로 관리하면 보안 수준 유지 가능

**트레이드오프**: token 탈취 시 즉시 무효화 불가. 개별 사용자/파이프라인 단위 접근 제어 불가.

---

### ADR-009: MCP 읽기 전용 tool surface

**결정**: mcp-server는 읽기 전용 tool만 노출한다. codeatlas의 `rename_symbol`, `replace_symbol_body` 등 쓰기 도구는 중앙 서버에서 노출하지 않는다.

**이유**:
- 중앙 공유 인덱스 서버에서 쓰기 도구를 노출하면 AI 에이전트가 다수 사용자의 코드를 직접 수정하는 위험 발생
- 읽기 전용으로 제한하면 MCP 클라이언트 권한 관리가 단순해짐
- codeatlas(로컬 단일 프로젝트용)와 역할 구분 명확화

**트레이드오프**: `read_symbol_body`, `read_file_range` 같은 읽기 tool도 원본 소스가 없으면 구현 불가 → Phase 2c 별도 설계 필요.

---

### ADR-010: symbol_relationships 별도 테이블

**결정**: SCIP `SymbolInformation.relationships` (구현 관계, 타입 정의 관계 등)를 `occurrences`에 넣지 않고 `symbol_relationships` 전용 테이블에 저장한다.

**이유**:
- occurrences는 "파일 내 특정 위치에서 심볼이 등장한 사실"이고, relationships는 "심볼 A가 심볼 B를 구현/확장하는 관계"로 의미론적으로 다름
- 별도 테이블로 분리하면 `is_implementation`, `is_type_definition` 등 boolean 플래그 인덱스 활용 가능
- recursive CTE(`GET /v1/symbols/impact`)가 self-join 형태로 단순하게 구현됨

**트레이드오프**: 관계 데이터가 없는 SCIP 파일(scip-ctags 등)에서는 테이블이 비어있음. 조인 복잡도 약간 증가.

---

### ADR-011: Serena MCP는 client fallback uploader로만 활용

**결정**: Serena MCP를 중앙 백본으로 사용하지 않고, 개발자 로컬에서 CMS에 인덱스를 업로드하는 fallback 플러그인(`cms-serena-uploader`)으로만 활용한다.

**이유**:
- 중앙 백본으로 쓰려면 500 LSP 프로세스 상주 필요 (메모리 ~800GB)
- SCIP import 없음 → CI primary 쓰기 모델과 불일치
- 멀티테넌트, Auth, Web UI, REST API를 Serena 외부에서 별도 구현해야 해 Option D보다 총 엔지니어링 비용이 더 많음

**트레이드오프**: Serena의 기성 24개 tool surface를 즉시 활용하지 못함 → 직접 구현 필요.

---

### ADR-012: Cold-start fail-fast (MVP)

**결정**: 인덱스가 없는 repo에 대한 조회 요청은 MVP에서 404 + Jenkins 빌드 링크 hint로 즉시 실패 처리한다.

**이유**:
- scip-ctags partial fallback(v1 후보)은 "부분 결과가 신뢰할 수 있는가"에 대한 UX 정책 결정 필요
- Jenkins API auto-trigger(v2 후보)는 사내 Jenkins 권한 연동 선행 필요
- fail-fast가 가장 구현 단순하고 사용자가 직접 인덱싱 트리거 가능

**트레이드오프**: CI 파이프라인 미설정 repo는 사용자가 수동으로 `cmsIndex()` 추가해야 함. 첫 접근 시 UX 저하.

---

### ADR-013: read_symbol_body / read_file_range Phase 2c 보류

**결정**: 원본 소스 코드를 반환하는 `read_symbol_body`, `read_file_range` MCP tool 구현을 보류한다.

**이유**:
- 현재 시스템은 SCIP 인덱스 메타데이터(심볼·참조·관계)만 저장하며, 원본 소스 파일 자체를 저장하지 않음
- MinIO에는 `.scip` 바이너리(파싱된 심볼 데이터)만 있고 원본 `.java`/`.ts` 파일은 없음
- 구현하려면 원본 소스 저장 파이프라인(Git clone 또는 소스 파일 별도 업로드) 설계가 선행되어야 함

**트레이드오프**: 심볼 위치(file:line)를 알아도 코드 내용을 직접 반환하지 못함 → AI 에이전트가 파일 경로를 받아 Git에서 직접 조회해야 함.

→ **ADR-014에서 해제**: CI source.zip 업로드 경로 확정으로 두 tool 구현 착수 가능.

---

### ADR-014: CI source.zip 업로드 — `read_symbol_body` / `read_file_range` 구현 경로

**결정**: CI uploader는 `POST /v1/scip/upload` 동일 multipart 요청에 `.scip`와 함께 `source.zip` 아카이브를 전송한다. zip은 `{org}/{name}/{commit}/source.zip` key로 MinIO에 저장하고, `indexes.source_blob_key` 컬럼으로 주소 지정한다. 동시에 `scip-processor`는 SCIP `Occurrence.enclosing_range`를 파싱해 `symbols.body_start_line/col, body_end_line/col` 4개 컬럼에 저장한다. Client uploader는 source를 전송하지 않으며, client-only 인덱스에 대한 `read_symbol_body`/`read_file_range`는 404 + hint로 fail-fast한다.

**zip 선택 이유**: central directory로 단일 파일 O(1) 랜덤 액세스. tar.gz는 단일 파일 추출에 O(N) 스캔 필요.

**이유**:
- ADR-001/004 정합 — MinIO 기존 인프라 재사용, 새로운 외부 의존성 없음
- ADR-005(CI-wins) 정합 — source와 `.scip`이 같은 요청으로 전달되어 conflict 규칙이 그대로 성립; CI 덮어쓰기 시 두 blob 모두 갱신
- ADR-009/012 정합 — 읽기 전용 tool surface 유지; source 미보유 인덱스는 404 + Jenkins 빌드 링크 hint
- Git 자격증명을 core-service가 보유할 필요 없음 (on-demand Git clone 방식 기각)
- SCIP proto fork 불필요 — vendored `scip.proto`의 기존 `Occurrence.enclosing_range` 필드를 파서에서 활성화하는 것만으로 충분

**구현 전제 (구체적 변경 대상)**:
- `indexes` 테이블: `source_blob_key TEXT NULL`, `source_sha256 TEXT NULL`, `source_bytes BIGINT NULL` 컬럼 추가
- `symbols` 테이블: `body_start_line INT NULL`, `body_start_col INT NULL`, `body_end_line INT NULL`, `body_end_col INT NULL` 컬럼 추가
- `POST /v1/scip/upload` multipart에 `source` part 추가 (CI: 필수, client: 거부 400)
- `GET /v1/sources/file?repo&commit&file_path&start_line&end_line` 신규 라우트
- `GET /v1/sources/symbol?scip_symbol&repo` 신규 라우트
- MCP tool `read_symbol_body({ scip_symbol, repo? })`, `read_file_range({ repo, file_path, start_line, end_line, commit? })` 신규

**Privacy / 제외 패턴 (CI측 적용)**:
- 디렉토리: `.git/`, `node_modules/`, `target/`, `build/`, `dist/`, `.gradle/`, `.next/`, `.venv/`, `__pycache__/`
- 바이너리 확장자: `*.jar`, `*.class`, `*.war`, `*.png`, `*.jpg`, `*.pdf`, `*.zip`
- 파일당 2MB 초과 시 스킵. 총 업로드 cap: `MAX_SOURCE_SIZE_MB=200`

**트레이드오프**:
- commit당 `.scip`보다 2–5배 큰 blob 추가 → 저장 비용 선형 증가. `repo_head` commit은 무기한 보존, 그 외 CI commit은 마지막 20개만 보존하는 기본 원칙을 적용하고 실측 후 ADR-015(Retention/GC)로 구체화
- 대형 monorepo는 200MB cap에 근접할 수 있음 — exclusion 패턴으로 완화
- Client uploader는 `read_symbol_body` 대상 아님 (명시적 tradeoff, CI-primary 철학 정합)
- `enclosing_range` 채움 여부는 indexer 의존: `scip-java`/`scip-typescript`는 정상 채움, `scip-ctags`는 미지원 → identifier range ±10라인 fallback, `body_source: "identifier_fallback"` 플래그로 출력에 명시
