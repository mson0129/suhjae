# 서재 · Suhjae

소재([Sohjae](https://github.com/mson0129/sohjae)) 에디터를 사용하는 Markdown 작업 공간입니다.

- [웹앱 실행](https://mson0129.github.io/suhjae/)
- [앱 사용 안내 · Wiki](https://github.com/mson0129/suhjae/wiki)

문서와 폴더 정리, 제목·본문 검색, 네 가지 편집/읽기 화면, 다크모드와 읽기 테마, Markdown 가져오기·다운로드, 전체 ZIP 내보내기, 인쇄, 오프라인 사용, 같은 브라우저의 탭 간 자동 동기화를 제공합니다. 문서는 브라우저에 저장되며 클라우드 백업이나 기기 간 동기화는 제공하지 않습니다.

## 로컬 실행과 검증

Python 3와 Node.js 22 이상을 사용합니다. 별도 패키지 설치는 필요하지 않습니다.

```sh
python3 scripts/build_site.py
python3 -m http.server 8080
```

실제 배포 구조는 `http://localhost:8080/site/`, 개발 원본은 `http://localhost:8080/web/app/`에서 확인합니다.

```sh
node scripts/check_site.mjs
node scripts/check_workspace.mjs
node scripts/check_browser_sync.mjs
node scripts/check_export_zip.mjs
```

브라우저 통합 검사는 `/web/app/file-import-tests.html`, `/web/app/sync-tests.html`, `/web/app/view-tests.html`에서 실행합니다.

## 구성

- `web/app/`: 서재 앱의 화면·문서함·저장·검색·오프라인 기능
- `vendor/sohjae/`: 수정하지 않은 MIT 소재 SDK와 WASM 및 출처·해시 manifest
- `scripts/build_site.py`: 앱과 포함 SDK를 `site/`에 패키징하고 오프라인 manifest 생성
- `docs/wiki/`: 앱 전용 GitHub Wiki의 관리 원본
- `.github/workflows/pages.yml`: main 푸시 시 검증 후 GitHub Pages 배포

소재의 Rust 코어와 SDK 개발 문서는 소재 프로젝트에서 관리합니다. 서재는 웹·Windows·macOS·Linux·iOS·iPadOS·Android를 목표로 하며, 현재 이 저장소에서 제공하는 실행 버전은 웹앱입니다. tvOS는 별도 렌더링·입력 방식 검토 대상입니다.

외부 라이브러리는 필요한 경우에만 라이선스와 전이 의존성을 검토해 도입합니다. 파생 코드 공개 및 동일 라이선스 제공 의무가 있는 GPL 계열 의존성은 도입하지 않는 방향입니다.

MIT License. 포함된 소재의 라이선스는 `vendor/sohjae/LICENSE`에 보존합니다.
