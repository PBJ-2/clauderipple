# ClaudeRipple macOS 릴리스

이 문서는 서명·공증된 macOS DMG/ZIP을 만드는 절차입니다. 개발용 `npm run dist`는 서명하지 않은 `.app` 디렉터리만 만듭니다.

## 사전 준비

1. Xcode Command Line Tools를 설치합니다.

   ```sh
   xcode-select --install
   ```

2. Apple Developer 계정의 **Developer ID Application** 인증서가 로그인 키체인에 있어야 합니다.

   ```sh
   security find-identity -v -p codesigning
   ```

3. electron-builder가 공증에 쓸 환경변수를 현재 셸에 설정합니다. 값은 저장소나 설정 파일에 기록하지 않습니다.

   ```sh
   export APPLE_ID='developer@example.com'
   export APPLE_APP_SPECIFIC_PASSWORD='app-specific-password'
   export APPLE_TEAM_ID='ABCDE12345'
   ```

   또는 Apple 키체인에 notarytool 자격증명을 미리 저장할 수 있습니다.

   ```sh
   xcrun notarytool store-credentials clauderipple-notary \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_SPECIFIC_PASSWORD"
   ```

## 릴리스 만들기

저장소 루트에서 실행합니다.

```sh
npm run release
```

이 명령은 arm64와 x64 모두에 대해 Developer ID 서명, Apple 공증, stapling을 수행하고, 다음 디렉터리에 DMG와 ZIP을 만듭니다.

```text
packages/app/release/
```

파일명은 `ClaudeRipple-<version>-<arch>.dmg` 및 `ClaudeRipple-<version>-<arch>.zip` 형식입니다.

서명 없이 패키지 구조만 점검하려면 다음을 사용합니다.

```sh
npm run dist
```

## 산출물 검증

아키텍처에 맞는 만든 `.app`과 DMG를 지정해 검증합니다.

```sh
spctl -a -vv packages/app/release/mac-arm64/ClaudeRipple.app
codesign -dv --verbose=2 packages/app/release/mac-arm64/ClaudeRipple.app
xcrun stapler validate packages/app/release/ClaudeRipple-<version>-arm64.dmg
```

`spctl`은 Developer ID와 공증 평가를, `codesign`은 서명 및 hardened runtime을, `stapler`는 DMG에 붙은 공증 티켓을 확인합니다.

## GitHub Releases 게시

검증이 끝난 태그를 만든 뒤 두 아키텍처의 DMG·ZIP을 함께 올립니다.

```sh
gh release create v<version> \
  packages/app/release/ClaudeRipple-<version>-arm64.dmg \
  packages/app/release/ClaudeRipple-<version>-arm64.zip \
  packages/app/release/ClaudeRipple-<version>-x64.dmg \
  packages/app/release/ClaudeRipple-<version>-x64.zip \
  --title "ClaudeRipple v<version>" \
  --generate-notes
```

## Windows

Windows 배포는 아직 구현하지 않았습니다. 남은 작업은 다음과 같습니다.

- OpenSSL에 의존하지 않는 로컬 인증서 생성
- launchd 대신 Task Scheduler 또는 Windows Service로 라우터 상주
- picker 모드 CA 신뢰를 위한 `certutil` 처리
- Claude Desktop Config Library의 `%LOCALAPPDATA%\\Claude-3p\\configLibrary` 경로 지원

따라서 현재 Windows용 설치 관리자나 서명된 바이너리를 배포하지 않습니다.
