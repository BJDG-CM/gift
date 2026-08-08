# gift

기프티콘의 이미지와 유효기간을 저장하고, 만료 전에 알림을 받을 수 있는 Android 앱입니다.

## 개발

```bash
npm install
npm run dev
```

## Android 빌드

```bash
npm run build
npm run sync
cd android
./gradlew assembleDebug
```

예약 계산 테스트는 `npm test`로 실행할 수 있습니다.
