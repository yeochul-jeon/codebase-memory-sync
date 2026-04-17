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

**zip 선택 이유**: zip central directory는 로컬 파일 시스템에서 O(1) 랜덤 액세스를 제공하며, tar.gz는 단일 파일 추출에 O(N) 스캔이 필요하다. 단, 현재 구현(`minio.ts:getSourceBlob`)은 MinIO에서 매 요청마다 zip 전체를 다운로드·파싱하므로 네트워크 왕복 비용은 파일 크기에 비례한다. in-process 캐시 또는 S3 range request 최적화는 부하 실측 후 ADR-020에서 별도 검토한다.

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
- commit당 `.scip`보다 2–5배 큰 blob 추가 → 저장 비용 선형 증가. `repo_head` commit은 무기한 보존, 그 외 CI commit은 마지막 20개만 보존하는 기본 원칙을 적용하고 실측 후 ADR-016(Retention/GC)로 구체화
- 대형 monorepo는 200MB cap에 근접할 수 있음 — exclusion 패턴으로 완화
- Client uploader는 `read_symbol_body` 대상 아님 (명시적 tradeoff, CI-primary 철학 정합)
- `enclosing_range` 채움 여부는 indexer 의존: `scip-java`/`scip-typescript`는 정상 채움, `scip-ctags`는 미지원 → identifier range ±10라인 fallback, `body_source: "identifier_fallback"` 플래그로 출력에 명시

---

### ADR-015: Primary Store 유지 — PostgreSQL + MinIO 중심 구조 확정 및 점진 확장 정책

**결정**: CMS의 primary store를 **PostgreSQL + MinIO로 유지**한다. 벡터 DB와 그래프 DB는 primary를 대체하지 않고, 수요가 검증된 시점에 **파생 projection plane**으로 점진 추가한다.

**배경 및 검토 과정**:
- `docs/research/storage-alternatives.md` — 해외 7개 사례(Sourcegraph/GitHub Blackbird/Google Kythe/Meta Glean/CodeQL/Cursor/Continue.dev) 조사 완료
- `docs/research/storage-direction-vector-graph-options-2026-04-17.md` — 3가지 옵션 비교 및 권고안 작성
- 검토 옵션: (A) Postgres 유지, (B) 벡터+그래프 primary 전환, (C) Graphify Projection(파생 projection)

**이유**:
- 현재 핵심 기능은 precise symbol definition/reference 조회 및 commit 스냅샷 정합성이다. 이 요건은 PostgreSQL이 가장 안정적으로 충족한다.
- 벡터를 primary로 올리면 exact symbol identity의 canonical 보장이 약해지고, commit 단위 snapshot 격리가 어려워진다.
- 그래프를 primary로 올리면 노드·엣지 versioning이 핵심 난제가 되고, ingest 파이프라인 복잡도가 급증한다.
- `symbol_relationships` + recursive CTE는 현 규모(심볼 < 50만, 레포 < 1,000)에서 충분히 유효하다.
- ADR-001 철학("MVP 속도 최우선, 복잡성은 실제로 필요할 때 추가") 정합.

**역할 분리 원칙**:
- **벡터**: "정답 저장소"가 아닌 "후보군 생성기" — semantic retrieval plane으로만 사용
- **그래프**: primary 교체가 아닌 파생 projection — multi-hop query plane으로만 사용
- **PostgreSQL**: exact symbol lookup, commit 정합성, 시스템 레코드의 단일 진실(source of truth)

**점진 확장 시나리오 (트리거 기반)**:

| Phase | 내용 | 전환 트리거 |
|---|---|---|
| Phase 1 (현재) | PostgreSQL + MinIO 유지. 업로드 정합성·GC·source 조회 정책 정리 | 해당 없음 |
| Phase 2 | 텍스트 검색 plane 분리 (Zoekt 또는 Meilisearch) | FTS P99 > 300ms 지속 또는 레포 > 1,000개 |
| Phase 3 | pgvector 익스텐션 추가 — semantic retrieval plane | MCP에서 자연어/유사 코드 쿼리 요건 첫 발생 |
| Phase 4 | graph projection 실험 (PostgreSQL materialized view → 이후 Neo4j 검토) | 멀티홉 CTE P99 > 2초 지속 또는 cross-language graph 수요 |

**트레이드오프**:
- FTS 품질과 확장성의 한계는 Phase 2 전환 전까지 남는다. 심볼 50만 개·레포 1,000개 이하에서는 실용적으로 허용 가능하다.
- semantic retrieval 불가는 Phase 3 전까지 AI 에이전트 컨텍스트 품질의 상한을 제한한다.
- graph query 성능은 3–4홉 이하, 관계 레코드 수백만 건 이하에서 recursive CTE로 충분하다.

**미결 후속 ADR**:
- ADR-016 — source blob Retention/GC 정책 (Phase 1 완료 후)
- ADR-017 — 텍스트 검색 plane 분리 기술 선택 (Phase 2 트리거 도달 시)
- ADR-018 — Leiden 클러스터링 기반 `get_symbol_community` MCP tool (Phase 2 이후)
- ADR-019 — pgvector semantic retrieval plane 설계 (Phase 3 트리거 도달 시)

**참조**:
- `docs/research/storage-alternatives.md`
- `docs/research/storage-direction-vector-graph-options-2026-04-17.md`

---

### ADR-016: source blob Retention/GC 정책 — Part 1 (업로드 상태 정리)

**결정**: 업로드 중간 상태(`uploading`, `failed`)와 orphan blob에 대한 자동 정리 정책을 확정한다. 운영 데이터 기반 retention 수치(branch head 보존 기간, non-head 유지 개수)는 E2E 검증 이후 Part 2에서 별도 확정한다.

**배경**: ADR-014(Two-Phase Replace, ADR-016 예정)에서 도입되는 `uploading`/`failed` 상태는 장애 시 좀비 row와 orphan blob을 생성할 수 있다. 운영 시작 전 자동 정리 규칙이 없으면 MinIO 스토리지가 무한 누적된다.

**Part 1 결정 사항 (E2E 전 구현 대상)**:

| 항목 | 정책 | 근거 |
|---|---|---|
| `uploading` 좀비 reaper | `status_transition_at < now() - interval '60s'`인 `uploading` row를 `failed`로 전이. cron 주기: 5분 | 정상 업로드 p99 < 60s 가정. OOM/SIGKILL 복구 |
| `failed` blob 삭제 | `status='failed'`이고 `status_transition_at < now() - interval '24h'`인 row의 MinIO blob 삭제 후 `status='reclaiming'`으로 전이 | blob 삭제 전 24h 대기 → 디버그 창 확보 |
| `failed` DB row 삭제 | blob 삭제(`reclaiming`) 성공 후 7일 경과 시 DB row 삭제 | 감사 로그 7일 보존 후 완전 삭제 |
| 삭제 3-phase 순서 | `failed` → `reclaiming` 전이(DB) → MinIO blob DELETE → DB row DELETE. 각 단계 실패 시 retry-safe | 순서 역전 시 orphan blob 또는 stale row 방지 |
| MinIO lifecycle | `abort_incomplete_multipart_upload` TTL = 1d (버킷 레벨 설정) | 멀티파트 업로드 중단 파편 자동 제거 |
| `reclaiming` 상태 고착 | `status='reclaiming'`이고 `status_transition_at < now() - interval '1h'`인 row를 재시도 큐에 추가 | blob DELETE 실패 후 retry 보장 |

**상태 전이 다이어그램 (Part 1 범위)**:
```
uploading ──(60s 초과)──→ failed
failed    ──(24h 경과)──→ reclaiming
reclaiming ─(blob DELETE 성공)→ [DB row 7일 후 삭제]
reclaiming ─(blob DELETE 실패)→ reclaiming (retry queue)
```

**Part 2 미결 사항 (E2E 후, 실측 기반)**:
1. `default_branch` head blob 보존 기간 — 영구 vs 기간 한정
2. non-head CI commit blob 유지 개수/기간 — "repo당 최근 N개 또는 N일" 수치 결정
3. 삭제된 blob에 대한 재파싱 요청 응답 정책 — `410 Gone` + CI 재업로드 안내 후보
4. Part 2 확정 트리거: E2E 이후 `blob_storage_bytes_by_status`, `blob_age_distribution` metric 수집 결과 기반

**구현 전제**:
- `indexes.status` CHECK 제약: `'uploading'`, `'failed'`, `'reclaiming'` 추가 (ADR-014의 `'pending'`, `'processing'`, `'indexed'` 유지)
- `indexes.status_transition_at TIMESTAMPTZ NOT NULL DEFAULT now()` 컬럼 추가
- reaper/GC cron: `packages/core-service/src/workers/blob-gc.ts` 신규
- MinIO lifecycle 설정: `scripts/setup-minio-lifecycle.sh` 또는 Terraform

**트레이드오프**:
- 24h blob 보존 대기는 MinIO 용량을 소폭 추가 소비하지만 운영 디버그 창을 확보함
- 7일 DB row 보존은 감사 추적 가능성을 제공하나 테이블 bloat 주의 (autovacuum 확인 필요)
- Part 2 수치 미확정은 E2E 기간 동안 blob 무한 누적 위험을 일부 허용하나, Part 1 reaper가 `uploading`/`failed` 좀비를 정리하므로 비정상 blob만 관리됨

**참조**:
- ADR-014 — Two-Phase Replace 상태 머신 (Part 1의 전제 구현)
- ADR-015 — Phase 1 운영 정책 정리 목표

---

## ADR-017 — commit 미지정 조회 semantics 통일 (`repo_head(default_branch)`)

**날짜**: 2026-04-17
**상태**: 결정됨

**Context**:
`docs/reviews/architecture-review-2026-04-17.md` P1 이슈. `GET /v1/sources/file`, `GET /v1/sources/symbol`, `GET /v1/files/overview` 세 엔드포인트가 `commit` 쿼리 파라미터 미지정 시 서로 다른 전략으로 commit을 해석했다:
- `sources/file`: `repo_head` JOIN, 브랜치 필터 없음 (`LIMIT 1`)
- `sources/symbol`: `indexes ORDER BY created_at DESC`
- `files/overview`: `indexes ORDER BY created_at DESC`

같은 repo에 대해 동시에 두 API를 호출하면 서로 다른 `commit_sha`를 반환할 수 있었다.

**Decision**:
`commit` 쿼리 파라미터 미지정 시 `repo_head(repo_id, repos.default_branch)` 행의 `index_id`를 사용한다.
- `repo_head` 행이 없거나 `index_id IS NULL` → `404 index_not_found` (detail에 default branch 포함)
- `repos.default_branch`는 `NOT NULL DEFAULT 'main'`이므로 400 분기 불필요
- 공통 helper `resolveCommit()` (`packages/core-service/src/services/commit-resolver.ts`)로 구현

**Consequences**:
- 세 엔드포인트 모두 commit-less 호출 시 동일한 `commit_sha` 반환 (P1 해결)
- MCP client (`mcp-server/src/client.ts`)에서 `commit` optional, `branch` 미지원 → default branch index만 반환
- Upload 경로에서 `branch` 누락 시 `repo_head` 미채움 → commit-less 조회 실패 (404). 향후 `upload.ts`의 `branch` 필수화가 필요 (별도 ADR)
- `branch` 쿼리 파라미터 지원은 후속 확장으로 분리

**참조**:
- `docs/reviews/architecture-review-2026-04-17.md` P1
- `packages/core-service/src/services/commit-resolver.ts`
- ADR-014 (source.zip + `read_symbol_body` 설계)
