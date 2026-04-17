# 아키텍처 검토 메모 — 2026-04-17

## 배경과 검토 범위

사용자 요청은 `docs/research/storage-alternatives.md`와 현재 설계 구상 아키텍처 검토였으나, 실제 저장소 상태를 확인한 결과 `docs/research/storage-alternatives.md`는 현재 존재하지 않았다.  
따라서 이번 검토는 아래 자료를 현재 시점의 소스 오브 트루스로 간주하고 진행했다.

- [architecture-plan.md](../architecture-plan.md)
- [ADR.md](../ADR.md)
- [work-log.md](../work-log.md)
- [upload.ts](../../packages/core-service/src/routes/upload.ts)
- [sources.ts](../../packages/core-service/src/routes/sources.ts)
- [minio.ts](../../packages/core-service/src/storage/minio.ts)
- [conflict.ts](../../packages/core-service/src/services/conflict.ts)
- [schema.sql](../../packages/core-service/src/storage/schema.sql)

이 문서의 목적은 두 가지다.

1. 현재 설계 방향 자체가 타당한지 판단한다.
2. 문서와 구현을 함께 보고, 운영 단계에서 문제가 될 구조적 리스크를 우선순위대로 정리한다.

## 현재 설계 요약

현재 아키텍처의 중심축은 일관적이다.

- 코드 인텔리전스 포맷은 SCIP 중심이다.
- 중앙 저장소는 PostgreSQL + MinIO 조합을 사용한다.
- 업로드는 CI primary, client fallback 모델을 사용한다.
- 조회 인터페이스는 REST와 읽기 전용 MCP surface를 중심으로 한다.
- 심볼 관계는 `occurrences`와 분리된 `symbol_relationships`로 저장한다.

이 방향은 [architecture-plan.md](../architecture-plan.md)와 [ADR.md](../ADR.md) 전반에 걸쳐 반복적으로 확인된다. 특히 Option D를 기본 아키텍처로 고정한 판단, Serena를 중앙 백본이 아니라 fallback uploader로 제한한 판단, 그리고 `symbol_relationships` 분리는 모두 큰 방향에서 타당하다.

## 긍정 평가

### 1. 아키텍처의 중심 선택은 합리적이다

[ADR-001](../ADR.md#adr-001-scip-중심-자체-스택-선택)은 Sourcegraph, Glean, Serena를 모두 비교한 뒤 `SCIP + Postgres + MinIO + 자체 REST/MCP` 스택으로 수렴한다. 이 선택은 현재 요구사항과 제약에 맞는다.

- 상용 비용 회피가 분명하다.
- Java/TypeScript 중심 조직에서 사용할 indexer 생태계가 존재한다.
- 중앙 공유형 구조로 확장하기 쉽다.
- 특정 LSP 서버의 장기 상주에 의존하지 않는다.

특히 Serena를 중앙 서버 백본으로 쓰지 않겠다는 결론은 설득력이 높다. 이 프로젝트 목표는 “개인 IDE 보조 도구”가 아니라 “전사 중앙 공유 코드 지식 저장소”이기 때문이다.

### 2. 관계 데이터 모델링은 방향이 좋다

[ADR-010](../ADR.md#adr-010-symbol_relationships-별도-테이블)은 `SymbolInformation.relationships`를 `occurrences`에 섞지 않고 별도 테이블로 분리한다. 이 결정은 의미론적으로 맞고, 구현도 그 방향을 충실히 따른다.

- [schema.sql](../../packages/core-service/src/storage/schema.sql)에서 `symbol_relationships`를 별도 테이블로 관리한다.
- [parser.ts](../../packages/scip-processor/src/parser.ts)는 relationships를 별도 파싱한다.
- [materialize.ts](../../packages/scip-processor/src/materialize.ts)는 별도 bulk insert 경로를 둔다.

이는 향후 `find_implementors`, `get_dependencies`, `get_impact_analysis`를 유지보수 가능한 방식으로 확장하는 데 유리하다.

### 3. 읽기 전용 MCP surface 방침도 맞다

[architecture-plan.md](../architecture-plan.md)와 [ADR-009](../ADR.md#adr-009-mcp-읽기-전용-tool-surface)는 중앙 공유 서버에서 쓰기 도구를 노출하지 않겠다는 원칙을 유지한다. 이 판단은 보안과 운영 통제 측면에서 맞다.

- 중앙 서버는 공유 인덱스를 제공하는 읽기 계층 역할에 집중한다.
- 코드 수정 도구는 로컬 워크스페이스 책임과 분리된다.
- 권한 모델이 단순해진다.

## 주요 리스크 및 설계 공백

### P0. 업로드 원자성 부족으로 인한 손상된 인덱스 고착 위험

가장 큰 문제는 업로드 경계가 “DB 먼저, blob 나중”으로 끊겨 있다는 점이다.

[upload.ts](../../packages/core-service/src/routes/upload.ts)는 다음 순서로 동작한다.

1. `indexes` row insert
2. `upload_receipts` insert
3. `audit_log` insert
4. `COMMIT`
5. 그 다음에 `putScipBlob()`
6. 필요한 경우 `putSourceBlob()`
7. 마지막에 `pg_notify`

근거:

- [upload.ts:168](../../packages/core-service/src/routes/upload.ts#L168)
- [upload.ts:180](../../packages/core-service/src/routes/upload.ts#L180)
- [upload.ts:182](../../packages/core-service/src/routes/upload.ts#L182)
- [upload.ts:188](../../packages/core-service/src/routes/upload.ts#L188)

이 구조에서 발생하는 문제는 명확하다.

- DB commit 이후 S3/MinIO 업로드가 실패하면 DB에는 `pending` 인덱스가 이미 남는다.
- 같은 요청을 재시도해도 idempotency key가 이미 기록됐기 때문에 정상 재처리가 막힐 수 있다.
- `pg_notify` 이전에 실패하면 worker는 해당 인덱스를 알지 못한다.
- 기존 인덱스를 지우고 새 인덱스를 넣는 conflict 처리와 결합되면, 정상 데이터가 사라지고 손상된 인덱스만 남을 수 있다.

이 점은 [conflict.ts](../../packages/core-service/src/services/conflict.ts#L52)에서 기존 row를 미리 삭제하는 구현 때문에 더 위험해진다.

- [conflict.ts:52](../../packages/core-service/src/services/conflict.ts#L52)

현재 구조는 “새 업로드를 적용하기 전에 기존 정합 상태를 먼저 파괴”한다. blob 저장 실패나 notify 실패 시 복구 경로가 문서화되어 있지 않다. 이 문제는 단순 버그가 아니라 저장 계층 일관성 설계 문제다.

### P1. `source.zip` 전략의 설명과 실제 비용 모델이 다르다

[ADR-014](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)는 zip을 선택한 이유로 “central directory를 이용한 단일 파일 O(1) 랜덤 액세스”를 든다.

근거:

- [ADR.md:182](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)
- [ADR.md:186](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)

그러나 현재 구현은 그 장점을 실제로 활용하지 않는다.

- [minio.ts](../../packages/core-service/src/storage/minio.ts#L73)는 `source.zip` 전체를 S3에서 가져온다.
- [minio.ts](../../packages/core-service/src/storage/minio.ts#L93)는 그 전체 버퍼를 `AdmZip`으로 열고 entry를 뽑는다.
- [sources.ts](../../packages/core-service/src/routes/sources.ts#L102)와 [sources.ts](../../packages/core-service/src/routes/sources.ts#L190)는 조회 요청마다 이 경로를 호출한다.

즉 현재 비용 모델은 다음과 같다.

- 단일 파일 조회 요청
  -> 전체 zip 다운로드
  -> 전체 zip 메모리 적재
  -> zip central directory 파싱
  -> entry 추출

이 구조에서는 “zip이 랜덤 액세스에 유리하다”는 설계 설명이 실제 서비스 레벨의 성능 보장으로 이어지지 않는다. `MAX_SOURCE_SIZE_MB=200` 전제를 ADR이 이미 인정하고 있는데, 조회가 늘면 core-service는 API 서버이면서 동시에 대형 zip 파일 재다운로드 서버가 된다.

이 문제는 특히 `read_file_range`, `read_symbol_body`가 자주 호출되는 에이전트 워크로드에서 빠르게 부하로 드러날 가능성이 높다.

### P1. head / default branch 의미가 아직 고정되지 않았다

[sources.ts](../../packages/core-service/src/routes/sources.ts)의 조회 규칙은 커밋 미지정 상황에서 일관되지 않다.

`GET /v1/sources/file`:

- `commit`이 없으면 `repo_head`에서 `LIMIT 1`만 사용한다.
- branch 조건이 없다.

근거:

- [sources.ts:77](../../packages/core-service/src/routes/sources.ts#L77)
- [sources.ts:78](../../packages/core-service/src/routes/sources.ts#L78)

하지만 `repo_head`는 브랜치별 row를 저장하는 구조다.

- [schema.sql](../../packages/core-service/src/storage/schema.sql#L82)

따라서 한 저장소에 `main`, `develop`, `release/*`가 함께 존재하면 어떤 row가 선택될지 SQL만 봐서는 결정되지 않는다.

반면 `GET /v1/sources/symbol`은 `commit`이 없을 때 `repo_head`를 보지 않고 `ORDER BY i.created_at DESC`로 최신 업로드를 뽑는다.

근거:

- [sources.ts:163](../../packages/core-service/src/routes/sources.ts#L163)
- [sources.ts:171](../../packages/core-service/src/routes/sources.ts#L171)

즉 현재는 아래 해석이 섞여 있다.

- “repo의 현재 head”
- “어떤 브랜치든 가장 최근 업로드된 인덱스”
- “default branch 기준 활성 커밋”

문서상으로도 이 semantics가 고정돼 있지 않다. 결과적으로 같은 저장소에 대해 API마다 다른 commit을 참조할 수 있다. 이 상태에서는 사용자가 “최근 인덱스 기준 조회”라고 이해해도 실제 반환 기준은 route별로 달라질 수 있다.

### P2. retention / GC 전략이 아직 비어 있다

[ADR-014](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)는 source.zip이 `.scip`보다 2배에서 5배 더 클 수 있고, 보존 정책은 후속 ADR로 구체화하겠다고 적는다.

근거:

- [ADR.md:208](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)
- [ADR.md:209](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)

문제는 이 공백이 단순 미래 과제가 아니라 현재 구조의 저장 비용과 직결된다는 점이다.

- commit마다 `.scip`와 `source.zip`가 함께 누적된다.
- CI가 primary writer이므로 기본적으로 commit 단위 축적 구조다.
- blob와 DB 메타를 함께 정리하는 규칙이 아직 없다.
- `repo_head`가 가리키는 인덱스, historical index, failed index를 어떤 기준으로 남길지 아직 설계가 비어 있다.

이 상태에서는 운영 시작 후 저장량이 늘어날수록 정책 부재가 먼저 장애가 된다. 보존 정책이 늦게 붙으면, 이후에는 이미 쌓인 blob와 인덱스 메타를 역정리해야 한다.

### P2. source body fallback 정책이 문서와 다르게 구현됐다

[ADR-014](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)는 `scip-ctags`처럼 `enclosing_range`가 비는 경우 `identifier range ±10라인 fallback`을 명시한다.

근거:

- [ADR.md:212](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)

하지만 실제 구현은 `body_*`가 비어 있으면 식별자 시작 라인만 그대로 사용한다.

- [sources.ts:197](../../packages/core-service/src/routes/sources.ts#L197)
- [sources.ts:199](../../packages/core-service/src/routes/sources.ts#L199)
- [sources.ts:200](../../packages/core-service/src/routes/sources.ts#L200)

즉 현재 `identifier_fallback`은 “주변 10라인”이 아니라 사실상 “심볼 선언 한 줄”에 가깝다. 이 차이는 문서 표현상 사소해 보이지만, 실제 사용자 경험에서는 `read_symbol_body`가 body를 주는지, 선언 한 줄만 주는지의 차이로 나타난다.

## 문서와 구현의 불일치

### 1. 업로드 프로토콜 설명이 stale 상태다

[architecture-plan.md](../architecture-plan.md#44-업로드-프로토콜)는 업로드 프로토콜을 다음과 같이 설명한다.

- `Authorization: Bearer <OIDC token>`
- multipart fields는 `repo, commit, branch, tool, tool_version, scip(binary)`
- 413 기준은 `>500MB`

근거:

- [architecture-plan.md:272](../architecture-plan.md#44-업로드-프로토콜)
- [architecture-plan.md:273](../architecture-plan.md#44-업로드-프로토콜)
- [architecture-plan.md:277](../architecture-plan.md#44-업로드-프로토콜)
- [architecture-plan.md:283](../architecture-plan.md#44-업로드-프로토콜)

실제 구현은 다르다.

- 인증은 OIDC가 아니라 정적 bearer token 기반이다.
- CI 업로드는 `source` multipart field가 필수다.
- source 크기 제한과 scip 크기 제한이 별도로 존재한다.

근거:

- [ADR-008](../ADR.md#adr-008-정적-bearer-token-인증-mvp)
- [upload.ts:72](../../packages/core-service/src/routes/upload.ts#L72)
- [upload.ts:74](../../packages/core-service/src/routes/upload.ts#L74)
- [upload.ts:80](../../packages/core-service/src/routes/upload.ts#L80)

즉 지금의 `architecture-plan.md`는 구현 계약 문서로 사용하면 잘못된 호출을 유도할 수 있다.

### 2. CI 업로드 예시가 현재 설계와 맞지 않는다

[architecture-plan.md](../architecture-plan.md#46-ci-통합-jenkins-shared-library)의 Jenkins 예시는 `scip=@index.scip`만 전송한다.

근거:

- [architecture-plan.md:327](../architecture-plan.md#46-ci-통합-jenkins-shared-library)
- [architecture-plan.md:335](../architecture-plan.md#46-ci-통합-jenkins-shared-library)

하지만 현재 설계와 구현은 CI에서 `source.zip`도 함께 보내야 성립한다.

- [ADR.md:184](../ADR.md#adr-014-ci-sourcezip-업로드--read_symbol_body--read_file_range-구현-경로)
- [upload.ts:74](../../packages/core-service/src/routes/upload.ts#L74)

즉 CI 통합 예시 자체가 이미 obsolete하다.

### 3. MinIO key layout 설명과 실제 구현이 다르다

[architecture-plan.md](../architecture-plan.md#49-minio-레이아웃)는 MinIO layout을 다음처럼 설명한다.

- `{org}/{repo}/{commit[:2]}/{commit}/{tool}.scip`
- `{org}/{repo}/{commit[:2]}/{commit}/{tool}.scip.sha256`
- `_manifests/{org}/{repo}/{commit}.json`

근거:

- [architecture-plan.md:347](../architecture-plan.md#49-minio-레이아웃)

실제 구현은 다음 key만 사용한다.

- `${org}/${name}/${commit}/${tool}.scip`
- `${org}/${name}/${commit}/source.zip`

근거:

- [upload.ts:139](../../packages/core-service/src/routes/upload.ts#L139)
- [upload.ts:140](../../packages/core-service/src/routes/upload.ts#L140)

`.sha256` companion object나 `_manifests`는 현재 코드에서 사용되지 않는다. 운영자가 문서만 믿고 버킷 구조나 GC 스크립트를 설계하면 실제와 어긋날 수 있다.

### 4. 단계별 구현 상태 설명도 이미 뒤처져 있다

[work-log.md](../work-log.md)는 Phase 2b 시점까지 `read_symbol_body`, `read_file_range`가 보류라고 적고 있다.

근거:

- [work-log.md:244](../work-log.md#phase-2a--mcp-tool-2개-추가-2026-04-17)
- [work-log.md:306](../work-log.md#phase-2b--scip-relationships--mcp-tool-3개-추가-2026-04-17)

하지만 현재 코드에는 이미 source routes가 존재한다.

- [sources.ts](../../packages/core-service/src/routes/sources.ts)
- [server.ts](../../packages/core-service/src/server.ts#L17)
- [server.ts](../../packages/core-service/src/server.ts#L46)

즉 현재 저장소는 “문서상 보류”와 “코드상 구현”이 공존한다. 이런 상태가 길어질수록 ADR과 work log의 신뢰도가 떨어진다.

## 우선순위별 권고사항

### 1. 업로드 원자성 및 복구 모델을 가장 먼저 고정해야 한다

최우선 과제는 “DB와 blob 업로드의 일관성”이다. 구현 방식은 여러 가지가 가능하지만, 어떤 방식을 택하든 아래 조건은 만족해야 한다.

- blob 저장 실패 시 `ready`나 재시도 불가능한 `pending` 상태가 남지 않아야 한다.
- idempotency receipt는 성공 경로와 실패 경로를 구분할 수 있어야 한다.
- 기존 인덱스를 삭제하는 시점은 새 인덱스의 blob 저장과 재처리 가능성이 확보된 뒤로 미뤄야 한다.
- worker 재처리나 orphan cleanup 절차가 운영 문서에 포함돼야 한다.

이 문제는 성능 문제가 아니라 데이터 정합성 문제이므로 가장 먼저 해결하는 것이 맞다.

### 2. “commit 미지정 조회”의 기준을 하나로 통일해야 한다

다음으로 고정해야 할 것은 조회 semantics다.

- 기본은 `default_branch`의 head인지
- 특정 branch head인지
- 가장 최근 성공 인덱스인지

이 셋 중 하나로 명확히 고정해야 한다. 그리고 `sources`, `symbols`, `file-overview`, MCP tool 전반이 같은 기준을 쓰도록 맞춰야 한다.

### 3. source 조회 전략은 저장 형식과 읽기 패턴을 함께 재검토해야 한다

현재처럼 zip 전체를 매번 내려받는 구조를 유지할 수도 있다. 다만 그 경우 문서에 “random access”라고 쓰면 안 된다. 반대로 정말 랜덤 액세스 성능을 원하는 경우에는 다음과 같은 후속 설계가 필요하다.

- source 캐시 계층 도입
- 서버 로컬/디스크 캐시
- 파일 단위 object 분할 저장
- pre-signed fetch + edge cache

핵심은 “왜 zip을 고르는가”와 “실제 조회 비용”을 동일한 문장으로 설명할 수 있어야 한다는 점이다.

### 4. retention / GC는 ADR 수준으로 조기 승격해야 한다

현재 상태에서 source.zip까지 누적되면 운영상 가장 먼저 부딪히는 것은 용량과 정리 기준이다. 따라서 이 항목은 v2로 미룰 주제가 아니라, source 보관을 실제 운영에 올리기 전에 ADR로 확정하는 편이 맞다.

적어도 아래는 명시돼야 한다.

- branch head는 무기한 보존할지
- non-head commit은 몇 개까지 유지할지
- failed index는 언제 삭제할지
- blob 삭제와 DB row 삭제의 순서를 어떻게 가져갈지
- 재파싱용 historical blob를 어디까지 남길지

### 5. 문서 정합성 회복 작업이 필요하다

현재는 구현이 문서를 앞서간 상태다. 이 상태가 길어질수록 이후 설계 토론이 문서가 아니라 코드 읽기로만 진행된다. 최소한 아래 문서는 동기화가 필요하다.

- `docs/architecture-plan.md`
- `docs/ADR.md`
- `docs/work-log.md`

특히 업로드 프로토콜, source.zip 요구사항, MinIO layout, phase 상태는 빠르게 맞춰야 한다.

## 결론

현재 아키텍처 방향은 잘못 잡힌 것이 아니다. 오히려 `SCIP + Postgres + MinIO + 읽기 전용 MCP`라는 축은 요구사항에 맞는 현실적인 선택이다.

문제는 지금 가장 중요한 리스크가 “어떤 DB를 쓰는가” 같은 기술 선택 문제가 아니라, 이미 구현에 들어간 저장 계층의 정합성과 운영 semantics라는 점이다.

정리하면 현재 상태의 우선순위는 아래와 같다.

1. 업로드 원자성/복구 모델 고정
2. commit 미지정 조회 기준 통일
3. source.zip 조회 비용 모델 재정의
4. retention/GC 정책 ADR화
5. 설계 문서와 구현 상태 동기화

이 다섯 가지를 먼저 정리하면 지금의 아키텍처는 충분히 다음 단계로 밀고 갈 수 있다. 반대로 이 부분을 미룬 채 기능만 늘리면, 이후 문제는 기능 부족이 아니라 운영 복구와 데이터 신뢰성 문제로 나타날 가능성이 높다.
