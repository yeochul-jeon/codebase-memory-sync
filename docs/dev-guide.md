# 개발 가이드 — codebase-memory-sync

상세 코딩 규칙, 패턴, 테스트 컨벤션을 정의한다.  
최종 결정 사항은 [ADR.md](./ADR.md)를, 작업 이력은 [work-log.md](./work-log.md)를 참조.

---

## 아키텍처 패턴

### MCP Tool Handler

모든 MCP tool handler는 의존성 주입 패턴을 따른다.

```typescript
// 반드시 이 구조를 준수할 것
export interface GetFooDeps {
  getFoo(id: string, params?: FooQueryParams): Promise<FooResult | null>;
}

export interface GetFooArgs {
  scip_symbol: string;
  repo?: string;
  limit?: number;
}

export async function handleGetFoo(
  deps: GetFooDeps,
  args: GetFooArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  // ...
}
```

- `...Deps` 인터페이스: 외부 I/O 의존성만 포함 (CmsClient 직접 import 금지)
- `...Args` 인터페이스: MCP schema와 1:1 대응
- handler는 순수 함수처럼 작성 (같은 deps+args → 같은 결과)

### core-service Route Handler

```typescript
// getPool().query<T>() 패턴 사용
import { getPool } from "../storage/postgres.js";

const { rows } = await getPool().query<RowType>(
  `SELECT ... FROM symbols WHERE scip_symbol = $1`,
  [scipSymbol]
);
```

- 파라미터는 반드시 `$1`, `$2` ... 바인딩 변수 사용
- 문자열 보간으로 SQL 구성 금지 (injection 위험)
- `buildApp(routePlugin)` 팩토리로 통합 테스트 앱 생성

### 비동기 처리 (scip-processor)

```
upload.ts → pg_notify('cms_index_ready', indexId)
               ↓
worker.ts → LISTEN → parseScip() → materialize()
```

- materialization은 항상 **DELETE + bulk INSERT (full replace)** 로 처리
- 동일 index_id 재처리 시 멱등성 자동 보장
- bulk insert 청크 크기: **500행**

---

## SQL 규칙

### Parameterized Query

```typescript
// ✅ 올바른 방식
await pool.query(`SELECT * FROM symbols WHERE repo_id = $1`, [repoId]);

// ❌ 금지
await pool.query(`SELECT * FROM symbols WHERE repo_id = '${repoId}'`);
```

### JOIN 패턴 (ready 인덱스 필터링)

```sql
-- 항상 status='ready' 인덱스만 조회
JOIN indexes i ON i.id = s.index_id AND i.status = 'ready'
JOIN repos r ON r.id = i.repo_id
```

### Recursive CTE (impact analysis)

cycle detection은 `path` 배열로 처리:

```sql
WITH RECURSIVE impact(symbol, depth, path) AS (
  SELECT ..., ARRAY[from_symbol]
  UNION ALL
  SELECT ..., imp.path || from_symbol
  WHERE imp.depth < $2
    AND NOT (from_symbol = ANY(imp.path))
)
```

---

## 테스트 규칙

### 격리 원칙

- 통합 테스트마다 **고유한 `TEST_ORG` 문자열** 사용 (다른 테스트와 충돌 방지)
- `beforeAll`에서 데이터 시드, `afterAll`에서 반드시 cleanup

```typescript
const TEST_ORG = "test-my-feature"; // 테스트 파일마다 고유하게

afterAll(async () => {
  await pool.query(
    "DELETE FROM repos WHERE org = $1 AND name = $2",
    [TEST_ORG, "test-repo"]
  );
});
```

### DB 미기동 시 Skip 패턴

```typescript
let available = false;

beforeAll(async () => {
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  }
});

it("...", async () => {
  if (!available) { console.warn("Skipping — DB not reachable"); return; }
  // ...
});
```

### MCP 통합 테스트 Skip 패턴

```typescript
// core-service healthz 체크 기반 skip
const res = await fetch(`${CMS_ENDPOINT}/healthz`, { signal: AbortSignal.timeout(2000) });
if (!res.ok) return; // skip gracefully
```

### 단위 테스트 (handler)

MCP handler 단위 테스트는 `...Deps`를 mock 객체로 주입:

```typescript
const mockDeps: GetFooDeps = {
  getFoo: vi.fn().mockResolvedValue({ total: 1, items: [...] }),
};
const result = await handleGetFoo(mockDeps, { scip_symbol: "..." });
expect(result.content[0]?.text).toContain("...");
```

---

## 에러 응답 규칙 (core-service)

| HTTP | 코드 | 조건 |
|------|------|------|
| 400 | `missing_<param>` | 필수 파라미터 누락 |
| 400 | `invalid_<param>` | 파라미터 형식/범위 오류 |
| 404 | `symbol_not_found` | 결과 0건 |
| 404 | `repo_not_found` | repo 미등록 |
| 404 | `index_not_found` | 해당 commit 인덱스 없음 |
| 409 | `ci_wins` | CI 인덱스 존재 시 client 업로드 거부 |

---

## 문서 관리

| 문서 | 용도 |
|------|------|
| `CLAUDE.md` | Claude Code 지침 (최소한) |
| `docs/ADR.md` | 의사결정 기록 — 새 결정은 순번으로 추가 |
| `docs/dev-guide.md` | 이 문서 — 코딩 패턴, 테스트 규칙 |
| `docs/work-log.md` | 구현 단계별 작업 이력 |
| `docs/architecture-plan.md` | 전체 설계, 기각된 옵션, 마일스톤 |
