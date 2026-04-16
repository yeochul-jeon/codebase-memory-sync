# cms-ci-lib — Jenkins Shared Library

CMS용 Jenkins shared library. SCIP 인덱싱 + 업로드 스텝을 공통 템플릿으로 제공합니다.

## 설치

Jenkins 관리자 → Manage Jenkins → Configure System → Global Pipeline Libraries:

| 항목 | 값 |
|------|---|
| Name | `cms-ci-lib` |
| Default version | `main` |
| Retrieval method | Modern SCM → Git |
| Repository URL | `https://git.internal/platform/codebase-memory-sync` |
| Credentials | Jenkins 서비스 계정 |

## 사용법

```groovy
@Library('cms-ci-lib') _

pipeline {
    agent any
    environment {
        CMS_ENDPOINT = 'https://cms.internal'
        CMS_CI_TOKEN = credentials('cms-ci-token')
    }
    stages {
        stage('Build') { ... }
        stage('Test')  { ... }
        // SCIP 인덱싱 — 빌드 후 자동 실행
        stage('CMS Index') {
            when { branch pattern: 'main|master|develop', comparator: 'REGEXP' }
            steps {
                cmsIndex()
            }
        }
    }
}
```

### 옵션

```groovy
cmsIndex(
    tool: 'scip-java',            // 강제 지정 (기본: 자동 탐지)
    endpoint: 'https://cms.internal', // CMS_ENDPOINT 오버라이드
    skipOnBranch: 'feature/*',    // 특정 브랜치 패턴에서 스킵
    indexerImage: 'registry.internal/cms/scip-indexer:scip-java-latest',
)
```

### 스킵

특정 파이프라인에서 CMS 인덱싱을 비활성화하려면:

```groovy
environment {
    skipCmsIndex = 'true'
}
```

## 인덱서 이미지 빌드

```bash
# Java/Kotlin/Gradle/Maven
docker build -t registry.internal/cms/scip-indexer:scip-java-latest \
  -f docker/scip-java.Dockerfile .

docker push registry.internal/cms/scip-indexer:scip-java-latest
```

## 환경변수

| 변수 | 설명 |
|------|------|
| `CMS_ENDPOINT` | CMS core service URL |
| `CMS_CI_TOKEN` | CI용 Bearer 토큰 (Jenkins credential로 관리) |
| `ORG_NAME` | GitHub org 이름 (미설정 시 git remote에서 추출) |
| `REPO_NAME` | 저장소 이름 (미설정 시 git remote에서 추출) |
