# syntax=docker/dockerfile:1
# 接客サーバーと画面を1つのコンテナにする（Cloud Run 用。docs/spec/operations.md の「実行の環境」）。
# 画面のビルドは同じオリジンから配る。Agent SDK は linux-x64（glibc）のネイティブのバイナリを使う。

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 依存の定義だけを先に入れ、ソースの変更でインストールをやり直さない
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/schema/package.json packages/schema/
COPY packages/agent-kit/package.json packages/agent-kit/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# 画面のビルドが読む 3D のモデル（Vite が dist/assets に出す）
COPY assets/3d/models assets/3d/models
# 会話の窓の顔の絵（Vite が dist/assets に出す。旅のしおりと同じ絵）
COPY assets/shiori/staff assets/shiori/staff
# BGM の曲（Vite が dist/assets に出す）
COPY assets/audio/bgm_wadaiko.mp3 assets/audio/bgm_wadaiko.mp3
# 出発の駅の候補の一覧（画面のビルドが dist/assets に出す）
COPY data/stations data/stations
RUN pnpm --filter @matsuri-ikoka/server --filter @matsuri-ikoka/web run build

# 実行に要る依存だけを取り出す。ワークスペースのパッケージは dist にまとめてある
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @matsuri-ikoka/server deploy --prod --legacy /out/server \
 && rm -rf /out/server/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64-musl@* \
 && test -x /out/server/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude

FROM ${NODE_IMAGE} AS runtime
# tini：子のプロセス（Agent SDK のバイナリ）を片付け、シグナルを Node に渡す
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# ファイルは root の持ち物のまま置き、動かすユーザー（node）からは読むだけにする。
# 書き込むのは /tmp だけ（Agent SDK の作業場所と会話の記録も /tmp に作る）
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp \
    TMPDIR=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
# pnpm-workspace.yaml はリポジトリの根の目印（data/ をここから探す）
COPY --from=build /repo/pnpm-workspace.yaml ./
COPY --from=build /out/server/package.json apps/server/package.json
COPY --from=build /out/server/node_modules apps/server/node_modules

# しおりの PDF：サーバーが Playwright を使うときだけ、Chromium の headless shell（画面なしの軽い版）と
# 動作に要るライブラリを入れる。版はサーバーの依存の Playwright に合わせる
RUN cli="$(find apps/server/node_modules/.pnpm -path '*/node_modules/playwright-core/cli.js' -print -quit)"; \
    if [ -n "$cli" ]; then \
      node "$cli" install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/* /tmp/* /tmp/.[!.]*; \
    fi

# しおりの日本語フォント（assets/shiori にあれば）を置き、Chromium から使えるように登録する
RUN --mount=type=bind,target=/context \
    if [ -d /context/assets/shiori ]; then \
      mkdir -p assets /usr/local/share/fonts/shiori \
      && cp -r /context/assets/shiori assets/shiori \
      && find assets/shiori -type f \( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \) \
           -exec cp {} /usr/local/share/fonts/shiori/ \; \
      && if command -v fc-cache >/dev/null; then fc-cache -f; fi; \
    fi

COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY data data

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
