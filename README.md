<div align="center">
  <img src="./android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png" width="112" alt="기프티콘 관리 앱 아이콘" />
  <h1>기프티콘 관리</h1>
  <p><strong>기프티콘은 제때 쓰고, 만료일은 앱이 기억합니다.</strong></p>
  <p>이미지와 유효기간을 한곳에 보관하고, 만료 시점에 맞춰 알림을 받을 수 있는 Android 앱입니다.</p>
  <p>
    <a href="#요구-사항"><img src="https://img.shields.io/badge/Android-API%2024%2B-3DDC84?logo=android&amp;logoColor=white" alt="Android API 24+" /></a>
    <a href="https://capacitorjs.com/"><img src="https://img.shields.io/badge/Capacitor-8.4-119EFF?logo=capacitor&amp;logoColor=white" alt="Capacitor 8.4" /></a>
    <a href="./webapp"><img src="https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?logo=javascript&amp;logoColor=111" alt="JavaScript ES Modules" /></a>
    <a href="./package.json"><img src="https://img.shields.io/badge/version-1.0.0-FF7E5F" alt="Version 1.0.0" /></a>
  </p>
</div>

---

## 핵심 기능

| 기능 | 설명 |
| --- | --- |
| 빠른 기프티콘 등록 | 카메라 또는 앨범에서 이미지를 추가하고 상품명, 브랜드, 유효기간, 카테고리, 메모를 함께 저장합니다. |
| 단계별 만료 알림 | 만료일까지 남은 기간에 따라 알림 빈도를 자동으로 높이고, 원하는 시간과 주기를 직접 설정할 수 있습니다. |
| 안정적인 Android 알림 | 알림 권한과 정확 알람 상태를 확인하고, 절전 모드와 기기 재부팅 이후에도 예약을 유지합니다. |
| 임박 항목 집중 관리 | D-day 순으로 정렬하고 3일·7일·30일 이내 만료 항목을 한눈에 확인합니다. |
| 사용 완료 및 보관 | 사용 완료 또는 기간 만료 항목을 보관함에서 분리해 관리하고 필요할 때 다시 활성화합니다. |
| 매장 제시 모드 | 저장한 기프티콘 이미지를 밝은 전용 화면으로 열어 바코드를 바로 제시할 수 있습니다. |

## 사용 흐름

1. 하단의 `+` 버튼으로 기프티콘을 등록합니다.
2. 유효기간과 원하는 알림 시간을 설정합니다.
3. 홈과 만료 임박 화면에서 우선 사용할 기프티콘을 확인합니다.
4. 매장에서 이미지를 제시한 뒤 `사용완료`로 이동합니다.

모든 등록 데이터는 별도 계정이나 백엔드 없이 앱 내부에 저장됩니다.

## 알림 정책

기본값은 만료일이 가까워질수록 알림 빈도가 높아지도록 구성되어 있습니다.

| 기간 | 선택 가능한 주기 | 기본값 |
| --- | --- | --- |
| 1년 전 ~ 3개월 전 | 한 달에 한 번 · 2주에 한 번 · 끄기 | 한 달에 한 번 |
| 3개월 전 ~ 1주 전 | 2주마다 · 주 1회 · 주 2회 | 주 1회 |
| 1주 전 ~ 만료일 | 격일 · 매일 · 하루 2번 | 매일 |

- 선택한 알림 시각을 기준으로 미래 알림을 다시 계산합니다.
- 만료 당일 알림을 포함하며 구간 경계에서 중복 예약하지 않습니다.
- Android 절전 모드에서도 전달될 수 있도록 idle 실행을 허용합니다.
- 설정 화면에서 현재 예약 개수와 권한 상태를 확인하고 테스트 알림을 보낼 수 있습니다.

## 권한 안내

| 권한 | 사용 목적 |
| --- | --- |
| 알림 | Android 13 이상에서 만료 알림을 표시합니다. |
| 정확한 알람 | Android 12 이상에서 설정한 시각에 더 정확하게 알림을 전달합니다. |
| 카메라·사진 | 사용자가 직접 선택한 기프티콘 이미지를 등록합니다. |

정확한 알람 권한이 꺼져 있어도 알림은 예약되지만, 기기 상태에 따라 전달 시각이 늦어질 수 있습니다.

## 기술 구성

- UI: HTML, CSS, JavaScript ES Modules
- Web build: Vite 8
- Native runtime: Capacitor 8
- Android plugins: Camera, Local Notifications
- Storage: WebView Local Storage
- Android 지원 범위: API 24 이상

## 요구 사항

- Node.js와 npm
- Android Studio 또는 Android SDK
- Android 빌드용 JDK

## 시작하기

```bash
git clone https://github.com/BJDG-CM/gift.git
cd gift
npm install
npm run dev
```

개발 서버는 기본적으로 `http://localhost:5173`에서 실행됩니다.

## 테스트 및 Android 빌드

```bash
# 알림 예약 계산 테스트
npm test

# 프로덕션 웹 번들 생성 및 Android 동기화
npm run build
npm run sync

# Android 테스트, Lint, Debug APK 빌드
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Windows에서는 마지막 명령의 `./gradlew` 대신 `gradlew.bat`을 사용할 수 있습니다.

빌드된 APK는 다음 경로에 생성됩니다.

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## 프로젝트 구조

```text
gift/
├─ webapp/
│  ├─ index.html                      # 앱 진입점
│  ├─ main.js                         # 화면, 상태, 네이티브 연동
│  ├─ notification-schedule.mjs       # 알림 예약 계산
│  ├─ notification-schedule.test.mjs  # 예약 로직 테스트
│  └─ style.css                       # 디자인 시스템과 화면 스타일
├─ android/                            # Capacitor Android 프로젝트
├─ capacitor.config.json               # 앱 및 플러그인 설정
├─ package.json                        # 스크립트와 의존성
└─ vite.config.js                      # 웹 빌드 설정
```

## 주요 명령어

| 명령어 | 설명 |
| --- | --- |
| `npm run dev` | Vite 개발 서버 실행 |
| `npm test` | 알림 예약 계산 테스트 실행 |
| `npm run build` | 배포용 웹 자산 생성 |
| `npm run sync` | 웹 자산과 플러그인을 Android 프로젝트에 동기화 |
| `npm run open:android` | Android Studio에서 프로젝트 열기 |

---

<div align="center">
  기프티콘을 잊지 않고 사용하는 가장 간단한 방법
</div>
