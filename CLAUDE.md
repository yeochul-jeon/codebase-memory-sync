# 프로젝트: codebase-memory-sync (CMS)

## 기술 스택

- **언어**: TypeScript 5 (strict mode)
- **런타임**: Node.js (tsx for development, compiled JS for production)
- **패키지 관리**: pnpm workspaces (monorepo)
- **REST API**: Fastify 4 (`packages/core-service`)
- **MCP 서버**: @modelcontextprotocol/sdk stdio transport (`packages/mcp-server`)
- **SCIP 파서**: protobufjs (`packages/scip-processor`)
- **데이터베이스**: PostgreSQL 15 (pg pool)
- **Blob 스토리지**: MinIO / S3 호환 (@aws-sdk/client-s3)
- **유효성 검사**: zod
- **테스트**: vitest
- **로컬 인프라**: Docker Compose (postgres, minio)
- **CI 통합**: Jenkins shared library (Groovy), `packages/ci-lib`

## 아키텍처 규칙

- CRITICAL: 의사결정(기술 선택, 보류 결정, 트레이드오프)은 반드시 `docs/ADR.md`에 기록한다.
- CRITICAL: MCP tool은 읽기 전용만 노출한다. `rename_symbol`, `replace_symbol_body` 등 쓰기 도구는 절대 등록하지 않는다 (ADR-009).
- CRITICAL: SQL은 반드시 parameterized query (`$1`, `$2` ...) 를 사용한다. 문자열 보간(template literal로 SQL 구성)은 금지한다.
- CRITICAL: CI 업로드는 client 인덱스를 무조건 덮어쓴다. client 업로드는 CI 인덱스 존재 시 409를 반환한다 (CI-wins 규칙, ADR-005).
- MCP tool handler는 `...Deps` + `...Args` 인터페이스를 export하고, 순수 함수로 구현한다 (의존성 주입 패턴).
- core-service의 모든 route handler는 `getPool().query<T>(sql, params)` 패턴을 사용한다.
- scip-processor의 materialization은 DELETE + bulk INSERT (full replace) 방식으로 처리한다. 증분 병합은 없다 (ADR-006).
- bulk insert는 500개 청크 단위로 처리한다.
- 테스트 격리: 통합 테스트마다 고유한 `TEST_ORG` 문자열을 사용하고, `afterAll`에서 해당 데이터를 cleanup한다.
- 작업 이력은 `docs/work-log.md`에, 전체 설계는 `docs/architecture-plan.md`에 기록한다.

## 개발 프로세스

- CRITICAL: 새 기능·버그 수정 시 반드시 실패하는 테스트를 먼저 작성한 뒤 구현한다 (TDD: RED → GREEN → VERIFY 사이클).
- CRITICAL: 프로덕션 코드 변경 후에는 반드시 `pnpm typecheck` 를 실행한다.
- 커밋 메시지는 Korean + Conventional Commits 형식을 따른다 (예: `feat: 심볼 참조 조회 API 추가`, `fix: truncated 플래그 누락 수정`).
- 새로운 의사결정이 생기면 `docs/ADR.md`에 다음 순번으로 추가한다.

## 명령어

```bash
# 루트 (전체 패키지)
pnpm test           # 전체 테스트
pnpm typecheck      # 전체 타입 체크
pnpm build          # 전체 빌드
pnpm dev            # 전체 개발 서버 (parallel)

# 패키지별
pnpm --filter @cms/core-service test
pnpm --filter @cms/scip-processor test
pnpm --filter @cms/mcp-server test

# 로컬 인프라
docker compose up -d postgres minio   # DB + 스토리지 기동
docker compose down                   # 종료

# E2E 스크립트
bash scripts/bootstrap.sh             # 초기 환경 설정 (DB + MinIO + pnpm install)
bash scripts/e2e.sh                   # 업로드 → 파싱 → 조회 전체 흐름 검증
```
