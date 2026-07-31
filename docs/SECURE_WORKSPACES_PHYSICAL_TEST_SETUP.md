# Secure Workspaces: підготовка фізичних тестових платформ

Цей документ призначений для відкриття на Windows, Linux або macOS машині під час підготовки фізичних тестів Secure Workspaces. Він описує внутрішнє тестування кандидата, а не формальну сертифікацію релізу.

## 1. Що саме перевіряємо

Є три різні рівні перевірки:

1. Звичайний CI перевіряє build, unit/integration tests, iOS Simulator та Android Emulator. Він не використовує фізичні пристрої.
2. Manual physical smoke запускається тільки через `.github/workflows/secure-workspace-physical-tests.yml`, тільки вручну і тільки після approval захищеного environment.
3. Інтерактивний apply test, який ще треба завершити, залишатиме OpenChamber відкритим для ручного проходження `Review changes` → `Check changes` → `Apply changes`, а потім незалежно перевірятиме результат у disposable host project.

Manual physical workflow не викликається з `release.yml` і не блокує звичайний реліз. Passing smoke можна буде окремим рішенням підвищити до release evidence пізніше.

Поточний Maestro flow на Android/iOS автоматично створює зміну, перевіряє export dry-run, відкидає export і видаляє workspace. Він ще не доводить реальний apply назад на host.

## 2. Загальні правила безпеки

- Не надсилати в чат Windows/macOS password, Apple ID password, passkey secret, GitHub runner registration token, signing key або pairing URL.
- Використовувати окремі тестові облікові записи та disposable directories.
- Не запускати self-hosted runners для довільного `pull_request` коду.
- Обмежити runner цим repository та protected environment.
- Єдиний дозволений operator workflow зараз: GitHub actor `yulia-ivashko`.
- Кожен mobile run використовує свіжий одноразовий `MOBILE_E2E_CONNECT_URL`; iOS та Android не можуть ділити один URL.
- Не використовувати `latest` images. Runtime і gateway задаються exact digest-посиланнями.
- Logs і artifacts не повинні містити pairing URL, bearer tokens, device serial/UDID, hostname, username чи персональні project paths.
- Cleanup є обов'язковим. Неповний cleanup означає failed test.

## 3. GitHub setup

Repository або organization administrator має:

1. Зареєструвати потрібні self-hosted runners.
2. Обмежити runners цим repository.
3. Створити environments:
   - `desktop-windows`
   - `desktop-linux`
   - `mobile-android`
   - `mobile-ios`
4. Додати `yulia-ivashko` як єдиного required reviewer.
5. Не дозволяти environment secrets до approval.

Repository variables:

- `SECURE_WORKSPACE_RUNTIME_IMAGE`: `ghcr.io/openchamber/opencode-workspace@sha256:<64 hex>`
- `SECURE_WORKSPACE_GATEWAY_IMAGE`: `ghcr.io/openchamber/workspace-egress-gateway@sha256:<64 hex>`

Environment secrets:

| Environment | Значення |
| --- | --- |
| `desktop-windows` | `PHYSICAL_DESKTOP_SMOKE_PASSWORD`; опційно `WINDOWS_SIGNING_CERT_THUMBPRINT` для signed candidate |
| `desktop-linux` | `PHYSICAL_DESKTOP_SMOKE_PASSWORD` |
| `mobile-android` | свіжий `MOBILE_E2E_CONNECT_URL`; опційно `ANDROID_SIGNING_CERT_SHA256` для release-signed APK |
| `mobile-ios` | окремий свіжий `MOBILE_E2E_CONNECT_URL` |

`PHYSICAL_DESKTOP_SMOKE_PASSWORD` є випадковим test-only step-up password. Це не особистий пароль.

## 4. Як зареєструвати runner

GitHub показує одноразові команди в `Repository Settings` → `Actions` → `Runners` → `New self-hosted runner`.

Виконати команди локально на цільовій машині, але не копіювати registration token у цей файл, issue, commit або чат.

Custom labels:

| Host | Label |
| --- | --- |
| Windows mini PC | `desktop-windows` |
| Linux desktop | `desktop-linux` |
| Mac із підключеним iPhone | `mobile-ios` |
| Host із підключеним Android | `mobile-android` |

GUI runners запускаються інтерактивно у залогіненій desktop session. Windows runner запускається через `run.cmd`, не як Session 0 service. Linux runner потребує активний `DISPLAY`/Wayland session.

Зупинка `run.cmd`/`run.sh` або видалення runner у GitHub негайно відкликає доступ workflow до машини.

## 5. Windows mini PC

Відома машина:

- manufacturer/model: `AZW MINI S`
- OS: Windows 10 Home
- architecture: `AMD64`
- Docker поки не встановлений

Це x64 mini PC, а не Raspberry Pi. Windows 10 можна використати для внутрішнього functional test, але у 2026 році результат не слід називати production platform certification. Windows 11 рекомендований, якщо hardware його підтримує.

### 5.1 Діагностика

Запустити у PowerShell:

```powershell
Get-ComputerInfo | Select-Object `
  WindowsProductName,
  WindowsVersion,
  OsBuildNumber,
  OsArchitecture,
  CsProcessors,
  CsTotalPhysicalMemory

Get-CimInstance Win32_Processor | Select-Object `
  Name,
  VirtualizationFirmwareEnabled,
  SecondLevelAddressTranslationExtensions

Get-Tpm | Select-Object TpmPresent, TpmReady, ManufacturerVersion
Confirm-SecureBootUEFI
wsl --status
Get-Volume -DriveLetter C | Select-Object Size, SizeRemaining
```

Необхідно мати virtualization/SLAT, стабільну мережу та приблизно 40–60 GB вільного місця. 16 GB RAM рекомендовано для OpenChamber + Docker + `kind`; 8 GB є мінімальним і може бути нестабільним.

### 5.2 Одноразова підготовка

Дії, які вимагають локального Administrator/UAC:

1. Увімкнути virtualization у BIOS/UEFI, якщо вона вимкнена.
2. Встановити WSL2:

   ```powershell
   wsl --install
   ```

3. Перезавантажити Windows.
4. Встановити Docker Desktop x86-64.
5. Увімкнути WSL2 engine та Linux containers.
6. Один раз прийняти Docker Desktop license/start prompt.

Перевірка:

```powershell
docker version
docker info
docker run --rm hello-world
```

Створити окремого локального Windows user для тестів. Не використовувати особистий OpenChamber profile. На dedicated runner не повинно бути іншої встановленої або запущеної копії OpenChamber під час job.

### 5.3 Docker та Kubernetes

Docker provider використовує Docker Desktop Linux containers.

Для Kubernetes provider рекомендований disposable `kind` cluster поверх Docker Desktop, а не постійний Docker Desktop Kubernetes. Майбутній bootstrap має:

1. Встановити checksum-pinned `kubectl` і `kind`.
2. Створити окремий cluster для test run.
3. Перевірити NetworkPolicy/CNI prerequisites.
4. Створити test namespace та provider policy.
5. Запустити workspace lifecycle/export/apply tests.
6. Видалити cluster у `finally`/`always` cleanup.

Якщо машина має лише 8 GB RAM, спочатку тестувати Docker provider на Windows, а Kubernetes перенести на Linux host.

## 6. Linux desktop

Потрібно:

- x64 або ARM64 Linux, що відповідає AppImage artifact;
- dedicated test user;
- Docker Engine/Desktop, доступний runner user;
- FUSE/libfuse2 для direct AppImage launch;
- активна graphical session;
- достатньо RAM/disk для disposable `kind`;
- runner label `desktop-linux`.

Базова перевірка:

```bash
uname -a
uname -m
docker version
docker info
printf '%s\n' "$DISPLAY"
```

Manual workflow перевіряє AppImage проти update manifest із того самого Actions artifact, запускає exact AppImage, використовує ізольовані OpenChamber/Chromium/OpenCode profiles, створює Docker workspace session і вимагає повний provider cleanup.

## 7. Android

Android phone не є runner. Потрібен Mac/Linux/Windows host із runner label `mobile-android`.

На телефоні:

1. Увімкнути Developer options.
2. Увімкнути USB debugging.
3. Підключити телефон до dedicated host.
4. Підтвердити ADB fingerprint тільки цього host.

На host:

- Java 21
- Android platform tools (`adb`, `apksigner`)
- Maestro
- рівно один authorized physical Android device

Перевірка:

```bash
adb devices
maestro --version
```

Manual workflow завантажує APK тільки з указаного same-repository Actions run, перевіряє APK signature validity, exact version/build, відкриває pairing URL без його логування та запускає Maestro dry-run/cleanup flow. Якщо заданий `ANDROID_SIGNING_CERT_SHA256`, certificate identity також має точно збігатися.

## 8. iPhone/TestFlight

iPhone не є runner. Потрібен Mac із runner label `mobile-ios`.

Mac потребує:

- підтримуваний Xcode із `xcrun devicectl`
- Maestro
- один trusted/unlocked iPhone або iPad
- English app/device locale для детермінованих accessibility selectors

Перед approval:

1. Дочекатися processing exact TestFlight build.
2. Встановити exact version/build на iPhone.
3. Підключити iPhone до Mac і unlock.
4. Створити свіжий unredeemed `MOBILE_E2E_CONNECT_URL` у `mobile-ios` environment.
5. Approve job.

App Store Connect має використовувати окрему test group тільки з Yulia; automatic distribution до інших tester groups для цього кандидата вимкнена.

Не передавати workflow Apple ID password, TestFlight password або passkey secret. Passkey automation готується локально на пристрої.

## 9. macOS desktop та Apple Container

macOS desktop provider tests слід відділяти від iPhone runner, навіть якщо використовується один Mac.

- Docker provider: явно вибраний Docker Desktop або Colima.
- Kubernetes provider: disposable `kind`.
- Apple Container provider: підтримувані macOS/hardware та Apple Container CLI.

Apple Container managed egress зараз залишається fail-closed blocker: наявний CLI не надає isolation-capable multi-network primitive, необхідний для gateway-only egress без direct outbound. Не позначати цей gate як passed.

## 10. Запуск manual physical workflow

Workflow: `Secure Workspace Physical Tests`.

Обов'язкові inputs:

- `candidate_sha`: exact 40-character commit SHA
- `version`: exact candidate version
- platform boolean

Для Android/Windows/Linux також потрібен `source_run_id` same-repository Actions run. Для Android/iOS потрібен exact `mobile_build_number`. Artifact name можна задати явно; defaults відповідають release artifacts.

Workflow відхиляє не-Yulia actor, abbreviated SHA, відсутні platforms, нечислові run/build IDs і невідповідність checkout SHA.

## 11. Інтерактивний apply test: наступна реалізація

Поточний automated smoke не замінює цей сценарій. Наступна сесія має реалізувати bounded interactive harness:

1. Створити disposable host project із known baseline hash.
2. Запустити OpenChamber в isolated profile.
3. Підготувати Docker або `kind` workspace.
4. Відкрити app на 45–60 хвилин для Yulia.
5. Усередині routed workspace виконати deterministic shell change без model credentials, наприклад створити `openchamber-physical-e2e.txt` з exact content.
6. До apply підтвердити, що host project не змінився.
7. Yulia вручну проходить `Review changes`, file/hunk selection, `Check changes`, `Apply changes`.
8. Harness перевіряє exact host file content і відсутність сторонніх змін.
9. Harness видаляє workspace, export artifact, Docker resources/cluster, app profile і disposable project навіть після failure/timeout.
10. Uploaded result чітко називається manual functional test, не release certification.

## 12. Що зберігати після тесту

Дозволено:

- commit SHA
- candidate version/build
- artifact SHA-256
- platform і architecture
- JUnit status
- sanitized screenshots/debug logs
- cleanup status

Заборонено:

- tokens і pairing secrets
- passwords/passkeys
- signing private keys
- device serial/UDID
- usernames/hostnames
- персональні project paths або source contents

## 13. Відновлення після failure

1. Зупинити runner.
2. Закрити OpenChamber.
3. Перевірити Docker containers, networks і volumes з OpenChamber managed labels.
4. Не видаляти ресурси за евристикою, якщо ownership не підтверджений.
5. Запустити provider reconciliation/cleanup із authoritative workspace identity.
6. Видалити disposable `kind` cluster.
7. Rotate/revoke невикористаний pairing session.
8. Не повторювати той самий one-time pairing URL.
9. Зберегти sanitized logs і відкрити issue з exact commit/artifact identity.
