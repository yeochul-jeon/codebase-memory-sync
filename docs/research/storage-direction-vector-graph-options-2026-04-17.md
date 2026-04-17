# 저장 구조 방향 검토 — Postgres 유지 vs 벡터+그래프 vs Graphify Projection

> 작성일: 2026-04-17  
> 목적: CMS(`codebase-memory-sync`)의 차기 저장 구조 방향 검토  
> 범위: primary storage architecture 비교와 권고안

---

## 1. 문제 정의

현재 CMS는 아래 구조를 중심으로 동작한다.

- PostgreSQL: 심볼, occurrence, 관계, 인덱스 메타데이터
- MinIO: `.scip`, `source.zip`
- PostgreSQL FTS: 심볼명 검색

최근 논의 포인트는 다음이다.

1. 현재 저장 구조를 `벡터 + 그래프` 중심으로 옮기는 것이 맞는가
2. 저장 구조 전체를 `graphify`해서 운영하는 것이 맞는가
3. 아니면 현재 Postgres 중심 구조를 유지하고 필요한 plane만 추가하는 것이 맞는가

이 문서는 위 세 방향을 비교하고, CMS 현 단계에서 어떤 선택이 가장 합리적인지 정리한다.

---

## 2. 현재 요구사항 기준

현재 CMS가 실제로 풀고 있는 핵심 문제는 아래에 가깝다.

- 정확한 symbol definition / reference 조회
- repo + commit 단위 스냅샷 관리
- CI 업로드와 재처리
- 읽기 전용 REST / MCP 서빙
- 운영 단순성과 디버깅 가능성

반대로 아직 핵심이 아닌 영역은 아래다.

- 자연어 기반 semantic retrieval
- 다중 홉 cross-language architecture graph 탐색
- agent용 유사 코드 검색
- knowledge graph 수준의 분석 워크로드

따라서 저장 구조 판단의 기준은 "기술적으로 더 멋진가"가 아니라 "현재 핵심 문제를 가장 적은 비용으로 안정적으로 푸는가"여야 한다.

---

## 3. 옵션 정의

## 3.1 옵션 A — 현재 구조 유지

기본 구조를 유지한다.

- primary store: PostgreSQL
- blob store: MinIO
- 관계 질의: SQL + recursive CTE
- 검색: PostgreSQL FTS 또는 이후 Zoekt 분리

이 옵션은 지금의 소스 오브 트루스를 그대로 유지하는 전략이다.

## 3.2 옵션 B — 벡터 + 그래프를 주 저장 구조로 승격

주 저장 구조를 아래처럼 바꾸는 전략이다.

- vector store: 코드 청크 / symbol embedding 저장
- graph store: symbol / file / module / service 관계 저장
- RDBMS는 메타나 보조 저장소로 축소

이 옵션은 "AI retrieval과 architecture query를 중심에 두는" 구조다.

## 3.3 옵션 C — Graphify Projection

primary store는 유지하되, graph와 vector를 파생 projection으로 생성하는 전략이다.

- source of truth: PostgreSQL + MinIO
- derived graph projection: graph DB 또는 graph materialization
- derived vector projection: embedding store
- projection 단위: `repo + commit`

이 옵션은 graph/vector를 도입하되 source of truth를 교체하지 않는 방식이다.

---

## 4. 옵션별 평가

## 4.1 옵션 A — Postgres 중심 유지

### 장점

- 현재 구현과 가장 정합적이다.
- commit/version 정합성이 명확하다.
- ingest 파이프라인이 단순하다.
- 장애 복구가 상대적으로 쉽다.
- 팀 운영 역량과 맞는다.

### 단점

- 그래프 다중 홉 질의가 커질수록 불리하다.
- semantic retrieval은 별도 확장 없이는 어렵다.
- FTS를 오래 끌고 가면 검색 품질과 확장성이 한계에 닿는다.

### 적합한 상황

- 핵심 제품 가치가 아직 precise symbol navigation인 경우
- 운영 단순성이 가장 중요한 경우
- graph/vector 수요가 아직 보조 기능 수준인 경우

### 판단

현재 CMS는 여기에 가장 가깝다.  
문제는 "이 방향이 틀렸는가"가 아니라 "검색과 AI retrieval을 언제 분리할 것인가"다.

---

## 4.2 옵션 B — 벡터 + 그래프를 primary로 전환

### 장점

- 자연어 기반 semantic retrieval에 강하다.
- architecture graph 탐색, 영향도 분석, 관계 시각화에 유리하다.
- 장기적으로 cross-language relation을 다루기 쉬워질 수 있다.

### 단점

- source of truth가 흔들린다.
- exact symbol identity와 commit 정합성을 따로 관리해야 한다.
- ingest 파이프라인이 복잡해진다.
- graph와 vector의 재색인/재계산 비용이 생긴다.
- 복구 시 "무엇이 진실 데이터인가"가 모호해진다.
- 팀이 동시에 두 종류의 저장 모델을 운영해야 한다.

### 구조적 문제

벡터와 그래프는 각각 잘하는 일이 다르다.

- 벡터는 "유사도"를 잘한다.
- 그래프는 "연결성"을 잘한다.
- 하지만 둘 다 "정확한 commit 스냅샷 기반 symbol 서빙"의 기본 저장소로는 까다롭다.

벡터를 primary로 올리면 생기는 문제:

- 동일 symbol의 canonical identity 보장이 약하다.
- 결과는 similarity 기반이라 exact lookup source가 되기 어렵다.

그래프를 primary로 올리면 생기는 문제:

- 노드/엣지 versioning이 핵심 난제가 된다.
- repo + commit별 snapshot 격리가 어려워진다.
- ingestion 시 관계 normalization 비용이 커진다.

### 적합한 상황

- 핵심 제품이 이미 architecture graph query 중심인 경우
- 팀이 graph DB 운영과 schema evolution에 익숙한 경우
- semantic retrieval이 product core인 경우

### 판단

현재 CMS 단계에서는 과하다.  
이 방향은 “미래에 쓸 수 있는 구조”이지, “지금 pain point를 가장 빨리 해결하는 구조”는 아니다.

---

## 4.3 옵션 C — Graphify Projection

### 개념

이 옵션은 graph와 vector를 도입하되, primary store를 교체하지 않는다.

- PostgreSQL은 canonical metadata store로 유지
- MinIO는 blob source로 유지
- graph DB는 파생 projection만 저장
- vector store는 retrieval projection만 저장

즉 아래처럼 보는 전략이다.

`SCIP + source.zip`  
-> Postgres materialize  
-> graph projection 생성  
-> vector projection 생성

### 장점

- source of truth가 명확하게 유지된다.
- graph/vector 실패가 primary 데이터를 망치지 않는다.
- projection은 재생성 가능하다.
- 점진 도입이 가능하다.
- 실제 수요가 검증된 뒤 확장할 수 있다.

### 단점

- 저장 구조가 늘어난다.
- projection 생성/동기화 파이프라인이 추가된다.
- 지연(latency)과 일관성 모델을 따로 정의해야 한다.
- 운영 문서와 모니터링 범위가 넓어진다.

### 적합한 상황

- exact symbol serving은 유지해야 하지만
- semantic retrieval과 graph query를 실험적으로 붙이고 싶은 경우

### 판단

세 옵션 중 현실적으로 가장 균형이 좋다.  
다만 이것도 “지금 바로 반드시 해야 한다”기보다는, 현재 pain point가 검색/AI retrieval 쪽으로 커질 때 가장 안전한 확장 경로다.

---

## 5. 벡터와 그래프를 각각 어떻게 봐야 하는가

## 5.1 벡터에 대한 판단

벡터 저장소는 도입 가치가 높다.  
하지만 역할은 명확히 제한해야 한다.

적합한 역할:

- 자연어 질의 기반 코드 청크 retrieval
- 유사 구현 검색
- agent context 후보군 생성
- 문서/PR/코드 예시 검색

부적합한 역할:

- exact definition / reference source of truth
- symbol identity의 canonical store
- commit 정합성을 보장해야 하는 시스템 레코드

정리하면, 벡터는 `정확 조회`를 대체하지 않고 `후보군 검색`을 보완한다.

## 5.2 그래프에 대한 판단

그래프 저장소는 장기적으로 분명 쓸모가 있다.

적합한 역할:

- multi-hop dependency 탐색
- 아키텍처 레벨 질의
- service / module / package 간 관계 분석
- cross-language relation materialization

부적합한 역할:

- ingest 초기 단계의 단일 진실 저장소
- commit snapshot을 가장 단순하게 관리해야 하는 primary store

현재 CMS의 관계 질의는 아직 `symbol_relationships + recursive CTE` 수준에서 충분히 버틸 가능성이 높다. 그래프 DB는 SQL이 명확히 한계에 닿을 때 검토하는 것이 맞다.

---

## 6. 핵심 비교표

| 항목 | 옵션 A Postgres 유지 | 옵션 B 벡터+그래프 primary | 옵션 C Graphify projection |
|---|---|---|---|
| 구현 난이도 | 낮음 | 높음 | 중간 |
| 운영 난이도 | 낮음~중간 | 높음 | 중간~높음 |
| commit 정합성 | 좋음 | 까다로움 | 좋음 |
| exact symbol lookup | 강함 | 보완 필요 | 강함 |
| semantic retrieval | 약함 | 강함 | 강함 |
| graph query | 중간 | 강함 | 강함 |
| 장애 복구 | 비교적 쉬움 | 어려움 | 중간 |
| 단계적 도입 | 좋음 | 나쁨 | 좋음 |
| 현재 CMS 적합도 | 가장 높음 | 낮음 | 높음 |

---

## 7. 권고안

현재 시점의 권고는 명확하다.

## 권고 1. primary store는 유지한다

지금 CMS에서 primary store를 `벡터 + 그래프`로 교체하는 것은 권하지 않는다.

이유:

- 현재 핵심 기능은 precise symbol/navigation이다.
- commit 스냅샷 정합성이 가장 중요하다.
- 운영 복잡도를 불필요하게 급증시킨다.

## 권고 2. 우선 분리해야 할 것은 검색 plane이다

다음 투자 우선순위는 graph DB 전환보다 검색 분리다.

- PostgreSQL: metadata / symbol / relationships
- MinIO: blob
- Zoekt 등: 텍스트 검색 plane

이게 가장 먼저 ROI가 나올 가능성이 높다.

## 권고 3. 벡터는 secondary retrieval plane으로 붙인다

AI agent나 자연어 검색 수요가 커지면 아래 구조를 권장한다.

- source of truth: PostgreSQL + MinIO
- retrieval plane: vector store
- lookup plane: REST/MCP exact symbol API

즉 벡터는 “정답 저장소”가 아니라 “후보군 생성기”여야 한다.

## 권고 4. 그래프는 projection으로 시작한다

그래프를 도입한다면 전면 교체보다 projection이 낫다.

예시:

- Postgres `symbols`, `occurrences`, `symbol_relationships`에서
- `repo + commit` 기준 graph projection 생성
- impact/architecture query는 graph plane에서 처리

이 방식이면 실패하거나 모델이 틀려도 원본 저장 구조는 유지된다.

---

## 8. 단계적 확장 시나리오

가장 현실적인 확장 순서는 아래다.

### Phase 1

- Postgres + MinIO 유지
- 업로드 정합성/GC/source 조회 정책 정리

### Phase 2

- Zoekt 등 텍스트 검색 plane 분리
- MCP / REST에서 code search 추가

### Phase 3

- symbol/file/chunk embedding 저장
- semantic retrieval plane 추가

### Phase 4

- graph projection 실험
- architecture query, multi-hop dependency query 고도화

이 순서는 현재 CMS의 위험을 줄이면서 기능을 확장하기에 가장 무난하다.

---

## 9. 결론

질문에 대한 직접 답은 아래와 같다.

### `벡터 + 그래프`로 관리하는 것은 어떤가?

장기적으로는 유효하다.  
하지만 현재 CMS의 주 저장 구조로 올리기에는 이르다.

### `graphify`로 관리하는 것은 어떤가?

가능하다.  
다만 primary replacement가 아니라 derived projection으로 보는 것이 맞다.

### 지금 무엇을 선택해야 하는가?

현재 시점의 최적 선택은 다음이다.

> primary는 `PostgreSQL + MinIO`를 유지하고, 검색과 AI retrieval, graph query를 별도 plane으로 점진적으로 분리한다.

즉 결론은 세 줄로 요약된다.

1. 벡터는 도입 가치가 높지만 secondary plane이 맞다.
2. 그래프는 장기적으로 유효하지만 지금은 projection이 맞다.
3. primary store 교체보다 역할 분리가 우선이다.
