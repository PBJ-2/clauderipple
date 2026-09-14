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

`ClaudeRipple-Setup-<version>-<arch>.exe` (NSIS, 사용자 단위 설치, 권한 상승 없음).

### x64 인스톨러는 실기 검증됨, arm64 인스톨러는 고장

x64는 실기(2026-09-14)에서 설치·재설치까지 확인했습니다. 재설치 시 인스톨러가
`build/installer.nsh` → `build/stop-clauderipple.ps1`로 작업 스케줄러를 멈추고
`POST /api/shutdown`으로 라우터를 드레인한 뒤 남은 프로세스를 끝냅니다(그냥 taskkill하면
진행 중인 모델 호출이 끊깁니다). 언인스톨러는 같은 절차 뒤 번들 런타임으로
`picker off`·`uninstall`까지 실행합니다. 이 훅은 macOS 크로스 빌드에서도 컴파일됩니다.

**arm64**에서는 아래 문제가 남아 있습니다.

`electron-builder --win`이 만든 NSIS 인스톨러가 **실행 파일만 빼고 설치합니다.**
중간 산출물(`win-*-unpacked`)에는 122개 파일이 다 있는데, 설치 결과는
**`ClaudeRipple.exe`와 DLL이 빠진 114개**입니다. 설치는 `exit 0`으로 성공했다고
보고하고, 사용자는 "설치됐는데 실행이 안 된다"만 겪습니다.

2026-09-14에 Windows 11 **arm64** VM에서 확인한 것:

- macOS에서 크로스 빌드한 인스톨러 — 재현
- Windows에서 네이티브 빌드한 인스톨러 — **똑같이 재현**
- 코드 서명을 꺼도 동일
- Defender 예외 경로를 줘도 동일 (실시간 보호 자체는 변조 방지로 끄지 못함)
- 같은 `win-arm64-unpacked`를 **폴더째 복사하면 정상 동작**

즉 범인은 NSIS 패키징 단계입니다. **아직 원인을 특정하지 못했습니다.**
electron-builder의 NSIS 스텁은 x86이라 arm64 Windows에서는 에뮬레이션으로 도는데,
x64 인스톨러는 멀쩡하므로 NSIS 스텁의 arm64 에뮬레이션이 남은 가설입니다.

그래서 **x64는 인스톨러, arm64는 zip**이 기본 배포 경로입니다.

### Windows에서 빌드

```powershell
# Node 24 + 저장소 (공유 폴더가 아니라 로컬 디스크에)
npm install
cd packages\app
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder --win
```

함정 둘:

- **아키텍처는 한 번에 하나씩.** x64와 arm64를 동시에 구우면 중간 디렉터리 이름이
  겹쳐 `EPERM ... rename win-unpacked.tmp`로 죽습니다.
- **PowerShell로 `package.json`을 수정하지 마십시오.** `Set-Content -Encoding UTF8`이
  BOM을 붙이고, `@electron/rebuild`가 그 파일을 파싱하지 못해 빌드가 죽습니다.

### 코드 서명

**현재 Windows 빌드는 서명하지 않습니다.** 사용자는 SmartScreen 경고를 보고
"추가 정보 → 실행"을 눌러야 하며, README에 그 사실을 적어 두었습니다.

서명하려면 비용이 듭니다(2026-09 기준):

| 선택지 | 비용 | 비고 |
|---|---|---|
| OV 인증서 | $219~400/년 | **하드웨어 토큰 필수.** 신규 인증서는 평판이 없어 한동안 경고가 계속 뜹니다 |
| EV 인증서 | $280~685/년 | SmartScreen 즉시 신뢰 |
| Azure Artifact Signing | $9.99/월 | 하드웨어 토큰 불필요. **한국에서는 가입 불가**(조직은 미국·캐나다·EU·영국, 개인은 미국·캐나다) |

돈을 쓴다면 OV를 건너뛰고 EV로 가는 것이 맞습니다. OV는 비용을 치르고도 경고가
남습니다.
