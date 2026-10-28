# 플랫폼과 개발·배포

## 프로젝트 범위

- **소재 · Sohjae**: 에디터·렌더러·협업 기반 기술.
- **서재 · Suhjae**: 소재를 활용하는 문서·지식 관리 애플리케이션.

서재의 목표 플랫폼은 웹, Windows, macOS, Linux, iOS, iPadOS, Android입니다. 현재 구현·배포된 것은 웹앱이며, 네이티브 앱은 아직 제공하지 않습니다. Tauri 2 기반 패키징을 검토할 수 있습니다. tvOS는 별도 렌더링·입력 및 배포 가능성을 검토하는 대상으로, 지원 확정 상태가 아닙니다.

## 저장소 구성

앱 원본은 `web/app/`, 포함된 소재 런타임은 `vendor/sohjae/`, Wiki 관리 원본은 `docs/wiki/`에 있습니다. 소재 런타임은 MIT 라이선스를 보존하며 출처 리비전과 파일 해시를 manifest에 기록합니다. 소재의 코어 개발·API 설명은 이 Wiki의 범위 밖입니다.

## 로컬 실행

Python 3와 Node.js 22 이상을 사용하며 패키지 설치는 필요하지 않습니다.

```sh
python3 scripts/build_site.py
python3 -m http.server 8080
```

`http://localhost:8080/site/`에서 배포 구조를 확인합니다. 개발 원본은 `/web/app/`에 있습니다.

```sh
node scripts/check_site.mjs
node scripts/check_workspace.mjs
node scripts/check_browser_sync.mjs
node scripts/check_export_zip.mjs
```

브라우저 통합 검사는 `/web/app/file-import-tests.html`, `/web/app/sync-tests.html`, `/web/app/view-tests.html`입니다.

## GitHub Pages와 Wiki

main 브랜치 푸시는 Actions에서 앱을 패키징하고 검증한 뒤 `site/`를 Pages에 배포합니다. 배포 주소는 https://mson0129.github.io/suhjae/ 입니다. 생성된 `site/`는 Git에 넣지 않으며 빌드 시 재생성합니다.

Wiki 변경은 `docs/wiki/` 원본에 반영한 뒤 별도 `suhjae.wiki.git` 저장소에도 커밋·푸시합니다. 본 저장소의 Pages 워크플로는 Wiki를 자동으로 갱신하지 않습니다.

## 외부 의존성

필요한 외부 라이브러리만 개별 검토해 도입합니다. 라이선스와 전이 의존성도 확인하며, 파생 코드 공개·동일 라이선스 제공 의무가 있는 GPL 계열 의존성은 도입하지 않는 방향입니다. 앱의 의존성 정책은 소재 코어의 더 엄격한 제한과 구분합니다.
