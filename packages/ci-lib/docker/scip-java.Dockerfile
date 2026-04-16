# CMS SCIP Indexer — Java/Kotlin/Gradle/Maven
# Based on the official scip-java binary + JDK 17
FROM eclipse-temurin:17-jdk-jammy AS base

ARG SCIP_JAVA_VERSION=0.9.6
ARG SCIP_CTAGS_VERSION=5.3.2

# Install scip-java
RUN curl -fsSL \
    "https://github.com/sourcegraph/scip-java/releases/download/v${SCIP_JAVA_VERSION}/scip-java-linux-amd64" \
    -o /usr/local/bin/scip-java && \
    chmod +x /usr/local/bin/scip-java

# Install scip-ctags (fallback)
RUN curl -fsSL \
    "https://github.com/sourcegraph/scip-ctags/releases/download/v${SCIP_CTAGS_VERSION}/scip-ctags-linux-amd64" \
    -o /usr/local/bin/scip-ctags && \
    chmod +x /usr/local/bin/scip-ctags

# Install Maven + Gradle wrappers
RUN apt-get update && apt-get install -y --no-install-recommends \
    maven \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY jenkins/resources/run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /work
ENTRYPOINT ["/run.sh"]
