# ClaudeRipple 릴리스

배포 경로는 **npm** 하나입니다. 플랫폼별 빌드도, 코드 서명도, 공증도, Windows VM도 필요 없습니다.
게시는 어느 컴퓨터에서든 `npm publish` 한 번입니다.

## 왜 npm인가

- 플랫폼별 산출물이 없습니다. 게시하는 것은 JavaScript 한 벌이고, macOS와 Windows가 같은 파일을 받습니다.
- 서명·공증이 사라집니다. Apple Developer 인증서도, Windows 코드 서명 인증서(연 219~685달러, 하드웨어 토큰)도
  필요 없습니다. SmartScreen 경고도 없습니다.
- 트레이에 필요한 Electron은 npm이 선택적 의존성으로 플랫폼에 맞는 바이너리를 받아 옵니다. 우리가 굽지 않습니다.

대가는 하나입니다. **사용자에게 Node 24가 필요합니다.**

## 게시 절차

1. 버전을 올립니다. 네 곳이 같아야 하고, `packages/router/test/version.test.ts`가 그것을 검사합니다.

   ```sh
   npm version <major|minor|patch> --no-git-tag-version
   npm --workspace @clauderipple/router version <같은 버전> --no-git-tag-version
   npm --workspace @clauderipple/cli version <같은 버전> --no-git-tag-version
   npm --workspace @clauderipple/app version <같은 버전> --no-git-tag-version
   ```

   `packages/router/src/version.ts`의 `VERSION` 상수도 같이 고칩니다.

2. 검사를 돌립니다.

   ```sh
   npm run typecheck && npm test
   ```

3. 꾸러미를 만들어 안을 확인합니다. `prepack`이 `npm run build`를 돌려 `dist/`를 새로 만듭니다.

   ```sh
   npm pack
   tar tzf clauderipple-<버전>.tgz | head -20
   ```

4. 아무 폴더에나 설치해 실제로 도는지 봅니다. **주 설치본과 겹치지 않도록 홈과 포트를 따로 줍니다.**

   ```sh
   npm install --prefix /tmp/cr-check ./clauderipple-<버전>.tgz
   CLAUDERIPPLE_HOME=/tmp/cr-check/home \
   CLAUDE_SETTINGS_PATH=/tmp/cr-check/settings.json \
   CLAUDERIPPLE_LAUNCHD_LABEL=com.clauderipple.check \
     /tmp/cr-check/node_modules/.bin/clauderipple install --port 8890
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8891/
   # 확인이 끝나면
   CLAUDERIPPLE_HOME=/tmp/cr-check/home \
   CLAUDE_SETTINGS_PATH=/tmp/cr-check/settings.json \
   CLAUDERIPPLE_LAUNCHD_LABEL=com.clauderipple.check \
     /tmp/cr-check/node_modules/.bin/clauderipple uninstall --purge
   ```

5. 게시하고 태그를 답니다.

   ```sh
   npm publish
   git tag v<버전> && git push --tags
   ```

## 빌드가 하는 일

`npm run build`(= `scripts/build-npm.mjs`)가 만드는 것은 이것뿐입니다.

```text
dist/cli/src/index.js       CLI, 설치 관리자, 슈퍼바이저
dist/router/src/index.js    라우터
dist/ui/                    대시보드 (라우터가 서빙)
dist/app/dist/main.js       트레이 (옆에 dist/app/assets)
```

소스는 TypeScript이고 개발 중에는 Node가 직접 실행하지만, **`node_modules` 아래의 TypeScript는 Node가
실행하지 않습니다**(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). 그래서 게시본만 JavaScript입니다.
경로 해석은 두 배치를 모두 다룹니다. `packages/cli/src` ↔ `dist/cli/src`처럼 한 단계만 다르고 상대 위치가
같아서, `runtime.ts`가 자기 파일의 확장자로 어느 쪽인지 판별합니다.

## 독립 실행 앱 (선택)

Node를 깔 수 없는 사람을 위해 electron-builder 경로를 남겨 두었습니다. 릴리스마다 요구되지는 않습니다.

```sh
npm run dist      # 서명 없는 .app 디렉터리 (로컬 확인용)
npm run release   # 서명·공증된 macOS DMG/ZIP — Apple Developer 계정 필요
```

Windows 쪽에는 알려진 문제가 있습니다. **arm64 NSIS 설치 관리자가 실행 파일만 빼고 설치하면서 성공했다고
보고합니다.** 2026-09-14 Windows 11 arm64 VM에서 macOS 크로스 빌드와 Windows 네이티브 빌드 양쪽 모두 재현했고,
서명을 꺼도, Defender 예외를 줘도 같았으며, 같은 `win-arm64-unpacked`를 폴더째 복사하면 정상 동작했습니다.
범인은 NSIS 패키징 단계이고 원인은 아직 특정하지 못했습니다. 그래서 그 경로를 쓸 때는 x64는 설치 관리자,
arm64는 zip입니다.

이 문제가 npm 배포에는 해당하지 않습니다.
