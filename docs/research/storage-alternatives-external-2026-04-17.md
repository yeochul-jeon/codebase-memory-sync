# 코드 인텔리전스 스토리지 대안 리서치 — 외부 사례 재조사

> 작성일: 2026-04-17  
> 범위: 코드 인텔리전스의 저장 계층(storage backend)과 그 주변 검색 인덱스 구조  
> 목적: `codebase-memory-sync`의 차기 ADR 검토를 위한 별도 외부 리서치 문서

---

## 1. 개요

이 문서는 [`storage-alternatives.md`](./storage-alternatives.md)와 같은 주제를 별도로 다시 조사한 자료다.  
기존 문서가 이미 넓은 사례를 정리하고 있으므로, 이번 문서는 다음에 더 집중한다.

- 공식 문서와 1차 자료 중심으로 사실을 다시 확인
- "무슨 DB를 쓰는가"보다 "어떤 데이터를 어떤 저장소에 분리하는가"를 비교
- 현재 CMS 아키텍처에 바로 연결되는 시사점 정리

이번 조사에서 확인한 핵심 결론은 단순하다.

1. 대규모 코드 인텔리전스 제품은 거의 항상 저장소를 분리한다.
2. 관계/메타데이터는 RDBMS, 텍스트 검색은 전용 인덱스, 대형 산출물은 blob/object storage로 나뉘는 경우가 많다.
3. 그래프 또는 팩트 DB는 강력하지만, 운영 복잡도와 스키마 복잡도가 높아 대부분의 팀에게는 과투자다.
4. 벡터 검색은 "정확 코드 내비게이션"의 대체재가 아니라 AI retrieval용 보조 계층으로 붙는 경우가 많다.

---

## 2. 조사 방법과 기준

### 2.1 자료 기준

이번 문서는 가능한 한 아래 우선순위로 자료를 사용했다.

1. 공식 제품 문서
2. 공식 엔지니어링 블로그
3. 공식 저장소 문서 / API 문서

추정이 필요한 경우는 명시적으로 추정이라고 적었다.

### 2.2 비교 축

각 사례는 아래 축으로 비교했다.

- 저장 계층 분리 여부
- 심볼/관계 저장 방식
- 텍스트 검색 저장 방식
- 대형 산출물 저장 방식
- 증분 업데이트 방식
- CMS와의 적합성

---

## 3. 사례별 정리

## 3.1 Sourcegraph

### 요약

Sourcegraph는 저장 계층을 명확히 분리한다.

- PostgreSQL: 사용자/메타데이터/코드 인텔리전스 일부 메타
- `codeintel-db` PostgreSQL: precise code intel 저장
- Zoekt: trigram 기반 코드 검색 인덱스
- gitserver: Git 저장소 캐시
- blobstore: 업로드 산출물 저장

공식 문서 근거:

- https://sourcegraph.com/docs/admin/architecture
- https://sourcegraph.com/docs/admin/postgres

### 관찰 포인트

- 텍스트 검색은 PostgreSQL이 아니라 Zoekt가 담당한다.
- precise code navigation은 별도 코드 인텔리전스 저장소 계층으로 분리된다.
- 기본 검색 대상은 default branch 중심이며, 인덱싱하지 않은 코드는 별도 fast path로 처리한다.

### CMS에 주는 시사점

- 현재 CMS처럼 PostgreSQL 하나에 심볼 저장과 검색을 함께 두는 방식은 MVP에는 적합하다.
- 그러나 텍스트 검색 수요가 늘면 Sourcegraph처럼 전용 검색 엔진 분리가 자연스러운 다음 단계다.
- 특히 "정확한 정의/참조"와 "코드베이스 전역 텍스트 검색"은 서로 다른 워크로드로 봐야 한다.

---

## 3.2 GitHub Code Search / Blackbird

### 요약

GitHub의 최신 코드 검색은 Blackbird라는 전용 엔진 위에 있다. 공개 자료상 핵심은 범용 RDBMS가 아니라 디스크 기반 inverted index를 고도로 최적화한 전용 검색 계층이라는 점이다.

공식 자료:

- https://github.blog/engineering/infrastructure/the-technology-behind-githubs-new-code-search/

### 관찰 포인트

- 전통적인 trigram 대신 sparse-gram 계열 접근을 사용한다.
- 콘텐츠 어드레싱과 중복 제거가 구조적으로 중요하다.
- 저장 포맷과 검색 알고리즘이 검색 워크로드에 맞게 처음부터 설계되어 있다.

### CMS에 주는 시사점

- CMS가 GitHub처럼 검색 엔진 자체를 만들 필요는 없다.
- 다만 "검색"은 결국 검색 전용 엔진이 가장 잘한다는 점은 분명하다.
- PostgreSQL FTS를 장기 전략으로 고정하는 것은 위험하다.

---

## 3.3 Kythe

### 요약

Kythe는 코드를 graph store 관점에서 저장한다. 핵심은 저장 표현과 서빙 표현을 분리한다는 철학이다.

공식 자료:

- https://www.kythe.io/docs/kythe-storage.html

### 관찰 포인트

- 기본 저장 표현은 fact/entry 중심이다.
- 저장 포맷은 compact하고 portable한 쪽에 가깝다.
- 일반적인 검색이나 UI 응답 성능은 primary goal이 아니다.
- serving은 저장소 위에 별도 인덱스를 뽑아 구현하는 방식이다.

### CMS에 주는 시사점

- Kythe식 모델은 "저장 표현은 범용 fact, 서빙 표현은 별도"라는 점에서 아키텍처적으로 매우 정교하다.
- 그러나 현재 CMS 단계에서는 과하다.
- 특히 팀이 SQL 중심 역량을 갖고 있다면, Kythe식 graph store 추상화는 운영 이득보다 구현 복잡도를 더 빨리 가져올 가능성이 크다.

---

## 3.4 Meta Glean

### 요약

Glean은 코드 사실(fact)을 저장하는 팩트 DB다. 공식 문서 기준으로 저장 백엔드는 RocksDB이며, facts는 immutable하고 자동 deduplication된다.

공식 자료:

- https://glean.software/docs/introduction/
- https://glean.software/docs/databases/
- https://glean.software/docs/schema/basic/
- https://glean.software/docs/derived/
- https://glean.software/docs/implementation/incrementality/

### 관찰 포인트

- 데이터 모델은 predicate + fact 구조다.
- query language는 Angle이다.
- schema를 확장해 코드 외의 사실도 함께 저장할 수 있다.
- derived predicates, incrementality 등 대규모 운영을 염두에 둔 기능이 있다.

### 장점

- cross-language 관계와 복잡한 파생 질의에 강하다.
- 증분 처리 모델이 성숙해 보인다.
- fact deduplication이 저장 효율에 유리하다.

### 단점

- SQL/RDBMS와는 운영 모델이 완전히 다르다.
- 팀이 Angle과 predicate schema 설계에 적응해야 한다.
- 일반적인 사내 서비스 팀 입장에서는 도입 비용이 매우 높다.

### CMS에 주는 시사점

- Glean은 “궁극적으로 이런 형태의 fact store까지 갈 수 있다”는 참고 사례로는 좋다.
- 하지만 지금 CMS가 당장 Glean류 저장소로 옮길 이유는 보이지 않는다.
- 현재 단계에서는 Glean의 철학 중 일부만 가져오는 편이 현실적이다.
  - 예: 불변 스냅샷 지향
  - 예: derived relation을 별도 materialize
  - 예: 증분 갱신/소유권 단위 개념

---

## 3.5 CodeQL Database

### 요약

CodeQL은 코드를 데이터베이스로 변환해 질의하는 시스템이다. 공식 문서에서 추출기의 출력인 TRAP과 `.dbscheme` 기반 dataset import 경로가 확인된다.

공식 자료:

- https://codeql.github.com/docs/codeql-overview/about-codeql/
- https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/
- https://docs.github.com/en/code-security/codeql-cli/codeql-cli-manual/dataset-import

### 관찰 포인트

- 목적은 “서빙형 코드 지식 저장소”보다 “정적 분석용 데이터베이스”에 가깝다.
- 단일 레포/단일 스냅샷 중심 워크로드와 더 잘 맞는다.
- 질의 모델은 분석과 보안 규칙에 강하다.

### CMS에 주는 시사점

- CodeQL DB는 CMS의 직접 대체재가 아니다.
- 대신 "정적 분석용 DB"와 "온라인 서빙용 DB"를 구분해야 한다는 점은 참고할 만하다.
- 향후 도메인 분석기(MyBatis/JPA/Spring) 계층을 붙일 때 CodeQL식 오프라인 분석 산출물과 온라인 서빙 데이터를 분리하는 접근은 유효하다.

---

## 3.6 Cursor

### 요약

Cursor의 codebase indexing은 임베딩 중심이다. 공식 문서와 보안 문서 기준으로, 파일 해시/Merkle tree 기반 동기화 후 서버에서 chunk embedding을 만들고 저장한다.

공식 자료:

- https://docs.cursor.com/context/codebase-indexing
- https://cursor.com/blog/secure-codebase-indexing
- https://cursor.com/en-US/security

### 관찰 포인트

- 정확 코드 내비게이션이 아니라 semantic retrieval 최적화가 목적이다.
- 파일 변경 감지는 Merkle tree로 수행한다.
- 서버 측 저장은 vector retrieval에 맞춰져 있다.
- 팀 내 유사 코드베이스 간 index reuse를 적극 활용한다.

### CMS에 주는 시사점

- Cursor식 저장소는 정확 심볼 조회의 대체재가 아니다.
- 하지만 향후 AI context retrieval이 필요할 때는 매우 직접적인 참고 사례다.
- CMS에 벡터 계층을 붙인다면, 관계형 심볼 저장소를 대체하기보다 보조 retrieval plane으로 붙이는 것이 맞다.

---

## 3.7 LanceDB

### 요약

LanceDB는 벡터 검색뿐 아니라 FTS와 scalar index를 함께 제공하는 하이브리드 저장 계층이다.

공식 자료:

- https://docs.lancedb.com/indexing
- https://docs.lancedb.com/indexing/reindexing

### 관찰 포인트

- vector index, full-text search, scalar index를 함께 갖는다.
- 재색인 없이 일부 incremental reindex 전략을 제공한다.
- AI retrieval 워크로드에 적합하다.

### CMS에 주는 시사점

- pgvector를 Postgres에 얹는 것보다 별도 벡터/하이브리드 저장소를 두는 설계가 더 깔끔할 수 있다.
- 다만 CMS의 primary need가 precise symbol navigation이라면 LanceDB가 중심 저장소가 되기보다는 부가 계층이 될 가능성이 크다.

---

## 3.8 OpenGrok

### 요약

OpenGrok는 Lucene 기반 텍스트/크로스레퍼런스 엔진이다. 공식 페이지와 API 문서상 인덱서는 ctags 및 소스 파일 데이터를 Lucene index로 생성한다.

공식 자료:

- https://oracle.github.io/opengrok/
- https://oracle.github.io/opengrok/javadoc/org/opengrok/indexer/index/Indexer.html
- https://oracle.github.io/opengrok/javadoc/org/opengrok/indexer/search/SearchEngine.html

### 관찰 포인트

- 저장 중심은 Lucene index다.
- ctags 기반 cross-reference와 텍스트 검색이 결합돼 있다.
- 현대적인 precise code intel보다는 강한 텍스트/브라우징 계열 도구에 가깝다.

### CMS에 주는 시사점

- OpenGrok는 PostgreSQL FTS의 대체재로 보기보다는, Lucene 계열 검색 엔진이 장기적으로 어떤 운영 모델을 갖는지 보여주는 사례다.
- CMS가 semantic graph와 lexical search를 한 저장소에 합치기보다 분리해야 한다는 점을 다시 확인해 준다.

---

## 4. 패턴 비교

| 사례 | 관계/메타 저장 | 텍스트 검색 저장 | 대형 산출물 저장 | 특징 |
|---|---|---|---|---|
| Sourcegraph | PostgreSQL | Zoekt | blobstore | 가장 실용적인 분리형 |
| GitHub Blackbird | 전용 검색 엔진 | 전용 검색 엔진 | 전용 파일/인덱스 계층 | 검색 특화 극단 |
| Kythe | graph store | 별도 serving index 필요 | 구현체마다 다름 | 저장/서빙 분리 철학 |
| Glean | RocksDB fact DB | 질의는 Angle | DB 내부 fact | 범용 fact store |
| CodeQL | 분석용 DB | 해당 없음 | dataset/TRAP 기반 | 오프라인 분석 지향 |
| Cursor | metadata + vector retrieval | embedding retrieval | 서버 측 인덱스 저장 | AI semantic retrieval 특화 |
| LanceDB | vector/fts/scalar hybrid | 내장 FTS | 테이블 기반 | 하이브리드 retrieval |
| OpenGrok | Lucene + xref 계열 | Lucene | 파일/인덱스 디렉터리 | 텍스트 중심 브라우징 |

---

## 5. 현재 CMS와 비교한 판단

## 5.1 지금 스택의 장점

현재 CMS의 `PostgreSQL + MinIO`는 여전히 합리적이다.

- 팀 운영 역량과 잘 맞는다.
- precise symbol/navigation 저장에는 충분하다.
- object storage 분리가 이미 돼 있다.
- 단순하고 디버깅 가능하다.

즉 "당장 다른 저장소로 갈아타야 한다"는 근거는 없다.

## 5.2 가장 현실적인 다음 단계

외부 사례를 다시 보면, CMS의 다음 단계는 아래 순서가 가장 자연스럽다.

### 1. 전문 검색 분리

가장 우선순위가 높은 대안은 RDBMS 교체가 아니라 텍스트 검색 분리다.

- Sourcegraph의 Zoekt
- GitHub의 Blackbird
- OpenGrok의 Lucene

이 세 사례가 공통으로 보여주는 것은 "검색은 검색 엔진이 맡는다"는 점이다.

### 2. 오브젝트 스토리지 운영 정책 강화

거의 모든 사례가 대형 산출물을 메타데이터 저장소와 분리한다.  
CMS는 이미 MinIO를 쓰고 있으므로, 방향은 맞다. 부족한 것은 저장소 종류가 아니라 보존/GC/캐시 정책이다.

### 3. AI retrieval은 별도 계층으로 붙이기

Cursor와 LanceDB 사례는 vector retrieval이 필요해질 수 있음을 보여준다.  
다만 이 계층은 precise symbol DB를 대체하지 않는다.

권장 방향:

- primary store: PostgreSQL + MinIO 유지
- text search plane: Zoekt 등 별도 도입 검토
- semantic retrieval plane: pgvector 또는 별도 vector store 검토

### 4. fact store / graph store는 장기 과제

Kythe나 Glean은 강력하지만 현재 CMS의 문제를 가장 빠르게 해결하는 수단은 아니다.

- 운영 복잡도 증가
- 스키마/질의 언어 학습 비용
- 서빙 계층 추가 구현 필요

현재 팀 상황에서는 "장기 연구 주제"가 더 정확하다.

---

## 6. 추천안

## 추천안 A. 현재 스택 유지 + Zoekt 분리

가장 현실적이고 외부 사례와도 가장 잘 맞는 방향이다.

- PostgreSQL: 심볼, 참조, 관계, 메타데이터
- MinIO: `.scip`, `source.zip`
- Zoekt: 코드 텍스트 검색

적합도:

- 구현 난이도: 낮음~중간
- 운영 난이도: 중간
- CMS 현재 구조와 정합성: 높음

## 추천안 B. 현재 스택 유지 + 벡터 계층 추가

AI 검색 수요가 커질 때의 옵션이다.

- PostgreSQL: 정확 심볼 데이터
- MinIO: 원본 blob
- pgvector 또는 LanceDB류: semantic retrieval

적합도:

- 구현 난이도: 중간
- 운영 난이도: 중간
- 직접적인 사용자 가치: AI 워크플로우가 있을 때 큼

## 비추천안 C. Glean/Kythe 류로 조기 전환

연구 가치는 높지만 현재 프로젝트 단계에서는 비추천이다.

- 초기 투자 비용이 크다.
- 구현보다 모델링과 운영 복잡도가 먼저 온다.
- 현재 pain point를 가장 빠르게 해결하지 못한다.

---

## 7. 결론

외부 사례를 다시 보면, CMS가 지금 당장 바꿔야 할 것은 "기본 저장소 선택"보다 "저장 계층의 역할 분리"다.

핵심 판단은 아래와 같다.

1. PostgreSQL + MinIO 자체는 여전히 타당하다.
2. 장기적으로 PostgreSQL FTS를 검색 주력으로 유지하는 것은 불리하다.
3. 다음 투자 우선순위는 graph DB 전환이 아니라 검색 전용 계층 분리다.
4. 벡터 검색은 symbol/navigation plane을 대체하지 않고 보조한다.
5. Glean/Kythe는 참고 사례로는 훌륭하지만, 현재 CMS에는 연구 주제로 두는 편이 낫다.

따라서 현 시점의 가장 현실적인 방향은 다음 한 줄로 요약된다.

> CMS는 `PostgreSQL + MinIO`를 유지하되, 텍스트 검색과 AI retrieval을 별도 plane으로 분리하는 방향으로 확장하는 것이 가장 합리적이다.

---

## 8. 참고 링크

- Sourcegraph Architecture: https://sourcegraph.com/docs/admin/architecture
- Sourcegraph PostgreSQL: https://sourcegraph.com/docs/admin/postgres
- GitHub Blackbird: https://github.blog/engineering/infrastructure/the-technology-behind-githubs-new-code-search/
- Kythe Storage Model: https://www.kythe.io/docs/kythe-storage.html
- Glean Introduction: https://glean.software/docs/introduction/
- Glean Databases: https://glean.software/docs/databases/
- Glean Schema Basics: https://glean.software/docs/schema/basic/
- Glean Derived Predicates: https://glean.software/docs/derived/
- Glean Incrementality: https://glean.software/docs/implementation/incrementality/
- CodeQL Overview: https://codeql.github.com/docs/codeql-overview/about-codeql/
- CodeQL QL Language: https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/
- CodeQL Dataset Import: https://docs.github.com/en/code-security/codeql-cli/codeql-cli-manual/dataset-import
- Cursor Codebase Indexing: https://docs.cursor.com/context/codebase-indexing
- Cursor Securely Indexing Large Codebases: https://cursor.com/blog/secure-codebase-indexing
- Cursor Security: https://cursor.com/en-US/security
- LanceDB Indexing: https://docs.lancedb.com/indexing
- LanceDB Reindexing: https://docs.lancedb.com/indexing/reindexing
- OpenGrok: https://oracle.github.io/opengrok/
- OpenGrok Indexer API: https://oracle.github.io/opengrok/javadoc/org/opengrok/indexer/index/Indexer.html
- OpenGrok SearchEngine API: https://oracle.github.io/opengrok/javadoc/org/opengrok/indexer/search/SearchEngine.html
