# 코드 인텔리전스 스토리지 백엔드 — 업계 사례 조사

> 작성일: 2026-04-17 | 범위: 스토리지 백엔드 (인덱서·질의 레이어 제외) | 용도: ADR 의사결정 참조용

---

## 1. 개요

이 문서는 코드 인텔리전스 시스템에서 스토리지 백엔드로 어떤 기술을 사용하는지 업계 사례를 조사한 결과물이다. 인덱서(SCIP, LSP 추출기 등), 질의 API 레이어, AI 모델 선택은 범위 외다. 순수하게 "인덱스 데이터와 소스 블롭을 어떻게 저장하고 검색하는가"에 집중한다.

**작성 동기**: 현재 CMS(codebase-memory-sync)는 PostgreSQL FTS + MinIO 스택으로 v1을 운영 중이다. 이 문서는 향후 v2+ 확장 시 ADR(Architecture Decision Record) 의사결정의 참조 자료로 활용된다. 현재 구현을 변경하는 것이 목적이 아니다.

**자료 수집 방법**: WebSearch + WebFetch로 공개 블로그, 공식 문서, GitHub 저장소를 수집. 모든 주장에 출처 링크 또는 `[unverified]` 태그를 명시한다. 국내 기업은 공식 Tech 블로그 URL만 인용하며, 비공개 구현은 추정하지 않는다.

---

## 2. 현 CMS 스택 요약

### 2.1 스택 구성

| 컴포넌트 | 기술 | 용도 |
|---------|------|------|
| 관계형 DB | PostgreSQL 15 | 심볼(symbol), 참조(reference), 정의(definition) 레코드 + FTS |
| 오브젝트 스토리지 | MinIO (S3 호환) | SCIP `.scip` 블롭, `source.zip` 블롭 |
| 풀텍스트 검색 | `tsvector` + GIN index + `to_tsquery` | 어휘 기반 심볼 검색 |
| 임베딩/벡터 | 없음 (미도입) | — |

### 2.2 주요 한계점

1. **어휘 검색만 가능**: `to_tsquery`는 정규화된 토큰 매칭이다. 시맨틱 유사도(semantic similarity) 검색, 오탈자 허용 검색은 지원하지 않는다.
2. **FTS 스케일 제약**: PostgreSQL FTS는 수십만 개 이상의 심볼 레코드에서 랭킹 품질이 떨어진다. 전문 검색 엔진(Elasticsearch, Zoekt 등) 대비 수평 확장이 어렵다.
3. **그래프 쿼리 불가**: 심볼 간 의존 관계를 여러 홉(hop) 추적하는 recursive CTE는 가능하지만, 복잡한 cross-language 참조 그래프는 RDBMS에 자연스럽지 않다.
4. **벡터 검색 미지원**: pgvector 미설치 상태. AI 컨텍스트 검색(semantic code search) 요구가 생기면 별도 확장이 필요하다.
5. **MinIO 블롭 비용**: SCIP 파일은 크기가 크다. 저장·전송 비용이 repo 수에 선형 비례한다.

관련 ADR: ADR-001 (PostgreSQL 채택), ADR-003 (MinIO/S3 채택), ADR-004 (FTS 방식 결정).

---

## 3. 스토리지 유형 분류

이 절은 업계에서 코드 인텔리전스 데이터를 저장하는 방식을 4가지 유형으로 분류한다.

### 3.1 Lexical / Full-text 엔진

텍스트 토큰의 역인덱스(inverted index)를 파일(shard)에 저장한다. trigram, n-gram, BM25 랭킹이 주된 검색 모델이다.

- **대표 기술**: Zoekt (trigram shard), Blackbird (sparse-gram Rust 엔진), Elasticsearch/OpenSearch
- **강점**: 구축 간단, 스케일 아웃 용이, 정확한 심볼명/패턴 매칭
- **약점**: 시맨틱 유사도 없음, 토큰화 전략이 정확도에 영향

### 3.2 구조·관계형 DB (RDBMS + 그래프 확장)

AST, 심볼 정의·참조, 의존 관계를 테이블로 표현한다. SQL 쿼리와 recursive CTE, 혹은 pgvector로 확장한다.

- **대표 기술**: PostgreSQL (CMS 현재 스택), CodeQL `.dbscheme` 관계형 DB, SQLite
- **강점**: 트랜잭션, 복잡한 조인, 성숙한 운영 생태계
- **약점**: 그래프 다중 홉 쿼리 성능, FTS 스케일 한계

### 3.3 전용 그래프 DB / 팩트 DB

코드 요소를 노드·엣지 또는 팩트(fact) 단위로 저장하고 그래프 순회 쿼리를 지원한다.

- **대표 기술**: Kythe GraphStore (LevelDB / Bigtable), Meta Glean (RocksDB 팩트 DB)
- **강점**: cross-language 참조 추적, 복잡한 의미론적 쿼리
- **약점**: 운영 복잡도 높음, 스키마 설계 난이도, 학습 곡선

### 3.4 Vector DB / Embedding 기반

코드 청크를 임베딩 벡터로 변환해 ANN(Approximate Nearest Neighbor) 인덱스에 저장한다.

- **대표 기술**: Turbopuffer (Cursor), LanceDB (Continue.dev), pgvector (PostgreSQL 확장)
- **강점**: 시맨틱 유사도 검색, AI 컨텍스트 retrieval에 최적
- **약점**: 정확한 심볼명 검색 불리, 임베딩 모델 종속, 인덱스 재구축 비용

---

## 4. 업계 사례 — 해외

---

### 4.1 Sourcegraph — Postgres + Zoekt + Blobstore

#### 스택 구성

Sourcegraph는 세 종류의 스토리지를 목적별로 분리한다. PostgreSQL은 사용자 데이터, 레포 메타데이터, code insights, 그리고 SCIP 인덱스 메타데이터를 저장한다. Zoekt는 전문 검색(full-text, 파일명, 심볼 검색)을 위한 trigram 기반 shard 파일로 구성된 별도 서비스다. Blobstore(구 MinIO, v4.2.1+ 이후 자체 구현으로 교체)는 SCIP/LSIF 업로드 파일과 검색 작업 결과를 저장하는 로컬 S3 호환 오브젝트 스토리지다.

[출처: Sourcegraph docs - External Services](https://sourcegraph.com/docs/admin/external_services) | [출처: Sourcegraph docs - Blobstore update notes](https://docs.sourcegraph.com/admin/how-to/blobstore_update_notes)

#### 쓰기 경로

1. CI/CD 또는 auto-indexer가 SCIP 파일을 HTTP 업로드 → Blobstore에 블롭 저장
2. `precise-code-intel` 워커가 블롭을 파싱 → PostgreSQL `codeintel-db`에 관계 레코드 삽입
3. Zoekt `indexserver`가 Git 저장소를 클론하여 trigram shard 파일 생성 → 디스크 저장

#### 읽기/검색 모델

- **정확 코드 내비게이션**: PostgreSQL에서 심볼 정의·참조 조인 쿼리
- **퍼지 텍스트 검색**: Zoekt shard에서 trigram 포스팅 리스트 쿼리
- **Cody 컨텍스트**: BM25 기반 Sourcegraph Search API를 통해 파일 스니펫 검색

#### 규모

- `zoekt-webserver`와 `zoekt-indexserver`는 수평 확장 가능
- `codeintel-db` 스토리지: 인덱싱된 레포 총 크기의 약 4배 필요
- Blobstore: 가장 큰 LSIF/SCIP 인덱스 파일 크기만큼 할당

[출처: Sourcegraph docs - Scaling Overview](https://sourcegraph.com/docs/admin/deploy/scale)

#### CMS와의 차이

CMS는 PostgreSQL 하나에 FTS와 심볼 저장을 통합했으나, Sourcegraph는 용도에 따라 3개 스토어를 분리한다. 특히 전문 텍스트 검색을 PostgreSQL FTS가 아닌 전용 Zoekt 엔진에 위임한다는 점이 핵심 차이다.

---

### 4.2 GitHub Code Search — Blackbird

#### 스택 구성

GitHub은 2023년 Blackbird라는 자체 코드 검색 엔진을 Rust로 개발해 출시했다. 전통적인 trigram 대신 "sparse gram" 방식으로 동적 gram 크기를 사용해 빈도 높은 패턴의 false positive를 줄인다. 인덱스는 디스크 기반 inverted index로 저장하며, 포스팅 리스트를 메모리에 통째로 적재하지 않는 lazy iterator 패턴을 사용한다.

[출처: GitHub Blog - The technology behind GitHub's new code search](https://github.blog/engineering/infrastructure/the-technology-behind-githubs-new-code-search/)

#### 쓰기 경로

1. Kafka 이벤트 스트림으로 변경된 Git 블롭을 인덱싱 샤드에 배포
2. Git blob object ID를 샤딩 키로 사용 → 균등 분산 + 콘텐츠 어드레싱 기반 중복 제거
3. delta encoding으로 저장소 간 중복 콘텐츠를 최소화

#### 읽기/검색 모델

- sparse-gram inverted index에서 포스팅 리스트를 lazy하게 순회
- k-way merge + compaction으로 관련도 기반 랭킹
- Redis로 쿼터 관리 및 접근 제어 캐싱

#### 규모

- 4,500만 개 저장소 인덱싱 (베타 기준)
- 원본 코드 총 115 TB, 중복 제거 후 28 TB
- 최종 인덱스 크기 25 TB (압축 콘텐츠 사본 포함)
- 초당 12만 개 문서 인제스트 처리량
- 전체 코퍼스 재인덱싱 약 18시간

#### CMS와의 차이

Blackbird는 범용 DB를 전혀 사용하지 않는다. 코드 검색에 특화된 자체 inverted index 파일 포맷과 Rust 엔진을 사용한다는 점이 CMS와 근본적으로 다르다. Git blob ID 기반 콘텐츠 어드레싱으로 수십억 개 파일 규모의 중복 제거를 달성한다.

---

### 4.3 Google Kythe — GraphStore

#### 스택 구성

Kythe는 Google이 오픈소스로 공개한 코드 크로스-레퍼런스 시스템이다. 스토리지 추상화 계층을 **GraphStore**라고 부르며, 백엔드를 교체 가능한 인터페이스로 설계했다. 기본 구현체는 LevelDB(로컬 단일 노드)와 BigTable(분산)이며, SQL(PostgreSQL/SQLite) 구현체도 제공한다.

[출처: Kythe 공식 스토리지 문서](https://kythe.io/docs/kythe-storage.html)

#### 쓰기 경로

분석기(extractor)가 코드를 분석해 **Entry**라는 기본 단위를 생성한다. 각 Entry는 `(source, kind, target, fact, value)` 5-튜플 구조다. Source와 target은 VName(Vector-Name: corpus, language, path, signature, root 5차원)으로 식별된다. 이 Entry들이 GraphStore에 삽입된다.

#### 읽기/검색 모델

GraphStore는 3가지 연산만 지원한다:
- **Read**: source ticket과 kind 필터로 엔트리 조회
- **Scan**: target, kind, fact prefix로 전체 테이블 스캔
- **Shard**: 분산 처리를 위한 source|kind 핑거프린트 기반 파티셔닝

의도적으로 복잡한 쿼리를 지원하지 않는다. "저장 표현"과 "서빙 표현"을 분리하며, 서빙 시스템(xrefs 서버 등)은 이 스토리지 위에 별도로 구현된다.

#### 규모

Google 내부에서는 BigTable 백엔드로 수억 개 파일 규모로 운영 [unverified — Google 내부 규모는 공개 자료 없음]. 오픈소스 버전은 LevelDB 기반으로 중소 규모 레포지토리에 적합하다.

#### CMS와의 차이

Kythe는 "사실(fact)"을 기본 단위로 저장하는 팩트 DB 개념이다. CMS의 row-oriented PostgreSQL 테이블 구조와 달리, 5-튜플 엔트리로 코드의 모든 시맨틱 관계를 균일하게 표현한다. 스토리지 백엔드를 교체할 수 있는 추상화 계층이 CMS에는 없다.

---

### 4.4 Meta Glean — Haskell 팩트 DB

#### 스택 구성

Meta(Facebook)가 개발하고 2024년 오픈소스로 공개한 Glean은 소스 코드에 관한 "사실(fact)"을 수집·저장·질의하는 시스템이다. 스토리지 백엔드는 **RocksDB**다. 데이터 모델은 사용자 정의 스키마로 구성된 predicate(테이블 역할)와 fact(행 역할)로 이루어진다. 팩트는 불변(immutable)이며 스토리지 백엔드에서 자동 중복 제거된다.

[출처: Meta Engineering Blog - Indexing code at scale with Glean (2024-12-19)](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)

#### 쓰기 경로

1. 언어별 인덱서(indexer)가 코드를 분석해 언어 고유 스키마의 fact 생성
2. Glean 서버에 fact 배치 삽입 → RocksDB에 영속 저장 + 자동 중복 제거
3. **증분 인덱싱**: 변경된 파일의 팬아웃(fanout) 규모로만 재처리 (전체 재인덱싱 불필요)

#### 읽기/검색 모델

**Angle**이라는 선언적 논리 기반 질의 언어를 사용한다 (Haskell로 구현). Angle은 Datalog의 영향을 받았으며, 두 가지 파생 모드를 지원한다:
- 쿼리 시간 on-the-fly 파생
- 사전 계산(ahead-of-time derivation)

단순 조회는 약 1ms, 복잡한 쿼리는 수 ms 내 첫 결과 반환.

#### 규모

Meta 내부에서 코드 브라우징, 코드 검색, 문서 생성 등 다양한 개발 도구를 지원. 정확한 repo 수와 팩트 수는 공개되지 않음 [unverified].

#### CMS와의 차이

CMS는 SCIP가 제공하는 특정 관계(정의, 참조)만 PostgreSQL 테이블에 저장한다. Glean은 임의의 코드 사실을 사용자 정의 스키마로 저장할 수 있는 범용 팩트 DB다. RocksDB 기반의 키-값 스토리지 위에 논리 쿼리 레이어를 얹은 구조다.

---

### 4.5 GitHub CodeQL — 관계형 튜플 DB + Datalog

#### 스택 구성

CodeQL은 코드를 **관계형 데이터베이스**로 변환한 후 Datalog 방언인 QL로 쿼리하는 시스템이다. 내부적으로 코드 추출기(extractor)가 소스를 파싱해 **TRAP 파일**(structured text, 튜플 집합)을 생성하고, 이를 언어별 `.dbscheme` 스키마 정의에 따라 관계형 DB로 임포트한다. 생성된 데이터베이스는 단일 디렉토리 형태다.

[출처: CodeQL docs - About CodeQL](https://codeql.github.com/docs/codeql-overview/about-codeql/) | [출처: CodeQL docs - QL language reference](https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/) | [출처: CodeQL glossary - bqrs file](https://codeql.github.com/docs/codeql-overview/codeql-glossary/)

#### 쓰기 경로

1. 언어별 extractor가 컴파일 과정을 추적하거나 소스를 직접 파싱 → TRAP 파일 생성
2. TRAP 파일의 튜플들을 `.dbscheme`에 따라 관계형 테이블로 임포트
3. 결과: AST, 데이터 플로우 그래프, 제어 흐름 그래프를 포함하는 단일 디렉토리 DB

내부 저장 포맷은 공식 문서에서 SQLite라고 명시하지 않는다 [unverified — SQLite 또는 자체 바이너리 포맷 추정].

#### 읽기/검색 모델

QL은 집합 연산의 연쇄로 쿼리를 표현한다. Datalog의 계층적(stratified) 의미론을 따르며, 재귀 술어(recursive predicate)를 지원한다. 결과는 `.bqrs` (binary query result set) 파일로 출력된다. 코드 분석과 취약점 탐지에 특화된 쿼리 모델이다.

#### 규모

CI/CD 파이프라인에서 단일 레포 단위로 DB를 생성해 분석한다. 수백만 라인 규모의 레포지토리에서 수분 내 분석 완료. GitHub Actions와 통합되어 수천만 개 레포에 적용 중 [unverified — 전체 적용 규모].

#### CMS와의 차이

CodeQL DB는 특정 시점의 단일 저장소 스냅샷을 위한 1회성 분석 DB다. CMS는 다수 repo의 최신 인덱스를 지속적으로 유지·서빙한다는 점에서 근본적 목적이 다르다. CodeQL은 쓰기 후 읽기(write-once, read-many) 패턴이고 CMS는 지속적 업데이트 패턴이다.

---

### 4.6 Cursor / Continue.dev / Sourcegraph Cody — Vector + Hybrid

이 세 도구는 AI 코드 어시스턴트로서 컨텍스트 retrieval에 스토리지를 사용한다. 각각 다른 접근법을 취한다.

---

#### 4.6.1 Cursor — Turbopuffer + Merkle Tree 캐시

##### 스택 구성

Cursor는 코드 청크(chunk) 임베딩을 **Turbopuffer**에 저장한다. Turbopuffer는 오브젝트 스토리지 기반의 서버리스 벡터+풀텍스트 하이브리드 검색 엔진이다. 원본 소스 코드는 서버에 저장하지 않는다.

[출처: Cursor - Securely indexing large codebases](https://cursor.com/blog/secure-codebase-indexing) | [출처: Towards Data Science - How Cursor Actually Indexes Your Codebase](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/) | [출처: Engineer's Codex - How Cursor Indexes Codebases Fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast)

##### 쓰기 경로

1. 프로젝트 오픈 시 **Merkle tree** 구축 — 변경된 파일/디렉토리만 감지
2. 코드를 함수 단위 청크로 분할 → 로컬 암호화 후 obfuscated 식별자와 함께 Cursor 서버로 전송
3. 자체 임베딩 모델로 벡터 생성 → Turbopuffer에 저장
4. 임베딩은 청크 해시를 키로 AWS에 캐시 → 변경 없는 코드는 재임베딩 불필요

##### 읽기/검색 모델

- 쿼리를 동일 임베딩 모델로 벡터화 → Turbopuffer에서 ANN 검색
- 파일 경로, 라인 범위 메타데이터로 스칼라 필터링
- 원본 코드는 로컬에서만 참조

##### 규모

대형 모노레포를 포함한 모든 크기의 코드베이스를 지원 [unverified — 공개된 상한선 없음].

##### CMS와의 차이

CMS는 심볼 정의·참조 관계를 정확하게 저장하는 구조적 DB를 지향하나, Cursor는 시맨틱 유사도 기반 청크 검색에 집중한다. 저장 단위(청크 vs 심볼), 검색 모델(벡터 ANN vs FTS), 프라이버시 모델도 근본적으로 다르다.

---

#### 4.6.2 Continue.dev — 로컬 LanceDB

##### 스택 구성

Continue.dev는 **LanceDB**를 임베디드 벡터 DB로 채택했다. LanceDB는 TypeScript 네이티브 임베디드 라이브러리로 디스크 기반 Lance 컬럼형 포맷에 데이터를 저장한다. 모든 데이터는 `~/.continue` 로컬 디렉토리에만 저장된다.

[출처: LanceDB Blog - The Future of AI-Native Development is Local](https://lancedb.com/blog/the-future-of-ai-native-development-is-local-inside-continues-lancedb-powered-evolution/) | [출처: Continue.dev Blog - Building a Semantic Code History Search with LanceDB](https://blog.continue.dev/building-a-semantic-code-history-search-with-lancedb/)

##### 쓰기 경로

1. 코드베이스를 10줄 단위 고정 블록으로 청킹
2. 임베딩 모델(예: Voyage AI code embedding) 적용 → 고차원 벡터 생성
3. LanceDB에 스키마 `(uuid, path, cachekey, vector, startLine, endLine, contents)` 형태로 저장

##### 읽기/검색 모델

- ANN 벡터 검색 + SQL-like 스칼라 필터링 (언어, 프로젝트, 태그)
- 서브-밀리초 조회 응답

##### 규모

1,000만 줄 코드베이스 → 약 100만 벡터. 메모리 과다 사용 없이 처리 가능.

##### CMS와의 차이

LanceDB는 클라우드 인프라 없이 로컬에서 완전히 동작하는 프라이버시 우선 벡터 DB다. CMS가 원격 MinIO + PostgreSQL을 사용하는 서버 모델인 것과 대조된다.

---

#### 4.6.3 Sourcegraph Cody — Zoekt 기반 하이브리드 (임베딩 폐기)

##### 스택 구성

Cody Enterprise는 2024년 임베딩 기반 컨텍스트 검색을 **폐기**하고, Sourcegraph Search(Zoekt)를 기본 컨텍스트 프로바이더로 전환했다. 하이브리드 검색 전략을 사용한다:
- **키워드 검색**: Zoekt trigram 기반 정확 매칭 및 유사 변형
- **그래프 기반 검색**: SCIP 정적 분석 기반 심볼 참조 추적
- **로컬 컨텍스트**: IDE에 열려 있는 파일에서 직접 스니펫 추출

[출처: Sourcegraph Blog - How Cody understands your codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase) | [출처: Sourcegraph Blog - Lessons from building AI coding assistants](https://sourcegraph.com/blog/lessons-from-building-ai-coding-assistants-context-retrieval-and-evaluation)

##### 임베딩 폐기 이유

공식 블로그에 따르면 임베딩의 문제점:
1. 코드를 외부 임베딩 API로 전송해야 하는 보안 위험
2. 관리자의 설정 복잡도
3. 100,000개 이상 레포에서 벡터 DB 검색의 복잡도와 리소스 비용

##### CMS와의 차이

Cody의 교훈은 "벡터 검색이 반드시 키워드 검색보다 우월하지 않다"는 것이다. CMS가 현재 가진 FTS 기반 접근은 Cody가 회귀한 방향과 일치한다. 다만 Cody는 Zoekt라는 전문 엔진을 쓰고 CMS는 PostgreSQL FTS를 쓴다는 차이가 있다.

---

### 4.7 추가 사례 — Zoekt 단독 아키텍처

Zoekt는 Sourcegraph와 독립적으로 사용 가능한 오픈소스 코드 검색 엔진이다. 아키텍처를 별도로 정리한다.

[출처: Zoekt GitHub - sourcegraph/zoekt](https://github.com/sourcegraph/zoekt)

#### 스택 구성

Zoekt는 디스크의 **shard 파일** 단위로 인덱스를 저장한다. 각 shard는 하나의 저장소를 표현하며, 메모리 맵(memory-mapped)으로 접근한다. DB 서버가 별도로 필요하지 않다.

#### Shard 내부 데이터 레이아웃

각 shard 파일에 다음 데이터가 포함된다:
- 원본 파일 내용 (content copy)
- 파일명 목록
- 콘텐츠 포스팅 리스트 (varint 인코딩)
- 파일명 포스팅 리스트 (varint 인코딩)
- 브랜치 마스크 (어떤 브랜치에 파일이 존재하는지 bitmask)
- 메타데이터 (레포 이름, 포맷 버전)

#### 인덱스 구조

Zoekt는 **위치 기반 trigram**(positional trigrams)을 사용한다. 단순 존재 여부가 아니라 byte offset을 기록한다. 예: "banana" → `"ban":0, "ana":1,3, "nan":2`. 멀티-텀 쿼리 시 trigram 간 거리를 검증해 false positive를 제거한다.

#### 스케일 특성

- 인덱스 크기: 원본 코퍼스 크기의 약 3–3.5배 (2배 오프셋 + 1배 원본 콘텐츠)
- shard당 최대 4 GB (32-bit offset 제약) → 대형 레포는 멀티 shard 필요
- 한 shard당 원본 콘텐츠 약 1 GB

#### CMS와의 차이

CMS FTS는 PostgreSQL `tsvector` + GIN index로 심볼 텍스트를 저장한다. Zoekt shard는 소스 코드 전체의 원본 콘텐츠 + trigram 포스팅 리스트를 별도 파일로 저장한다. Zoekt는 코드 레벨 정확 매칭에 최적화되고, CMS FTS는 심볼 레코드 어휘 검색에 최적화된 구조다.

---

## 5. 업계 사례 — 국내 (공개 자료 한정)

국내 기업의 코드 인텔리전스 스토리지 아키텍처에 대한 공개 Tech 블로그 자료를 검색했다. 다음은 각 기업별 조사 결과다.

### 5.1 NAVER (d2.naver.com)

**조사 결과**: NAVER D2 블로그(d2.naver.com)에서 "코드 검색", "코드 인텔리전스", "심볼 검색" 관련 공개 자료를 웹 검색으로 확인했으나, 코드 인텔리전스 **스토리지 백엔드**를 설명하는 글은 발견되지 않았다. NAVER는 Elasticsearch를 클라우드 플랫폼 상품으로 제공하며, 형태소 분석기 기반 한국어 텍스트 검색 관련 글은 다수 존재하나 내부 개발 플랫폼의 코드 검색 아키텍처는 공개된 자료가 없다.

**결론**: 코드 인텔리전스 특화 공개 자료 없음.

### 5.2 카카오 (tech.kakao.com)

**조사 결과**: tech.kakao.com에서 코딩 테스트 해설, 코드 리뷰 도입 사례, AI 가드레일 등의 글은 다수 발견되었으나, 내부 코드 인텔리전스 플랫폼이나 심볼 검색 스토리지를 설명하는 글은 없었다. if(kakao) 컨퍼런스 발표 목록도 확인했으나 해당 주제의 공개 발표는 찾지 못했다.

**결론**: 코드 인텔리전스 특화 공개 자료 없음.

### 5.3 LINE (engineering.linecorp.com)

**조사 결과**: engineering.linecorp.com에서 "code search", "코드 검색" 관련 검색을 수행했다. iOS 코드 서명, Messaging API 관련 글 등이 나타났으나, 코드 인덱싱이나 심볼 검색 스토리지를 다루는 글은 확인되지 않았다. LINE Engineering은 주로 서비스 아키텍처, 모바일, 인프라 운영 관련 글을 공개하고 있으며 내부 개발 도구 스택은 공개하지 않는 것으로 보인다.

**결론**: 코드 인텔리전스 특화 공개 자료 없음.

### 5.4 토스 (toss.tech)

**조사 결과**: toss.tech에서 개발 도구, 코드 검색, 인프라 관련 검색을 수행했다. Feature Store & Trainkit(ML 인프라), Open API 생태계, 레거시 시스템 현대화 관련 글은 발견되었으나, 심볼 검색이나 코드 인텔리전스 스토리지에 특화된 내용은 찾을 수 없었다. LLM 기반 코드 관련 언급은 일부 있으나 스토리지 아키텍처 수준의 공개 자료는 아니다.

**결론**: 코드 인텔리전스 특화 공개 자료 없음.

### 5.5 국내 조사 소결

4개 기업 모두 코드 인텔리전스 스토리지 백엔드를 공개한 Tech 블로그 자료가 없다. 국내 대형 Tech 기업들은 서비스 아키텍처, 데이터 플랫폼, ML 인프라는 활발히 공개하지만, 내부 개발 플랫폼(코드 검색, 심볼 내비게이션 등)은 비공개로 유지하는 경향이 있다. 향후 Deview(NAVER), if(kakao) 발표 영상을 추가 검색하면 단편적 자료를 얻을 수 있을 가능성은 있다.

---

## 6. 비교 매트릭스

아래 표는 각 시스템의 스토리지 특성을 비교한다.

| 시스템 | 쓰기 경로 | 읽기 모델 | 쿼리 타입 | 스케일 특성 | 운영 비용 | MVP 적합도 | AI 컨텍스트 적합도 | 현재 CMS 대비 |
|--------|-----------|----------|----------|------------|---------|-----------|-----------------|-------------|
| **현재 CMS** (PostgreSQL FTS + MinIO) | SCIP 파싱 → PG INSERT + MinIO PUT | PG FTS tsvector GIN | 어휘 검색, 구조화 조인 | 수십만 심볼까지 적합. 수평 확장 어려움 | 낮음 (PostgreSQL + MinIO 운영 경험 충분) | ★★★★★ | ★★☆☆☆ (벡터 없음) | 기준선 |
| **Sourcegraph** (PG + Zoekt + Blobstore) | 3-tier 분리: PG/Zoekt/Blobstore 각각 별도 쓰기 | 정확 내비게이션=PG, 텍스트=Zoekt shard | 정확 조인 + trigram FTS + BM25 | 수만 repo 이상, shard 수평 확장 | 중간~높음 (3개 스토어 운영) | ★★★☆☆ | ★★★★☆ (Zoekt+SCIP hybrid) | 텍스트 검색을 전용 엔진으로 분리 |
| **GitHub Blackbird** (자체 inverted index) | Kafka → Rust 인덱서 → 디스크 sparse-gram 인덱스 | Lazy iterator 포스팅 리스트 순회 | Sparse-gram 역인덱스 + BM25 랭킹 | 4,500만 repo, 115 TB, 초당 12만 문서 | 매우 높음 (자체 엔진 유지) | ★☆☆☆☆ (대기업 전용) | ★★★☆☆ | 별도 DB 없이 순수 파일 기반 인덱스 |
| **Google Kythe** (GraphStore/LevelDB) | Extractor → 5-튜플 Entry → LevelDB/Bigtable | Read/Scan/Shard 3가지 연산만 | 팩트 기반 그래프 순회 | LevelDB: 단일 노드. Bigtable: 무제한 | 높음 (별도 서빙 레이어 필요) | ★★☆☆☆ | ★★★☆☆ | 5-튜플 팩트 모델 vs row-oriented 테이블 |
| **Meta Glean** (RocksDB + Angle) | 언어별 indexer → RocksDB 팩트 DB (자동 중복 제거) | Angle 쿼리 (on-the-fly 또는 사전 파생) | Datalog 방언 선언적 쿼리 | Meta 전사 (정확한 규모 비공개) | 높음 (Haskell 스택, 커스텀 쿼리 언어) | ★★☆☆☆ | ★★★★☆ | 범용 팩트 DB vs 특화 심볼 테이블 |
| **CodeQL** (관계형 튜플 DB) | Extractor → TRAP 파일 → 관계형 DB 디렉토리 | QL 집합 연산 (stratified Datalog) | Datalog 재귀 쿼리, 데이터플로우 분석 | 단일 repo 스냅샷. CI 파이프라인 단위 | 중간 (GitHub Actions 통합 시 낮음) | ★★★☆☆ (보안 분석 특화) | ★★☆☆☆ | 1회성 분석 DB vs 지속 서빙 DB |
| **Cursor** (Turbopuffer 벡터) | 청크 → 임베딩 → Turbopuffer (cloud) | ANN 벡터 검색 + 스칼라 메타 필터 | 시맨틱 유사도 검색 | 모든 크기 지원 (클라우드 서버리스) | 중간 (Turbopuffer SaaS 의존) | ★★★☆☆ | ★★★★★ | 구조 없는 청크 vs 심볼 구조화 |
| **Continue.dev** (LanceDB 로컬) | 청크(10줄) → 임베딩 → LanceDB (~/.continue) | ANN + SQL-like 필터 | 시맨틱 유사도 + 스칼라 필터 | ~100만 벡터 (1,000만 줄 기준) | 낮음 (로컬 only, 인프라 없음) | ★★★★☆ (로컬 환경) | ★★★★★ | 로컬 임베디드 vs 원격 서버 아키텍처 |
| **Sourcegraph Cody** (Zoekt hybrid) | Zoekt shard + SCIP → PG (임베딩 폐기) | BM25 + 그래프 참조 + 로컬 파일 | 키워드 + 구조적 + 로컬 컨텍스트 | Sourcegraph 스케일 의존 | Sourcegraph 전체 스택 필요 | ★★☆☆☆ | ★★★★☆ | 임베딩 폐기 후 키워드 회귀 — CMS 방향성과 유사 |
| **pgvector** (PostgreSQL 확장) | PG INSERT + vector 컬럼 | HNSW/IVFFlat ANN | 벡터 유사도 + SQL 조인 | 수백만 벡터까지 적합 | 낮음 (기존 PG 클러스터 확장) | ★★★★★ | ★★★★☆ | 현재 CMS에 가장 쉬운 AI 컨텍스트 확장 경로 |
| **Zoekt 단독** (trigram shard) | Git 저장소 → shard 파일 (disk) | Trigram 포스팅 리스트 (memory-mapped) | 정확 매칭 + 근접 거리 검증 | shard당 ~1 GB 콘텐츠, 4 GB 상한 | 낮음~중간 (별도 프로세스 추가) | ★★★☆☆ | ★★★☆☆ | FTS를 PG에서 Zoekt로 외주화 |

---

## 7. CMS 격차 분석

이 절은 "언제 현재 스택이 한계에 도달하는가"를 구체적 임계점으로 분석한다. 아래 수치는 PostgreSQL 문서, 업계 사례, 팀 운영 경험을 기반으로 한 **추정값**이다 [unverified — 실제 임계점은 하드웨어·쿼리 패턴·스키마 설계에 따라 다를 수 있음].

### 7.1 심볼 수 — FTS 품질 저하

**임계점**: 심볼 레코드 약 50만–100만 개 이상 (`symbols` 테이블)

PostgreSQL `tsvector` + GIN index는 이 규모 이상에서 랭킹 품질이 저하된다. `ts_rank`는 문서 빈도 기반 통계를 레포 전체에 걸쳐 계산하지 않으며, BM25처럼 컬렉션 레벨 통계를 활용하지 않는다. 검색 결과 품질이 쿼리와 무관한 레포의 심볼로 오염된다.

**신호**: 검색 쿼리의 상위 10결과 중 관련 없는 결과 비율이 30% 초과 시.

### 7.2 레포 수 — 쿼리 응답 시간

**임계점**: 레포 약 1,000개 이상 (또는 심볼 인덱스 크기 10 GB 이상)

GIN index는 삽입 비용이 높고, 대용량에서 쿼리 플래너가 seq scan으로 fallback하는 사례가 생긴다. `VACUUM`과 `ANALYZE` 주기를 공격적으로 설정해도 쿼리 지연이 200ms를 초과하기 시작한다.

**신호**: `EXPLAIN ANALYZE`에서 GIN index 적중이 100ms 이상 지속 시.

### 7.3 동시 쓰기 — MinIO 업로드 병목

**임계점**: 동시 CI 업로드 약 50개 이상 (또는 SCIP 파일 평균 크기 100 MB 이상)

MinIO(또는 S3)는 병렬 PUT에서 병목이 없으나, SCIP 파싱 후 PostgreSQL INSERT의 트랜잭션 잠금이 병목이 된다. 특히 `references` 테이블의 대량 INSERT에서 WAL 쓰기 증폭이 발생한다.

**신호**: `pg_stat_activity`에서 `INSERT` 대기 시간이 평균 500ms 이상 시.

### 7.4 AI 컨텍스트 쿼리 — 벡터 검색 부재

**임계점**: v1 스택에는 벡터 검색 기능 자체가 없음

사용자가 자연어로 "이 함수와 비슷한 패턴을 찾아줘" 유형의 쿼리를 요구하면 현재 FTS로는 전혀 대응 불가. 이 요구가 발생하는 순간이 임계점이다.

**신호**: MCP tool에서 semantic search 요청이 들어오는 첫 케이스.

### 7.5 멀티-홉 참조 그래프 — recursive CTE 성능

**임계점**: 참조 깊이 5홉 이상, 참조 레코드 1,000만 개 이상

PostgreSQL recursive CTE로 심볼 의존 그래프를 5홉 이상 순회하면 쿼리 시간이 지수적으로 증가한다. 특히 high-fanout 심볼(널리 사용되는 유틸 함수)에서 CTE가 수초 이상 걸린다.

**신호**: `/references` API의 P99 응답 시간이 2초 초과 시.

### 7.5.1 참고 — PostgreSQL FTS vs Zoekt 성능 비교

Sourcegraph는 전문 검색을 전용 Zoekt 엔진에 위임하는 구조를 오래 유지해왔다. Zoekt 도입 이후 trigram shard 기반 검색이 PostgreSQL FTS 대비 낮은 응답 시간을 제공한다고 알려져 있으나, 수치 비교는 공개된 벤치마크가 없다 [unverified]. CMS가 유사한 확장을 검토할 때 Zoekt의 shard 크기 제약(4 GB/shard)과 디스크 비용(원본의 3–3.5배)을 함께 고려해야 한다.

### 7.6 요약 — 임계점 매트릭스

| 지표 | 현재 안정 범위 | 경고 임계점 | 위험 임계점 |
|------|-------------|-----------|-----------|
| 심볼 레코드 수 | < 50만 | 50만–100만 | > 100만 |
| 레포 수 | < 500 | 500–1,000 | > 1,000 |
| SCIP 파일 동시 업로드 | < 20 | 20–50 | > 50 |
| FTS 쿼리 응답 시간 (P99) | < 100ms | 100–300ms | > 300ms |
| 멀티-홉 CTE 깊이 | ≤ 3홉 | 4–5홉 | > 5홉 |
| AI 시맨틱 쿼리 요건 | 없음 | 검토 단계 | 도입 결정 시 |

---

## 8. 권고 — ADR 후보 시나리오

이 절은 향후 ADR에 입력할 4가지 시나리오를 제시한다. 실제 ADR 작성 시 트레이드오프와 결정 근거를 추가해야 한다.

### 시나리오 A: v1 유지 (PostgreSQL FTS + MinIO)

**조건**: 레포 수 < 500, 심볼 < 50만, AI 컨텍스트 요건 없음

**접근**: 현 스택 유지. PostgreSQL 튜닝(`work_mem`, `effective_cache_size`, GIN index 설정 최적화), MinIO 스토리지 증설로 대응.

**장점**: 운영 복잡도 최소, 팀 내 학습 곡선 없음

**단점**: 시맨틱 검색 불가, FTS 랭킹 품질 한계

**참고 ADR**: ADR-001, ADR-003, ADR-004

---

### 시나리오 B: v2 pgvector 추가 (PostgreSQL 확장)

**조건**: AI 컨텍스트 요건 발생 시 (시맨틱 검색 요구), 레포 수 < 2,000

**접근**: 기존 PostgreSQL 클러스터에 `pgvector` 익스텐션 설치. 심볼 또는 코드 청크 임베딩을 별도 테이블에 저장. HNSW 인덱스 적용.

**장점**: 인프라 추가 없음, 기존 SQL 조인과 결합 가능, 운영 경험 그대로 활용

**단점**: PostgreSQL ANN 성능은 전용 벡터 DB(Turbopuffer, LanceDB) 대비 낮음. 벡터 삽입 시 메인 DB 부하 공유.

**선례**: 많은 스타트업이 초기 벡터 검색을 pgvector로 시작 [unverified — 특정 사례 미확인].

---

### 시나리오 C: v3 전용 검색 엔진 도입 (Zoekt 또는 Elasticsearch)

**조건**: 레포 수 > 1,000이고 FTS 쿼리 P99 > 300ms 지속 시

**접근**: 텍스트 검색을 PostgreSQL FTS에서 Zoekt(오픈소스) 또는 Elasticsearch로 분리. PostgreSQL은 구조적 메타데이터와 관계 저장에만 집중.

**장점**: Sourcegraph가 검증한 아키텍처 (§4.1). FTS 품질·스케일 대폭 개선.

**단점**: 운영 컴포넌트 추가, 데이터 동기화 복잡도 증가, Zoekt shard 디스크 비용.

**선례**: Sourcegraph (Zoekt), Gerrit Code Review (Lucene 기반)

---

### 시나리오 D: v4 그래프 DB 분리

**조건**: 멀티-홉 참조 쿼리 P99 > 2초 지속, 크로스-레포 의존 그래프 분석 요구 시

**접근**: 심볼 참조 관계를 PostgreSQL에서 전용 그래프 DB(Neo4j, Amazon Neptune) 또는 팩트 DB(Glean-style RocksDB)로 분리.

**장점**: 복잡한 의존 관계 순회 성능 획기적 개선, 크로스-언어 분석 용이

**단점**: 운영 복잡도 대폭 증가, 팀 학습 비용 높음, PostgreSQL과의 데이터 일관성 유지 어려움. Meta Glean은 Haskell 스택 필요.

**권고**: 시나리오 C 이후에도 그래프 쿼리 병목이 지속될 때만 검토.

---

### 시나리오 선택 트리

```
레포 수 < 500 AND 심볼 < 50만 AND AI 요건 없음
  → 시나리오 A (현 상태 유지)

AI 컨텍스트 요건 발생 (시맨틱 검색)
  → 시나리오 B (pgvector 추가)

레포 수 > 1,000 OR FTS P99 > 300ms
  → 시나리오 C (전용 검색 엔진)

멀티-홉 쿼리 P99 > 2초 지속
  → 시나리오 D (그래프 DB 분리)
```

---

## 9. 참고 자료

### 해외 공식 문서 및 블로그

1. [GitHub Blog — The technology behind GitHub's new code search (Blackbird)](https://github.blog/engineering/infrastructure/the-technology-behind-githubs-new-code-search/)
2. [Sourcegraph GitHub — Zoekt: fast trigram based code search](https://github.com/sourcegraph/zoekt)
3. [Kythe — Storage Documentation](https://kythe.io/docs/kythe-storage.html)
4. [Meta Engineering Blog — Indexing code at scale with Glean (2024-12-19)](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
5. [Glean — Introduction](https://glean.software/docs/introduction/)
6. [CodeQL docs — About CodeQL](https://codeql.github.com/docs/codeql-overview/about-codeql/)
7. [CodeQL docs — About the QL language](https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/)
8. [CodeQL docs — CodeQL glossary (bqrs file)](https://codeql.github.com/docs/codeql-overview/codeql-glossary/)
9. [GitHub — Why does CodeQL use a relational database instead of a graph database? (Discussion #10385)](https://github.com/github/codeql/discussions/10385)
10. [Cursor — Securely indexing large codebases](https://cursor.com/blog/secure-codebase-indexing)
11. [Towards Data Science — How Cursor Actually Indexes Your Codebase](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/)
12. [Engineer's Codex — How Cursor Indexes Codebases Fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast)
13. [LanceDB Blog — The Future of AI-Native Development is Local: Inside Continue's LanceDB-Powered Evolution](https://lancedb.com/blog/the-future-of-ai-native-development-is-local-inside-continues-lancedb-powered-evolution/)
14. [Continue.dev Blog — Building a Semantic Code History Search with LanceDB](https://blog.continue.dev/building-a-semantic-code-history-search-with-lancedb/)
15. [continuedev/continue GitHub — Codebase Indexing (DeepWiki)](https://deepwiki.com/continuedev/continue/3.4-codebase-indexing)
16. [Sourcegraph Blog — How Cody understands your codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
17. [Sourcegraph Blog — Lessons from building AI coding assistants: context retrieval and evaluation](https://sourcegraph.com/blog/lessons-from-building-ai-coding-assistants-context-retrieval-and-evaluation)
18. [Sourcegraph docs — External Services](https://sourcegraph.com/docs/admin/external_services)
19. [Sourcegraph docs — Scaling Overview for Services](https://sourcegraph.com/docs/admin/deploy/scale)
20. [Sourcegraph docs — Blobstore update notes (v4.2.1+)](https://docs.sourcegraph.com/admin/how-to/blobstore_update_notes)
21. [Sourcegraph docs — PostgreSQL](https://docs.sourcegraph.com/admin/postgres)

### 국내 Tech 블로그 (조사 결과: 코드 인텔리전스 특화 자료 없음)

22. [NAVER D2](https://d2.naver.com) — 코드 인텔리전스 스토리지 관련 공개 자료 미발견
23. [카카오 Tech Blog](https://tech.kakao.com) — 코드 인텔리전스 스토리지 관련 공개 자료 미발견
24. [LINE Engineering Blog](https://engineering.linecorp.com) — 코드 인텔리전스 스토리지 관련 공개 자료 미발견
25. [토스 Tech Blog](https://toss.tech) — 코드 인텔리전스 스토리지 관련 공개 자료 미발견

### 관련 CMS 내부 문서

26. `docs/ADR.md` — ADR-001 (PostgreSQL 채택), ADR-003 (MinIO/S3 채택), ADR-004 (FTS 방식 결정)
27. [Augment Code — Cursor vs Sourcegraph Cody: Embeddings and Monorepo at Scale](https://www.augmentcode.com/tools/cursor-vs-sourcegraph-cody-embeddings-and-monorepo-scale)
28. [ByteByteGo — How Cursor Serves Billions of AI Code Completions Every Day](https://blog.bytebytego.com/p/how-cursor-serves-billions-of-ai)
29. [LanceDB + Continue.dev partnership announcement](https://www.lancedb.com/blog/lancedb-x-continue)
