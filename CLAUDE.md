# 프로젝트: codebase-memory-sync (CMS)

## 기술 스택

- TypeScript 5 strict · Node.js · pnpm workspaces
- Fastify 4 (core-service) · @modelcontextprotocol/sdk stdio (mcp-server)
- PostgreSQL 15 · MinIO/S3 · protobufjs (SCIP) · zod · vitest

## 아키텍처 규칙

- CRITICAL: 의사결정(기술 선택·보류·트레이드오프)은 `docs/ADR.md`에 기록한다.
- CRITICAL: MCP tool은 읽기 전용만 노출한다. 쓰기 도구(`rename_symbol` 등)는 등록하지 않는다.
- CRITICAL: SQL은 반드시 `$1`, `$2` parameterized query를 사용한다. 문자열 보간 금지.
- CRITICAL: CI 업로드는 client 인덱스를 덮어쓴다. client는 CI 인덱스 존재 시 409를 반환한다.

> 상세 코딩 패턴, 테스트 격리 규칙, 에러 코드 → **[docs/dev-guide.md](./docs/dev-guide.md)**

## 개발 프로세스

- CRITICAL: 테스트를 먼저 작성하고 실패를 확인한 뒤 구현한다 (TDD).
- 코드 변경 후 반드시 `pnpm typecheck` 실행.
- 커밋: Korean + Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`).
- 새 의사결정 → `docs/ADR.md`에 다음 순번으로 추가.

## 명령어

```bash
pnpm test                                  # 전체 테스트
pnpm typecheck                             # 전체 타입 체크
pnpm --filter @cms/core-service test       # 패키지 단위 테스트
docker compose up -d postgres minio        # 로컬 인프라 기동
bash scripts/e2e.sh                        # E2E 전체 검증
```
