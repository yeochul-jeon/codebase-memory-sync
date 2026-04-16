#!/usr/bin/env groovy
/**
 * CMS SCIP Indexer — Jenkins shared library step
 *
 * Usage in Jenkinsfile:
 *   @Library('cms-ci-lib') _
 *   cmsIndex()                      // auto-detect language
 *   cmsIndex(tool: 'scip-java')     // explicit tool
 *   cmsIndex(skipOnBranch: 'feature/*')  // skip on feature branches
 *
 * Environment variables expected (set in Jenkins credentials or shared env):
 *   CMS_ENDPOINT   — e.g. https://cms.internal
 *   CMS_CI_TOKEN   — Bearer token with ci upload scope
 */

def call(Map cfg = [:]) {
    def tool        = cfg.tool        ?: detectTool()
    def endpoint    = cfg.endpoint    ?: env.CMS_ENDPOINT ?: 'http://localhost:3000'
    def skipBranch  = cfg.skipOnBranch
    def indexerImg  = cfg.indexerImage ?: "registry.internal/cms/scip-indexer:${tool}-latest"

    // Skip on non-default branches unless explicitly opted in
    if (skipBranch && env.GIT_BRANCH ==~ skipBranch) {
        echo "[CMS] Skipping SCIP index — branch '${env.GIT_BRANCH}' matches skipOnBranch pattern"
        return
    }

    // Only index default/main branches in normal mode (opt-out: skipCmsIndex=true)
    if (env.skipCmsIndex?.toBoolean()) {
        echo "[CMS] Skipping SCIP index — skipCmsIndex=true"
        return
    }

    stage("CMS: SCIP index (${tool})") {
        def org      = env.ORG_NAME  ?: sh(script: 'basename $(dirname $(git remote get-url origin))', returnStdout: true).trim()
        def repoName = env.REPO_NAME ?: sh(script: 'basename $(git remote get-url origin) .git', returnStdout: true).trim()
        def commit   = env.GIT_COMMIT
        def branch   = env.GIT_BRANCH?.replaceAll('^origin/', '')
        def idemKey  = "${org}/${repoName}:${commit}:${tool}:ci"

        // 1. Generate SCIP index
        sh """
            docker run --rm \
              -v "\$PWD:/work" \
              -e JAVA_HOME=/usr/lib/jvm/java-17-openjdk \
              ${indexerImg} /run.sh
        """

        // 2. Upload to CMS
        sh """
            curl -fSs -X POST "${endpoint}/v1/scip/upload" \
              -H "Authorization: Bearer \$CMS_CI_TOKEN" \
              -H "X-CMS-Uploader: ci" \
              -H "X-CMS-Idempotency-Key: ${idemKey}" \
              -F "repo=${org}/${repoName}" \
              -F "commit=${commit}" \
              -F "branch=${branch}" \
              -F "tool=${tool}" \
              -F "scip=@index.scip" \
              -o /tmp/cms-upload.json
            cat /tmp/cms-upload.json
        """
    }
}

/** Detect the primary language/tool from the repo root */
private String detectTool() {
    if (fileExists('pom.xml') || fileExists('build.gradle') || fileExists('build.gradle.kts')) {
        return 'scip-java'
    }
    if (fileExists('package.json') || fileExists('tsconfig.json')) {
        return 'scip-typescript'
    }
    return 'scip-ctags'
}
